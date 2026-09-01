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
 * and the only runtime dependency here is anton.db and the contract reader the stamp judges through
 * (`beads/contract.ts`, itself pure and spawn-free). `Bead` is a type-only import.
 *
 * db-injectable (like run-health) so the pass and its tests share one connection; the UI read path
 * goes through the shared anton.db.
 */
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { contractStatusOf } from "./beads/contract";
import type { Bead } from "./beads/types";
import { policyDigest } from "./policy/digest";
import type { Policy } from "./policy/types";
import type { AntonDb, Clock } from "./jobs/queue";

/**
 * Why a candidate is not in the plan. Machine-readable rather than prose because the policy editor
 * answers "why not this one?" per bead (R2.6) and the lane groups the rest — both of which a
 * free-text sentence would force them to parse.
 *
 *   • `not-a-run-target` — not a feature, a parentless task/bug, or a childless epic, so nothing
 *     about it is a thing anton runs (`beads.isRunTarget`).
 *   • `not-open`         — closed, deferred, or already in flight.
 *   • `abandoned`        — a won't-do. Usually closed with it, but a crashed cascade can leave the
 *                          label on an OPEN bead, which nothing may pick up.
 *   • `claimed`          — carries an assignee. A target a human took is never taken back.
 *   • `blocked`          — an unmet blocker on the `blocks` graph.
 *   • `approval-gap`     — fails one of the approve gate's four promises (`approval-gate.ts`).
 *   • `policy`           — structurally claimable, but the standing policy does not admit it.
 *   • `deferred`         — the operator vetoed this pick (`picker-veto.ts`), and the bounded window
 *                          they bought with it has not run out. Their answer, not a rule's.
 */
export type PickerExclusionReason =
  | "not-a-run-target"
  | "not-open"
  | "abandoned"
  | "claimed"
  | "blocked"
  | "approval-gap"
  | "policy"
  | "deferred";

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
 * The decision inputs a plan was computed from — the board snapshot AND the policy in force —
 * carried on the record so staleness is detectable rather than assumed from the clock.
 */
export interface BoardStamp {
  /**
   * When the pass read the board (epoch ms), in the gardener's `observedAtMs` sense: the moment a
   * change to a bead counts as having happened "since we looked".
   */
  observedAtMs: number;
  /** {@link stampBoard}'s digest over those inputs. Two reads agree iff their digests do. */
  digest: string;
  /** How many beads the digest covers. */
  beadCount: number;
}

export interface BoardPickerPlan {
  projectId: string;
  /**
   * Identity of this GENERATION of the plan — what a verdict names when it answers one of its picks
   * ({@link planIdFor}).
   */
  planId: string;
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
 * The bead's contract standing, as the digest carries it: the VERDICT, never the prose it was read
 * from.
 *
 * Eligibility reads the contract-bearing fields — `description`, `acceptance_criteria`,
 * `acceptance` — through the approve gate (`makeApprovalGate` → `contractGaps`), so a deleted
 * Acceptance section flips a target from eligible to `approval-gap` without touching any other
 * field. A digest over the raw prose would catch that, but it would also mark every plan stale on a
 * typo fix; a digest over the parsed verdict catches exactly the edits that can change the answer.
 * `undefined` — exempt tier, or a bead no bd read produced — is its own state, distinct from
 * "judged and clean", because those two are different answers about whether the gate applies.
 */
function contractDigest(bead: Bead): string {
  const status = contractStatusOf(bead);
  if (!status) return "unjudged";
  return [...status.blocking, ...status.advisory]
    .map((v) => `${v.severity}/${v.section}`)
    .sort()
    .join(",");
}

/**
 * The projection of a bead the digest covers: exactly the inputs eligibility and the PRIME ranking
 * read, and nothing else.
 *
 * Deliberately NOT the bead's raw prose or its `updated_at` stamp. A digest over "was this bead
 * written at all" would mark every plan stale the moment somebody fixed a typo in a description, on
 * a board where the pass reruns every ten minutes anyway — so "the board moved" would stop meaning
 * anything. What the fence must catch is a move that could change the ANSWER: the fields below, plus
 * whatever the description says about the contract, which enters as {@link contractDigest}'s verdict
 * rather than as its text.
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
    contractDigest(bead),
  ].join("\t");
}

/**
 * Stamp the inputs one decision was made from. Order-independent — the lines are sorted before
 * hashing — because two reads of an unchanged board may return the beads in any order, and a stamp
 * that disagreed with itself over that would report every plan stale.
 *
 * The armed POLICY is hashed alongside the beads (anton-t9m4 review): admission is a function of
 * both, so an operator who narrows `pickerPolicy` without touching a bead has invalidated the plan
 * just as surely as a claim would have. A fence over the beads alone would keep offering a start the
 * new policy refuses until the next pass ran. Absent means the project has armed none, which is its
 * own state and digests differently from any policy.
 */
export function stampBoard(board: Bead[], observedAtMs: number, policy?: Policy): BoardStamp {
  const hash = createHash("sha256");
  hash.update(`policy\t${policyDigest(policy)}\n`);
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
 *
 * The operator's live vetoes are the third decision input, and the ONLY one the digest cannot carry:
 * a deferral is anton's own state with a wall-clock expiry, not a bead field, so a hold running out
 * re-admits a target while every hashed input sits still. A plan is therefore also stale once a
 * target it set aside as `deferred` is no longer held — otherwise the newly eligible bead would stay
 * out of Up Next until the next scheduled pass rewrote the plan. A veto ARRIVING needs no such fence:
 * the lane subtracts live deferrals from the plan it reads (`upNextEntries`), which is a narrower and
 * faster answer than withholding the whole ranking.
 */
export function isPlanStale(
  plan: BoardPickerPlan,
  current: BoardStamp,
  deferrals?: ReadonlyMap<string, number>,
): boolean {
  if (plan.stamp.digest !== current.digest) return true;
  return plan.exclusions.some((x) => x.reason === "deferred" && !deferrals?.has(x.beadId));
}

/**
 * Deterministic ordering for the exclusions: by bead id, then reason. Unlike the entries — whose
 * order IS the ranking's output and is preserved verbatim — exclusions have no inherent order, and
 * two passes over unchanged state must serialize byte-identically for the record to be idempotent
 * rather than merely recomputed.
 *
 * Compares by code unit, never `localeCompare` — the same reason the rank order does: a
 * locale-sensitive order is not the same order twice.
 */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function sortExclusions(exclusions: PickerExclusion[]): PickerExclusion[] {
  return [...exclusions].sort(
    (a, b) => byCodeUnit(a.beadId, b.beadId) || byCodeUnit(a.reason, b.reason),
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
 * The identity of the plan generation being saved — the name a verdict records when it answers one
 * of this plan's picks (`picker-veto.ts`).
 *
 * NOT the board digest, and that is the whole point (PR #212 review). The digest covers the decision
 * INPUTS — the board and the armed policy — so it is legitimately REUSABLE: a target vetoed on
 * Monday is re-admitted by a later pass over a board and a policy nobody has touched, and that pass
 * stamps a byte-identical digest. A verdict keyed to it would make the new pick inherit the old
 * decline, so the release would start the run and record no accept, quietly skewing the track record
 * earned autonomy reads.
 *
 * Carried over when the pass re-decides the SAME plan, though — the digest, the ranking and the
 * exclusions all unchanged. The accept and the veto are written by two routes that each read the
 * plan for themselves, and a fresh id on every ten-minute no-op tick would let a rerun landing
 * between those two reads hand them different names for one pick, which is exactly the collision
 * `pickAlreadyAnswered` exists to catch. A veto changes the exclusions, so the pass that re-admits
 * the target after the window closes is never mistaken for the one that offered it before.
 */
async function planIdFor(
  db: AntonDb,
  projectId: string,
  decided: { boardDigest: string; entriesJson: string; exclusionsJson: string },
): Promise<string> {
  const [prev] = await db
    .select({
      planId: schema.boardPickerPlans.planId,
      boardDigest: schema.boardPickerPlans.boardDigest,
      entriesJson: schema.boardPickerPlans.entriesJson,
      exclusionsJson: schema.boardPickerPlans.exclusionsJson,
    })
    .from(schema.boardPickerPlans)
    .where(eq(schema.boardPickerPlans.projectId, projectId))
    .limit(1);
  const unchanged =
    prev !== undefined &&
    prev.planId !== "" &&
    prev.boardDigest === decided.boardDigest &&
    prev.entriesJson === decided.entriesJson &&
    prev.exclusionsJson === decided.exclusionsJson;
  return unchanged ? prev.planId : randomUUID();
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
  const decided = {
    boardDigest: input.stamp.digest,
    entriesJson: JSON.stringify(entries),
    exclusionsJson: JSON.stringify(exclusions),
  };
  const row = {
    projectId: input.projectId,
    jobId: input.jobId ?? null,
    planId: await planIdFor(db, input.projectId, decided),
    generatedAt: secDate(clock.now()),
    boardObservedAtMs: input.stamp.observedAtMs,
    boardBeadCount: input.stamp.beadCount,
    targetCount: entries.length,
    ...decided,
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
    planId: row.planId,
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
