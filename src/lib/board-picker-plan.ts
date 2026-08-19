/**
 * The board-picker's recorded plan (anton-it5i): what one pass decided, and the anton.db row that
 * holds the latest decision per project.
 *
 * The pass ranks the claimable set into a queue and leaves everything else out for a stated reason.
 * Three surfaces need that answer — the Up Next lane, the decision log, and the arming step that
 * actually starts a target — and each of them could recompute it from the board. Three
 * re-derivations of a ranking over a board that moves between them is three answers that can
 * disagree, so the pass records ONE and they read it. That is the whole point of this module.
 *
 * Machine-local, like the policy it derives from: nothing here is shared between machines, and bd's
 * claim protocol — not this record — is what stops two machines starting the same target.
 *
 * Reading the record costs no `bd` call by construction: every field a surface needs is on the row,
 * and the only runtime dependency here is anton.db. `Bead` is a type-only import.
 *
 * db-injectable (like run-health) so the pass and its tests share one connection; the UI read path
 * goes through the shared anton.db.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { Bead } from "./beads/types";
import type { AntonDb, Clock } from "./jobs/queue";

/**
 * Why a candidate is not in the plan. Machine-readable rather than prose because the policy editor
 * answers "why not this one?" per bead (R2.6) and the lane groups the rest — both of which a
 * free-text sentence would force them to parse.
 *
 *   • `not-a-run-target` — not a feature, a parentless task/bug, or a childless epic, so nothing
 *     about it is a thing anton runs (`beads.isRunTarget`).
 *   • `not-open`         — closed, deferred, or already in flight.
 *   • `claimed`          — carries an assignee. A target a human took is never taken back.
 *   • `blocked`          — an unmet blocker on the `blocks` graph.
 *   • `approval-gap`     — fails one of the approve gate's four promises (`approval-gate.ts`).
 *   • `policy`           — structurally claimable, but the standing policy does not admit it.
 */
export type PickerExclusionReason =
  | "not-a-run-target"
  | "not-open"
  | "claimed"
  | "blocked"
  | "approval-gap"
  | "policy";

/** One target in the plan, at the position the ranking gave it. */
export interface PickerPlanEntry {
  beadId: string;
  /**
   * 1-based position in the ranked plan. Stored rather than left implicit in array order, so an
   * entry quoted on its own — a bead note, a provenance badge — still carries where it stood.
   */
  rank: number;
  /** The policy rule that admitted this target: what `◈ policy` links to, and what a `Never` veto
   *  opens the editor at. */
  rule: string;
}

/** One candidate the pass left out, and what excluded it. */
export interface PickerExclusion {
  beadId: string;
  reason: PickerExclusionReason;
  /** The specifics behind the reason — which blocker, which criterion, who holds the claim. */
  detail?: string;
}

/**
 * The board snapshot a plan was computed from, carried on the record so staleness is detectable
 * rather than assumed from the clock.
 */
export interface BoardStamp {
  /**
   * When the pass read the board (epoch ms), in the gardener's `observedAtMs` sense: the moment a
   * change to a bead counts as having happened "since we looked".
   */
  observedAtMs: number;
  /** {@link stampBoard}'s digest over the snapshot. Two boards agree iff their digests do. */
  digest: string;
  /** How many beads the digest covers. */
  beadCount: number;
}

export interface BoardPickerPlan {
  projectId: string;
  /** The picker job that produced it; absent for a plan written outside the job (tests). */
  jobId?: string;
  /** Unix seconds, matching every other timestamp this app hands the UI. */
  generatedAt: number;
  stamp: BoardStamp;
  /** The ranked queue, in rank order. Empty means "the pass ran and found nothing to start". */
  entries: PickerPlanEntry[];
  exclusions: PickerExclusion[];
}

/** Long enough that a collision is not a practical concern; short enough to read in a log line. */
const DIGEST_LENGTH = 16;

/**
 * The projection of a bead the digest covers: exactly the fields eligibility and the PRIME ranking
 * read, and nothing else.
 *
 * Deliberately NOT the bead's `updated_at` stamp. A digest over "was this bead written at all"
 * would mark every plan stale the moment somebody fixed a typo in a description, on a board where
 * the pass reruns every ten minutes anyway — so "the board moved" would stop meaning anything. What
 * the fence must catch is a move that could change the ANSWER, which is a change to one of these.
 *
 * Age is the one ranking input absent here, and necessarily: it is a function of wall-clock time,
 * so it changes every second and no digest can hold it. Age drift is handled by the pass's cadence,
 * not by the fence.
 */
function digestLine(bead: Bead): string {
  const labels = [...(bead.labels ?? [])].sort().join(",");
  const deps = (bead.dependencies ?? [])
    .map((d) => `${d.type}:${d.issue_id}>${d.depends_on_id}`)
    .sort()
    .join(",");
  return [
    bead.id,
    bead.status,
    bead.issue_type ?? "",
    bead.priority ?? "",
    bead.assignee ?? "",
    bead.parent ?? bead.parent_id ?? "",
    bead.created_at ?? "",
    labels,
    deps,
  ].join("\t");
}

/**
 * Stamp a board snapshot. Order-independent — the lines are sorted before hashing — because two
 * reads of an unchanged board may return the beads in any order, and a stamp that disagreed with
 * itself over that would report every plan stale.
 */
export function stampBoard(board: Bead[], observedAtMs: number): BoardStamp {
  const hash = createHash("sha256");
  for (const line of board.map(digestLine).sort()) hash.update(`${line}\n`);
  return {
    observedAtMs,
    digest: hash.digest("hex").slice(0, DIGEST_LENGTH),
    beadCount: board.length,
  };
}

/**
 * Is the recorded plan still about the board as it now reads?
 *
 * Compares the snapshot, never the age: a plan computed an hour ago against a board nobody has
 * touched is still the current answer, and a plan computed a second ago against a board that has
 * since moved is not. The lane must show the second one as stale rather than present a ranking of
 * beads whose state it no longer describes.
 */
export function isPlanStale(plan: BoardPickerPlan, current: BoardStamp): boolean {
  return plan.stamp.digest !== current.digest;
}

/**
 * Deterministic ordering for the exclusions: by bead id, then reason. Unlike the entries — whose
 * order IS the ranking's output and is preserved verbatim — exclusions have no inherent order, and
 * two passes over unchanged state must serialize byte-identically for the record to be idempotent
 * rather than merely recomputed.
 */
export function sortExclusions(exclusions: PickerExclusion[]): PickerExclusion[] {
  return [...exclusions].sort(
    (a, b) => a.beadId.localeCompare(b.beadId) || a.reason.localeCompare(b.reason),
  );
}

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

function toEpoch(value: unknown): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  return Number(value ?? 0);
}

/**
 * Write the project's plan, replacing the previous one. One row per project by construction, so
 * this is an upsert rather than an append — a pass that admits nothing stores an empty plan, which
 * is the signal "decided, nothing to start" and NOT "never ran".
 */
export async function saveBoardPickerPlan(
  db: AntonDb,
  clock: Clock,
  input: {
    projectId: string;
    jobId?: string;
    stamp: BoardStamp;
    entries: PickerPlanEntry[];
    exclusions: PickerExclusion[];
  },
): Promise<void> {
  // Rank order, not array order: the ranking owns the sequence, and normalizing to the rank it
  // assigned means a caller that built the list some other way still records the queue it decided.
  const entries = [...input.entries].sort((a, b) => a.rank - b.rank);
  const exclusions = sortExclusions(input.exclusions);
  const row = {
    projectId: input.projectId,
    jobId: input.jobId ?? null,
    generatedAt: secDate(clock.now()),
    boardDigest: input.stamp.digest,
    boardObservedAtMs: input.stamp.observedAtMs,
    boardBeadCount: input.stamp.beadCount,
    entriesJson: JSON.stringify(entries),
    exclusionsJson: JSON.stringify(exclusions),
    targetCount: entries.length,
  };
  await db
    .insert(schema.boardPickerPlans)
    .values(row)
    .onConflictDoUpdate({ target: schema.boardPickerPlans.projectId, set: row });
}

/** A corrupt blob degrades to "nothing recorded" rather than crashing the lane — `targetCount` on
 *  the row still shows the pass saw something, so the discrepancy is visible instead of silent. */
function parseList<T>(json: string): T[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** The project's latest plan, or undefined when the picker has never run for it. db-injectable. */
export async function getBoardPickerPlan(
  db: AntonDb,
  projectId: string,
): Promise<BoardPickerPlan | undefined> {
  const rows = await db
    .select()
    .from(schema.boardPickerPlans)
    .where(eq(schema.boardPickerPlans.projectId, projectId))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return {
    projectId: row.projectId,
    jobId: row.jobId ?? undefined,
    generatedAt: toEpoch(row.generatedAt),
    stamp: {
      observedAtMs: row.boardObservedAtMs,
      digest: row.boardDigest,
      beadCount: row.boardBeadCount,
    },
    entries: parseList<PickerPlanEntry>(row.entriesJson),
    exclusions: parseList<PickerExclusion>(row.exclusionsJson),
  };
}

/** UI read path over the shared anton.db. */
export function latestBoardPickerPlan(projectId: string): Promise<BoardPickerPlan | undefined> {
  return getBoardPickerPlan(getDb(), projectId);
}
