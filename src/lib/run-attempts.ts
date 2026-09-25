/**
 * The per-attempt run record (anton-rnrdr): when each attempt on a run began, when it ended, and how
 * it settled — the intervals `runs` itself cannot keep.
 *
 * `runs` is one row per RUN. A parked run resumes IN PLACE (`findOpenRunForEpic`) and that resume
 * REWRITES `runs.attempt_started_at`, deliberately — the repair weigher orders a failure against when
 * its own attempt began, so the column has to mean the CURRENT attempt's start (gardener/repair.ts).
 * The cost is that every earlier attempt's interval is gone by the time the run settles, which is why
 * the feature ledger refuses `wallMs` rather than approximating it (feature-ledger.ts). This module
 * records the intervals beside that column instead of redefining it: nothing here changes what
 * `attempt_started_at` means, and its current readers are untouched.
 *
 * The same append-only FACT shape as `claude-invocations`, and the same never-fail-the-work rule:
 * both writes swallow their own failures. A run that did the work must not fail because a meter could
 * not be written, and what a lost write costs is one interval — never the delivery.
 *
 * db-injectable, like `runs` and `claude-invocations`: the handler and its tests share one connection.
 */
import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import { toEpoch } from "./db/epoch";
import type { AntonDb, Clock } from "./jobs/queue";
import type { RunStatus } from "@/components/runs/run-view-utils";

export type RunAttemptRow = typeof schema.runAttempts.$inferSelect;

/**
 * How an attempt settled — the run row's own terminal vocabulary, minus the states that are not
 * settlements (`queued`, `running`). A resumed park is a settled attempt like any other: the interval
 * it closes is exactly the one that would otherwise be lost.
 */
export type AttemptOutcome = Extract<RunStatus, "parked" | "done" | "failed">;

/** Whole-second, like every other timestamp anton writes — see `runs.ts`. */
function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

/**
 * Open a row for an attempt that is starting — a fresh run's first, or a resume's next.
 *
 * Best-effort by contract: it NEVER throws. Driven from `runs.ts` rather than from the handler:
 * `createRun` opens a fresh run's first attempt, and `updateRun` opens the next one whenever a patch
 * carries `attemptStartedAt` — the one field only a resume writes (`startEpicRun`). Hooking the run
 * write path rather than each caller is what stops a new settle site from silently skipping the record.
 *
 * The ordinal is derived from the rows already recorded for this run rather than from
 * `runs.attempts`: that column counts the QUEUE's delivery attempts (`ctx.attempt`) and is stamped
 * from a different clock entirely, so a run whose job was redelivered without a resume would skip
 * numbers here. SQLite serializes writers, so the count-then-insert is atomic enough for a per-run
 * sequence — and a duplicate ordinal would cost only the ordering of two rows whose intervals still
 * sum correctly.
 */
export async function recordAttemptStart(
  db: AntonDb,
  clock: Clock,
  input: { runId: string; projectId?: string; startedAtMs?: number },
): Promise<void> {
  try {
    const prior = await db
      .select({ n: count() })
      .from(schema.runAttempts)
      .where(eq(schema.runAttempts.runId, input.runId));
    await db.insert(schema.runAttempts).values({
      id: randomUUID(),
      runId: input.runId,
      // Resolved from the run when the caller has none in hand — a RESUME patches an existing row and
      // never restates its project (`startEpicRun`), so every attempt after the first would otherwise
      // carry a null. The rows are read per run, so it is not needed to find them; it is here so one
      // row stands on its own without a join back to a `runs` row that may be pruned.
      projectId: input.projectId ?? (await projectOfRun(db, input.runId)) ?? null,
      attempt: (prior[0]?.n ?? 0) + 1,
      startedAt: secDate(input.startedAtMs ?? clock.now()),
      recordedAt: secDate(clock.now()),
    });
  } catch {
    // Swallowed on purpose — see the contract above.
  }
}

/**
 * Close the open row for a run's current attempt with how it settled.
 *
 * Best-effort by contract: it NEVER throws. Called from `updateRun` itself, so every settle path
 * closes its attempt without each having to remember to — the same reason the spend ledger is a
 * driver wrapper rather than a call in each dispatch.
 *
 * Closes only the run's OPEN row (`ended_at IS NULL`), MOST RECENTLY OPENED first, and writes nothing
 * when there is none: a run's terminal status can be written more than once (a `done` row re-settled
 * by recovery, a park whose corrective write follows it), and a second close must not revise an
 * interval already recorded. That is the append-only rule — a row's interval is true of the attempt
 * that ran it.
 *
 * Two open rows can coexist for one run: `reconcileInterruptedRuns` deliberately leaves a crashed
 * `running` row's attempt unclosed when its job is about to be re-dispatched, and the resume
 * (`findOpenRunForEpic` / `openRunRow`) then opens a second attempt on top of it. When that resumed
 * attempt later settles, the row to close is the one that actually ran — the most recent — not the
 * stale crashed one, or the crash gap gets attributed to the attempt that ran and the attempt that
 * really ran is left open forever, excluded from `wallMs`.
 */
export async function recordAttemptEnd(
  db: AntonDb,
  clock: Clock,
  runId: string,
  outcome: AttemptOutcome,
  endedAtMs?: number,
): Promise<void> {
  try {
    const open = await db
      .select({ id: schema.runAttempts.id })
      .from(schema.runAttempts)
      .where(and(eq(schema.runAttempts.runId, runId), isNull(schema.runAttempts.endedAt)))
      .orderBy(desc(schema.runAttempts.attempt))
      .limit(1);
    const id = open[0]?.id;
    if (!id) return;
    await db
      .update(schema.runAttempts)
      .set({ endedAt: secDate(endedAtMs ?? clock.now()), outcome })
      .where(and(eq(schema.runAttempts.id, id), isNull(schema.runAttempts.endedAt)));
  } catch {
    // Swallowed on purpose — see the contract above.
  }
}

/** The project a run belongs to, or undefined when there is no such row. */
async function projectOfRun(db: AntonDb, runId: string): Promise<string | undefined> {
  const rows = await db
    .select({ projectId: schema.runs.projectId })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))
    .limit(1);
  return rows[0]?.projectId ?? undefined;
}

/** One run's attempts, in the order they ran. */
export async function listRunAttempts(db: AntonDb, runId: string): Promise<RunAttemptRow[]> {
  return db
    .select()
    .from(schema.runAttempts)
    .where(eq(schema.runAttempts.runId, runId))
    // `attempt` is the sequence; `rowid` breaks a tie for the duplicate ordinal two racing
    // starts could produce, since it is assigned in INSERT order.
    .orderBy(asc(schema.runAttempts.attempt), asc(sql`rowid`));
}

/** One attempt as a pure interval — what the fold below is computed from. */
export interface AttemptInterval {
  attempt: number;
  startedAt: number;
  endedAt?: number;
  outcome?: string;
}

/** A run's wall time including retries, and what it could not account for. */
export interface AttemptWall {
  /**
   * Σ over the attempts that CLOSED — wall time including retries. For a run that never retried this
   * is its single interval, equal to `endedAt − startedAt` on the run row.
   */
  wallMs: number;
  /** How many attempts are recorded, and how many of them carry no end (still running, or crashed). */
  attempts: number;
  openAttempts: number;
}

/** Epoch-second rows → intervals, so the fold below is testable without a database. */
export function attemptIntervals(rows: readonly RunAttemptRow[]): AttemptInterval[] {
  return rows.map((row) => ({
    attempt: row.attempt,
    startedAt: toEpoch(row.startedAt) ?? 0,
    endedAt: toEpoch(row.endedAt),
    outcome: row.outcome ?? undefined,
  }));
}

/**
 * Fold a run's attempts into its wall time including retries, or `undefined` when NOTHING is recorded
 * — a run that settled before this table existed, or one whose start writes were all lost.
 *
 * Undefined rather than zero, for the reason the ledger refuses an approximated `wallMs` at all: "we
 * measured nothing" and "it took no time" are opposite facts, and a zero that reads as the second is
 * the wrong figure surviving into every cohort comparison. An attempt with no end is counted in
 * {@link AttemptWall.openAttempts} and contributes no interval, so a partial sum is visibly partial
 * rather than silently short.
 *
 * Intervals are SUMMED, not unioned: unlike the ledger's `activeMs` over concurrent invocations, the
 * attempts of one run cannot overlap — a resume only happens once the previous attempt has settled.
 */
export function attemptWallMs(intervals: readonly AttemptInterval[]): AttemptWall | undefined {
  if (intervals.length === 0) return undefined;
  let wallMs = 0;
  let openAttempts = 0;
  for (const interval of intervals) {
    if (interval.endedAt === undefined) {
      openAttempts += 1;
      continue;
    }
    // Clamped at zero: the timestamps are whole-second, so a sub-second attempt can round to a
    // negative delta, and a negative "duration" is never a fact about the work.
    wallMs += Math.max(0, (interval.endedAt - interval.startedAt) * 1000);
  }
  return { wallMs, attempts: intervals.length, openAttempts };
}

/** One run's wall time including retries — the read every wall-time question starts from. */
export async function runWallMs(db: AntonDb, runId: string): Promise<AttemptWall | undefined> {
  return attemptWallMs(attemptIntervals(await listRunAttempts(db, runId)));
}

/** UI/read path over the shared anton.db — see {@link runWallMs}. */
export function projectRunWallMs(runId: string): Promise<AttemptWall | undefined> {
  return runWallMs(getDb(), runId);
}
