/**
 * The disarm latch and the re-arm that lifts it (anton-5c8h / R4.1, R4.6).
 *
 * A disarm is the only breaker state anton PERSISTS, and it persists for one reason: it does not
 * clear itself. A hold is recomputed from live run/PR state every pass, so storing one could only
 * ever produce a staler second answer; a disarm has to outlive the pass that raised it, or the next
 * pass would start work the quality signal just said to stop.
 *
 * Re-arming is a human act with an author. `rearmedBy` is not decoration: a frozen policy being
 * lifted is the single most consequential button on the board, and "who decided the scores were fine
 * again" is exactly the question asked afterwards.
 *
 * db-injectable (like escalations/run-health) so the detectors and their tests share one connection;
 * the UI read path goes through the shared anton.db via {@link currentDisarm}.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb, schema } from "./db";
import { raiseEscalation, settleEscalation } from "./escalations";
import type { AutopilotDisarm, DisarmReason } from "./autopilot-breaker";
import type { AntonDb, Clock } from "./jobs/queue";

export type AutopilotDisarmRow = typeof schema.autopilotDisarms.$inferSelect;

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

function toEpoch(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  return Number(value);
}

/**
 * The evidence lines, or none when the blob is unreadable. A corrupt blob degrades to a disarm with
 * no case attached rather than to no disarm at all — the latch is the safety property, and losing it
 * to a JSON error would start work the detector stopped.
 */
function parseEvidence(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((line): line is string => typeof line === "string") : [];
  } catch {
    return [];
  }
}

/** The latched row as the lane header reads it. */
export function toDisarmView(row: AutopilotDisarmRow): AutopilotDisarm {
  return {
    kind: "disarm",
    reason: row.reason as DisarmReason,
    detail: row.detail,
    evidence: parseEvidence(row.evidenceJson),
    escalationId: row.escalationId ?? undefined,
    since: toEpoch(row.disarmedAt),
  };
}

export interface DisarmAutopilotInput {
  projectId: string;
  reason: DisarmReason;
  detail: string;
  /** The score series or the failed runs — one line each, printed verbatim in the header. */
  evidence?: string[];
  /** The escalation raised alongside (R4.6). */
  escalationId?: string;
}

export interface DisarmAutopilotResult {
  disarm: AutopilotDisarmRow;
  /** False when the project was ALREADY disarmed — the idempotent path. */
  created: boolean;
}

/** The project's latched disarm row, or undefined when the autopilot is armed. */
function latchedRow(tx: Pick<AntonDb, "select">, projectId: string): AutopilotDisarmRow | undefined {
  return tx
    .select()
    .from(schema.autopilotDisarms)
    .where(
      and(
        eq(schema.autopilotDisarms.projectId, projectId),
        isNull(schema.autopilotDisarms.rearmedAt),
      ),
    )
    .limit(1)
    .all()[0];
}

/**
 * Freeze the project's policy, or return the disarm already freezing it.
 *
 * Idempotent by the same construction `raiseEscalation` uses — one synchronous transaction plus
 * `autopilot_disarms_latched_unique` as the DB-level backstop. A second detector tripping while the
 * first is unlifted therefore changes nothing: the operator has one thing to read and one thing to
 * clear, not a queue of freezes that each need their own re-arm.
 */
export async function disarmAutopilot(
  db: AntonDb,
  clock: Clock,
  input: DisarmAutopilotInput,
): Promise<DisarmAutopilotResult> {
  const nowMs = clock.now();
  try {
    return db.transaction((tx) => {
      const existing = latchedRow(tx, input.projectId);
      if (existing) return { disarm: existing, created: false };
      const inserted = tx
        .insert(schema.autopilotDisarms)
        .values({
          id: randomUUID(),
          projectId: input.projectId,
          reason: input.reason,
          detail: input.detail,
          evidenceJson: JSON.stringify(input.evidence ?? []),
          escalationId: input.escalationId,
          disarmedAt: secDate(nowMs),
        })
        .returning()
        .all()[0]!;
      return { disarm: inserted, created: true };
    });
  } catch (e) {
    const winner = latchedRow(db, input.projectId);
    if (winner) return { disarm: winner, created: false };
    throw e;
  }
}

/**
 * Give a latched disarm the strip row it is missing (R4.6), reconstructed from the latch itself.
 *
 * A no-op for a disarm that already carries one, and idempotent on the escalation's own key even
 * when it does not — so every path that meets a latch can call this rather than assume.
 */
async function withEscalation(
  db: AntonDb,
  clock: Clock,
  row: AutopilotDisarmRow,
): Promise<AutopilotDisarmRow> {
  if (row.escalationId) return row;
  const sinceMs = (toEpoch(row.disarmedAt) ?? Math.floor(clock.now() / 1000)) * 1000;
  const { escalation } = await raiseEscalation(db, clock, {
    projectId: row.projectId,
    finding: {
      kind: "autopilot-disarm",
      key: `autopilot-disarm:${row.reason}`,
      reason: row.detail,
      since: sinceMs,
      ageMs: Math.max(0, clock.now() - sinceMs),
      evidence: parseEvidence(row.evidenceJson),
    },
  });
  const stamped = await db
    .update(schema.autopilotDisarms)
    .set({ escalationId: escalation.id })
    .where(eq(schema.autopilotDisarms.id, row.id))
    .returning();
  return stamped[0] ?? row;
}

/**
 * Latch the disarm AND put it where the operator actually scans (R4.6).
 *
 * The freeze is written FIRST and the escalation second: the latch is the safety property — it is
 * what stops the next pass starting work — and it must not depend on a second write landing. The
 * escalation is then stamped onto the row, so the strip and the lane header are two views of one
 * decision rather than two independent claims.
 *
 * Both writes are idempotent on their own keys, so a pass re-deciding the same signal adds neither a
 * second freeze nor a second strip row — and an ALREADY-disarmed project gets its existing latch
 * back rather than a second one to clear.
 */
export async function disarmWithEscalation(
  db: AntonDb,
  clock: Clock,
  input: DisarmAutopilotInput,
): Promise<DisarmAutopilotResult> {
  const result = await disarmAutopilot(db, clock, input);
  return { disarm: await withEscalation(db, clock, result.disarm), created: result.created };
}

/** Is this project's autopilot disarmed, and by what? db-injectable; read-only. */
export async function activeDisarm(
  db: AntonDb,
  projectId: string,
): Promise<AutopilotDisarm | undefined> {
  const row = latchedRow(db, projectId);
  return row ? toDisarmView(row) : undefined;
}

/**
 * The same question a DETECTOR asks before it stops deciding — repairing a half-written latch on
 * the way.
 *
 * The freeze and its escalation are two writes, and only the first is the safety property. A crash
 * between them leaves a frozen policy that the "Needs you" band never mentions, and nothing would
 * ever finish the job: every breaker returns early once a disarm exists, so the escalation write
 * gets no natural second chance. This is that second chance — the one call every breaker already
 * makes on every pass.
 */
export async function activeDisarmForPass(
  db: AntonDb,
  clock: Clock,
  projectId: string,
): Promise<AutopilotDisarm | undefined> {
  const row = latchedRow(db, projectId);
  return row ? toDisarmView(await withEscalation(db, clock, row)) : undefined;
}

export type ReArmResult =
  | { ok: true; reason: DisarmReason; actor: string; at: number }
  /** Nothing was latched — a second click, or a stale header. Refused rather than recorded. */
  | { ok: false; failure: "not-disarmed" };

/**
 * Lift the latch, on the record.
 *
 * The `rearmed_at is null` guard lives in the UPDATE's WHERE, so two clicks can't both win: the
 * second updates zero rows and reports `not-disarmed`, which is what stops a double-click from
 * writing a second, later author over the one who actually made the call.
 */
export async function reArmAutopilot(
  db: AntonDb,
  clock: Clock,
  input: { projectId: string; actor: string },
): Promise<ReArmResult> {
  const at = secDate(clock.now());
  const updated = await db
    .update(schema.autopilotDisarms)
    .set({ rearmedAt: at, rearmedBy: input.actor })
    .where(
      and(
        eq(schema.autopilotDisarms.projectId, input.projectId),
        isNull(schema.autopilotDisarms.rearmedAt),
      ),
    )
    .returning();
  const row = updated[0];
  if (!row) return { ok: false, failure: "not-disarmed" };
  // The strip row is the disarm's other half (R4.6), so the re-arm settles it too. Left open, the
  // "Needs you" band would keep asking for a decision the operator has just made — and nothing else
  // would ever close it: a disarm is raised on the latch, and this project no longer has one.
  //
  // Best-effort, and deliberately so: the UPDATE above has already committed, so the latch IS
  // lifted. Propagating a settle failure would answer a successful re-arm with "Failed to re-arm
  // autopilot" and leave the operator believing the autopilot is still frozen when it is running.
  if (row.escalationId) {
    try {
      await settleEscalation(db, clock, row.escalationId, "resumed");
    } catch (e) {
      console.error(`[autopilot] re-arm could not settle escalation ${row.escalationId}:`, e);
    }
  }
  return {
    ok: true,
    reason: row.reason as DisarmReason,
    actor: row.rearmedBy ?? input.actor,
    at: toEpoch(row.rearmedAt) ?? Math.floor(at.getTime() / 1000),
  };
}

/**
 * Unix seconds of the project's most recent re-arm, or undefined if it has never been re-armed.
 *
 * The floor every breaker judges evidence against. A re-arm is an operator ADJUDICATING the runs
 * that tripped the latch — "I read those, I fixed it, judge me on what happens next" — so a detector
 * that could still see them would re-latch the identical disarm on its very next pass and silently
 * revert the decision. Nothing new has to fail for that: the same settled runs are still the most
 * recent ones.
 */
export async function lastReArmAt(db: AntonDb, projectId: string): Promise<number | undefined> {
  const rows = await db
    .select({ rearmedAt: schema.autopilotDisarms.rearmedAt })
    .from(schema.autopilotDisarms)
    .where(
      and(
        eq(schema.autopilotDisarms.projectId, projectId),
        isNotNull(schema.autopilotDisarms.rearmedAt),
      ),
    )
    .orderBy(desc(schema.autopilotDisarms.rearmedAt))
    .limit(1);
  return toEpoch(rows[0]?.rearmedAt);
}

/**
 * Did this run settle after the project was last re-armed? Evidence older than the floor was already
 * adjudicated (see {@link lastReArmAt}) and counts for nothing.
 *
 * A run still in flight is judged on when it last moved, which keeps it out of the window until it
 * settles — exactly what "judge me on what happens next" means for work that straddles the re-arm.
 */
export function settledAfterReArm(
  run: { endedAt?: number; updatedAt: number },
  floor: number | undefined,
): boolean {
  if (floor === undefined) return true;
  return (run.endedAt ?? run.updatedAt) > floor;
}

/**
 * The project's disarm history, newest first — every freeze and who lifted it. Bounded by `limit`
 * because a decision log reads the recent ones and nothing needs the whole table at once.
 */
export async function listDisarms(
  db: AntonDb,
  projectId: string,
  limit = 20,
): Promise<AutopilotDisarmRow[]> {
  return db
    .select()
    .from(schema.autopilotDisarms)
    .where(eq(schema.autopilotDisarms.projectId, projectId))
    .orderBy(desc(schema.autopilotDisarms.disarmedAt))
    .limit(limit);
}

/** UI read path over the shared anton.db. */
export function currentDisarm(projectId: string): Promise<AutopilotDisarm | undefined> {
  return activeDisarm(getDb(), projectId);
}
