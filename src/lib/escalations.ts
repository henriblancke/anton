/**
 * Founder-facing escalations (anton-wvcy): the durable record that anton asked a human about a
 * stalled run, and what they answered.
 *
 * The unstick pass (jobs/unstick.ts) splits every run-health finding two ways — provably-safe parks
 * auto-resume, everything else lands here. An escalation is deliberately NOT a retry: nothing in
 * anton acts on one, so a stall that needs judgment waits for judgment instead of burning attempts
 * in a loop nobody is watching.
 *
 * Idempotence is the whole contract: re-raising the same finding while its escalation is still open
 * updates nothing and inserts nothing (`escalations_open_unique` + the transactional guard here), so
 * a sweep running hourly over an unchanged stall produces exactly one board item, not one per hour.
 *
 * db-injectable (like runs/run-health) so the sweep and its tests share one connection; the UI read
 * path goes through the shared anton.db.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { AntonDb, Clock } from "./jobs/queue";
import type { RunHealthFinding, RunHealthFindingKind } from "./run-health";

export type EscalationStatus = "open" | "resolved";
/**
 * How a founder settled an escalation: retry the work, call it won't-do, or acknowledge a stall
 * anton cannot act on (`dismissed` — see escalation-actions.ts). A dismissal settles the ROW only;
 * the next sweep re-raises the finding if it still holds, so it can't silence a live stall.
 */
export type EscalationResolution = "resumed" | "abandoned" | "dismissed";

/**
 * The verb side of {@link EscalationResolution} — what the founder clicked, before it is recorded as
 * how the row was settled. It lives here rather than with the code that applies it so that every
 * handler taking a verb can name one without importing back through escalation-actions.ts.
 */
export type EscalationAction = "resume" | "abandon" | "dismiss";

export type EscalationRow = typeof schema.escalations.$inferSelect;

/** One escalation as the board renders it — the finding's evidence plus its decision state. */
export interface EscalationView {
  id: string;
  findingKey: string;
  kind: RunHealthFindingKind;
  /** Why it's stuck: the park reason, the PR's idle state, the job's last error. */
  reason: string;
  beadId?: string;
  /** The epic a resume re-enqueues — jobs are keyed by epic, not by the ticket that stalled. */
  epicBeadId?: string;
  /**
   * The human gate a `needs-human` wait hangs on — what resolve-and-resume closes (see
   * escalation-gate.ts). Absent on every other kind: nothing else stalls on a gate.
   */
  gateId?: string;
  runId?: string;
  jobId?: string;
  prNumber?: number;
  prUrl?: string;
  /** Unix seconds the stall started, so the panel can age it live rather than as of the sweep. */
  since?: number;
  /** How long it had been stuck when the sweep saw it (ms) — the evidence, frozen. */
  ageMs: number;
  status: EscalationStatus;
  resolution?: EscalationResolution;
  /** Whether the board-native `bd note` landed on the target bead. */
  noted: boolean;
  /** Unix seconds this escalation was first raised. */
  raisedAt: number;
}

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

function toEpoch(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  return Number(value);
}

/** The finding an escalation was raised from, or an empty shell when the blob is unreadable. */
function parseEvidence(json: string): Partial<RunHealthFinding> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Partial<RunHealthFinding>) : {};
  } catch {
    // A corrupt blob degrades to "no extra evidence" — the row's own columns still carry the
    // reason, target and age, so the escalation stays actionable instead of vanishing.
    return {};
  }
}

export function toEscalationView(row: EscalationRow): EscalationView {
  const evidence = parseEvidence(row.evidenceJson);
  return {
    id: row.id,
    findingKey: row.findingKey,
    kind: row.kind as RunHealthFindingKind,
    reason: row.reason,
    beadId: row.beadId ?? undefined,
    epicBeadId: row.epicBeadId ?? undefined,
    // No column of its own: the gate is evidence the detector recorded, like the PR pointers below.
    gateId: typeof evidence.gateId === "string" ? evidence.gateId : undefined,
    runId: row.runId ?? undefined,
    jobId: row.jobId ?? undefined,
    prNumber: typeof evidence.prNumber === "number" ? evidence.prNumber : undefined,
    prUrl: typeof evidence.prUrl === "string" ? evidence.prUrl : undefined,
    since: toEpoch(row.since),
    ageMs: typeof evidence.ageMs === "number" ? evidence.ageMs : 0,
    status: row.status as EscalationStatus,
    resolution: (row.resolution ?? undefined) as EscalationResolution | undefined,
    noted: row.notedAt != null,
    raisedAt: toEpoch(row.raisedAt) ?? 0,
  };
}

export interface RaiseEscalationInput {
  projectId: string;
  finding: RunHealthFinding;
  /** The epic a resume would re-enqueue, when the finding names one. */
  epicBeadId?: string;
}

/** What {@link raiseEscalation} did: the row that now covers this finding, and whether it's new. */
export interface RaiseEscalationResult {
  escalation: EscalationRow;
  /** False when an open escalation already covered this finding — the idempotent path. */
  created: boolean;
}

/**
 * Raise an escalation for a finding, or return the open one that already covers it.
 *
 * The read-then-insert runs in one better-sqlite3 transaction (single synchronous connection, so
 * the pair can't interleave) with `escalations_open_unique` as the DB-level backstop — the same
 * shape as the job queue's dedupe. Two passes racing over the same finding therefore yield ONE
 * open escalation, and the loser reports `created: false` so it doesn't re-write the bd note.
 */
export async function raiseEscalation(
  db: AntonDb,
  clock: Clock,
  input: RaiseEscalationInput,
): Promise<RaiseEscalationResult> {
  const { projectId, finding } = input;
  const nowMs = clock.now();

  const openRow = (tx: Pick<AntonDb, "select">) =>
    tx
      .select()
      .from(schema.escalations)
      .where(
        and(
          eq(schema.escalations.projectId, projectId),
          eq(schema.escalations.findingKey, finding.key),
          eq(schema.escalations.status, "open"),
        ),
      )
      .limit(1)
      .all()[0];

  try {
    return db.transaction((tx) => {
      const existing = openRow(tx);
      if (existing) return { escalation: existing, created: false };

      const inserted = tx
        .insert(schema.escalations)
        .values({
          id: randomUUID(),
          projectId,
          findingKey: finding.key,
          kind: finding.kind,
          reason: finding.reason,
          beadId: finding.beadId,
          epicBeadId: input.epicBeadId,
          runId: finding.runId,
          jobId: finding.jobId,
          since: secDate(finding.since),
          evidenceJson: JSON.stringify(finding),
          status: "open",
          raisedAt: secDate(nowMs),
          updatedAt: secDate(nowMs),
        })
        .returning()
        .all()[0]!;
      return { escalation: inserted, created: true };
    });
  } catch (e) {
    // Backstop: the partial index rejected a concurrent insert. The winner now covers this finding.
    const winner = openRow(db);
    if (winner) return { escalation: winner, created: false };
    throw e;
  }
}

/** Stamp that the board-native `bd note` landed, so later passes stop retrying it. */
export async function markEscalationNoted(
  db: AntonDb,
  clock: Clock,
  id: string,
): Promise<void> {
  const nowMs = clock.now();
  await db
    .update(schema.escalations)
    .set({ notedAt: secDate(nowMs), updatedAt: secDate(nowMs) })
    .where(eq(schema.escalations.id, id));
}

/** A project's open escalations, newest stall first. db-injectable; read-only. */
export async function listOpenEscalations(
  db: AntonDb,
  projectId: string,
): Promise<EscalationRow[]> {
  return db
    .select()
    .from(schema.escalations)
    .where(
      and(eq(schema.escalations.projectId, projectId), eq(schema.escalations.status, "open")),
    )
    .orderBy(desc(schema.escalations.raisedAt));
}

/** One escalation, scoped to its project so a route can't settle another project's item by id. */
export async function getEscalation(
  db: AntonDb,
  projectId: string,
  id: string,
): Promise<EscalationRow | undefined> {
  const rows = await db
    .select()
    .from(schema.escalations)
    .where(and(eq(schema.escalations.projectId, projectId), eq(schema.escalations.id, id)))
    .limit(1);
  return rows[0];
}

/**
 * Settle an escalation. The status guard lives in the UPDATE's WHERE so two clicks on the same
 * item can't both "win": the second updates zero rows and reports false, which is what stops a
 * double-click from resuming a run twice.
 */
export async function settleEscalation(
  db: AntonDb,
  clock: Clock,
  id: string,
  resolution: EscalationResolution,
): Promise<boolean> {
  const nowMs = clock.now();
  const rows = await db
    .update(schema.escalations)
    .set({ status: "resolved", resolution, updatedAt: secDate(nowMs) })
    .where(and(eq(schema.escalations.id, id), eq(schema.escalations.status, "open")))
    .returning({ id: schema.escalations.id });
  return rows.length > 0;
}

/** UI read path over the shared anton.db — the board panel's source. */
export async function openEscalations(projectId: string): Promise<EscalationView[]> {
  return (await listOpenEscalations(getDb(), projectId)).map(toEscalationView);
}
