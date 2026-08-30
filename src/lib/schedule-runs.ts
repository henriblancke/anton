/**
 * What a schedule's most recent fire actually DID (anton-znoz).
 *
 * The `schedules` row carries `lastRunAt` and nothing else, so the Automation table could say when
 * an automation last ran but not whether it worked — and "ran at 03:00" reads as healthy whether the
 * pass filed three beads, found nothing, or parked on a bd failure. The outcome is not new data: the
 * scheduler stamps `scheduleId` into every job it enqueues (jobs/scheduler.ts) and settled job rows
 * are kept for audit, so the fire and its result are already joined — this module is the join.
 *
 * Three claims, deliberately kept apart, because collapsing any two is what made the column useless:
 *   • `ok`     — it ran and changed something (the job reported `outcome = 'ok'`).
 *   • `noop`   — it ran and had nothing to do. The normal outcome of a ten-minute gate poll on a
 *                board with no gates; NOT a failure, and not the same as work getting done.
 *   • `failed` — it parked or failed, and carries the error that says why.
 *   • `cancelled` — an operator killed it. Neither a failure nor a result.
 * A job whose handler reports no effect settles with a NULL outcome and reads as `ok` — it ran and
 * did not fail, which is all that is actually known about it.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "./db";

export type ScheduleRunOutcome = "ok" | "noop" | "failed" | "cancelled";

export interface ScheduleLastRun {
  outcome: ScheduleRunOutcome;
  /** Epoch SECONDS — when the job settled, which is the fire's END, not its start. */
  at: number;
  /**
   * Epoch SECONDS — when the scheduler ENQUEUED this fire. The schedule's own `lastRunAt` is stamped
   * from this very value, in the same transaction as the insert (jobs/scheduler.ts), so it says
   * whether this outcome belongs to the fire the row is showing or to an earlier one: the stamped
   * fire matches it exactly, every earlier fire is strictly older, and no fire can be newer than the
   * stamp. Settlement time cannot answer that — a resumed fire settles after fires that came later.
   */
  enqueuedAt: number;
  /** One short line: what it did, or why it failed. */
  note?: string;
}

/** Statuses a fire can have ENDED in. A queued/running job has no outcome to report yet. */
const SETTLED = ["done", "parked", "failed", "cancelled"] as const;

/** Statuses a fire is still IN. `running` means a worker holds the lease; `queued` means nobody does. */
const PENDING = ["queued", "running"] as const;

/**
 * Where an unsettled fire actually is (anton-znoz). `running` = leased, a handler is executing;
 * `queued` = enqueued and nothing has picked it up.
 *
 * The distinction is the only thing that separates a paused fire from a live one, and the enabled
 * flag cannot stand in for it: the runner gates the CLAIM on the schedule's switch (jobs/runner.ts),
 * so disabling leaves a queued job waiting unleased while an already-leased handler runs to
 * completion regardless of the switch.
 */
export type SchedulePendingStatus = (typeof PENDING)[number];

/** Keep an error legible in a table cell: its first line, clipped. */
const NOTE_MAX = 90;

export function summarizeNote(text: string | null | undefined): string | undefined {
  const first = text?.split("\n", 1)[0]?.trim();
  if (!first) return undefined;
  return first.length > NOTE_MAX ? `${first.slice(0, NOTE_MAX - 1)}…` : first;
}

/** Map one settled job row onto the outcome its schedule's row should show. */
export function toScheduleLastRun(row: {
  status: string;
  outcome: string | null;
  outcomeNote: string | null;
  lastError: string | null;
  at: number;
  enqueuedAt: number;
}): ScheduleLastRun {
  const at = Number(row.at);
  const enqueuedAt = Number(row.enqueuedAt);
  if (row.status === "cancelled") return { outcome: "cancelled", at, enqueuedAt };
  if (row.status === "parked" || row.status === "failed") {
    return { outcome: "failed", at, enqueuedAt, note: summarizeNote(row.lastError) };
  }
  return {
    outcome: row.outcome === "noop" ? "noop" : "ok",
    at,
    enqueuedAt,
    note: summarizeNote(row.outcomeNote),
  };
}

const SCHEDULE_ID = sql<string>`json_extract(${schema.jobs.payloadJson}, '$.scheduleId')`;

/**
 * The latest settled fire per schedule, for one project, keyed by schedule id.
 *
 * One grouped query rather than a per-schedule read: SQLite guarantees that when a query aggregates
 * `max()`, the bare columns beside it come from the row that produced that maximum — so this picks
 * the newest settled job per schedule and its status/outcome in a single pass, instead of scanning
 * every job row into memory to sort in JS.
 *
 * "Newest" is measured on `created_at`, the immutable ENQUEUE time, not on `updated_at`: an operator
 * resuming a long-parked fire re-stamps its `updated_at`, so ordering by settlement would let a
 * fire from last week displace the one that ran an hour ago. The settlement time is still what the
 * column dates, so it rides along as a bare column of the row `max()` chose — and the enqueue time
 * rides along too, because that is what the UI matches against the schedule's `lastRunAt` to tell
 * this fire's outcome from a still-running one's.
 */
export async function lastRunsBySchedule(
  projectId: string,
): Promise<Record<string, ScheduleLastRun>> {
  const rows = await getDb()
    .select({
      scheduleId: SCHEDULE_ID,
      status: schema.jobs.status,
      outcome: schema.jobs.outcome,
      outcomeNote: schema.jobs.outcomeNote,
      lastError: schema.jobs.lastError,
      enqueuedAt: sql<number>`max(${schema.jobs.createdAt})`,
      at: sql<number>`${schema.jobs.updatedAt}`,
    })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.projectId, projectId),
        inArray(schema.jobs.status, [...SETTLED]),
        sql`${SCHEDULE_ID} is not null`,
      ),
    )
    .groupBy(SCHEDULE_ID);

  const byId: Record<string, ScheduleLastRun> = {};
  for (const row of rows) {
    if (!row.scheduleId) continue;
    byId[row.scheduleId] = toScheduleLastRun(row);
  }
  return byId;
}

/**
 * The unsettled fire per schedule, for one project, keyed by schedule id.
 *
 * Grouped rather than listed because only the strongest status matters: with both a leased and a
 * waiting job behind one schedule, work IS running, and reporting the queued one would understate
 * it. Schedules with nothing in flight are simply absent.
 */
export async function pendingRunsBySchedule(
  projectId: string,
): Promise<Record<string, SchedulePendingStatus>> {
  const rows = await getDb()
    .select({ scheduleId: SCHEDULE_ID, status: schema.jobs.status })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.projectId, projectId),
        inArray(schema.jobs.status, [...PENDING]),
        sql`${SCHEDULE_ID} is not null`,
      ),
    )
    .groupBy(SCHEDULE_ID, schema.jobs.status);

  const byId: Record<string, SchedulePendingStatus> = {};
  for (const row of rows) {
    if (!row.scheduleId) continue;
    if (row.status === "running") byId[row.scheduleId] = "running";
    else byId[row.scheduleId] ??= "queued";
  }
  return byId;
}
