/**
 * Parked work nobody is watching (anton-kh98).
 *
 * The stall loop is two automations: `run-health` DETECTS (it writes the report) and `unstick` ACTS
 * (it reads that report and raises escalations). run-health ships opt-in and unstick is a strict
 * no-op without it — so on a default install a job can park and nothing anywhere says so. The
 * escalation strip stays empty because its only producer never ran, which reads exactly like a
 * healthy board.
 *
 * This is the signal that closes that gap: it says parked work exists AND that nothing is watching
 * it. Deliberately not a detector — the sweep's detectors already cover these jobs — just a count
 * and an age off the `jobs` table, computed only while the loop is disarmed.
 *
 * db-injectable (like runs/schedules) so tests share one connection; the UI read path uses the
 * shared anton.db.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "./db";
import { systemClock, type AntonDb, type Clock } from "./jobs/queue";
import type { ScheduledJobType } from "./schedules";

/**
 * The two halves of detect → act. Both must be armed for parked work to be watched: with the
 * producer off there is no report, and with the consumer off the report reaches nobody.
 */
export const WATCHER_AUTOMATIONS = ["run-health", "unstick"] as const satisfies readonly ScheduledJobType[];

export type WatcherAutomation = (typeof WATCHER_AUTOMATIONS)[number];

/** The count, the age, and which switch is off — everything the band needs and nothing more. */
export interface UnwatchedParks {
  parkedCount: number;
  /** Unix seconds the oldest park settled. */
  oldestSince: number;
  /**
   * How long the oldest had waited when this was read (ms). Frozen at the read, like a run-health
   * finding's `ageMs`: the band renders inside a Client Component, so an age re-derived in the
   * browser would disagree with the server's across any unit boundary the two renders straddle.
   */
  oldestAgeMs: number;
  /** Which of {@link WATCHER_AUTOMATIONS} are off — what arming the watcher turns on. */
  disarmed: WatcherAutomation[];
}

/**
 * The signal, as a pure function of what was read.
 *
 * Returns `undefined` — render nothing — in the two cases that are NOT a problem: the watcher is
 * armed (a park will be escalated on the next sweep, and that is the strip's row to draw), or
 * nothing is parked. Silence is the whole point: a band that appeared on a healthy board would be
 * one more always-on ornament to learn to ignore.
 */
export function unwatchedParks(input: {
  /** Unix seconds each parked job settled at, in any order. */
  parkedAt: number[];
  disarmed: WatcherAutomation[];
  nowMs: number;
}): UnwatchedParks | undefined {
  if (input.disarmed.length === 0) return undefined;
  if (input.parkedAt.length === 0) return undefined;
  const oldestSince = Math.min(...input.parkedAt);
  return {
    parkedCount: input.parkedAt.length,
    oldestSince,
    // Clamped: a job whose clock ran ahead of this read is 0s old, never negative.
    oldestAgeMs: Math.max(0, input.nowMs - oldestSince * 1000),
    disarmed: WATCHER_AUTOMATIONS.filter((type) => input.disarmed.includes(type)),
  };
}

/**
 * Which of the watcher's automations this project has NOT armed.
 *
 * A missing row counts as off, unlike {@link isScheduleEnabled}'s "absence reads as enabled" rule:
 * both of these ship opt-in (run-health by design, and a project predating the type has no row at
 * all), so treating absence as armed would silence this signal on exactly the installs it exists
 * for — the ones where the sweep has never run.
 */
export async function disarmedWatchers(
  db: AntonDb,
  projectId: string,
): Promise<WatcherAutomation[]> {
  const rows = await db
    .select({ type: schema.schedules.type, enabled: schema.schedules.enabled })
    .from(schema.schedules)
    .where(
      and(
        eq(schema.schedules.projectId, projectId),
        inArray(schema.schedules.type, [...WATCHER_AUTOMATIONS]),
      ),
    );
  const armed = new Set(rows.filter((row) => row.enabled).map((row) => row.type));
  return WATCHER_AUTOMATIONS.filter((type) => !armed.has(type));
}

function toEpoch(value: unknown): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  return Number(value ?? 0);
}

/**
 * The project's unwatched parked work, or `undefined` when there is none to report. db-injectable.
 *
 * The parked jobs are only counted once the switches say nobody is watching — on a healthy project
 * this costs one indexed read of two schedule rows and stops there.
 */
export async function projectUnwatchedParks(
  db: AntonDb,
  projectId: string,
  clock: Clock = systemClock,
): Promise<UnwatchedParks | undefined> {
  const disarmed = await disarmedWatchers(db, projectId);
  if (disarmed.length === 0) return undefined;
  const rows = await db
    .select({ updatedAt: schema.jobs.updatedAt })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.projectId, projectId), eq(schema.jobs.status, "parked")));
  // `updatedAt` is stamped by the transition that parked the job, so it IS when the wait began.
  return unwatchedParks({
    parkedAt: rows.map((row) => toEpoch(row.updatedAt)),
    disarmed,
    nowMs: clock.now(),
  });
}

/** UI read path over the shared anton.db. */
export function unwatchedParksForProject(
  projectId: string,
  clock: Clock = systemClock,
): Promise<UnwatchedParks | undefined> {
  return projectUnwatchedParks(getDb(), projectId, clock);
}
