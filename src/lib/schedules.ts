/**
 * The `schedules` table — machine-local cron config that drives recurring jobs (anton-3t2.1).
 * Each row is "run job <type> for <project> on <cron>". The scheduler loop (jobs/scheduler.ts)
 * reads enabled rows, enqueues the job when due, and stamps lastRunAt/nextRunAt. See DESIGN §4/§6.
 *
 * db-injectable (like runs/sessions) so the scheduler and tests share one connection; the UI read
 * path uses the shared anton.db.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { AntonDb, Clock } from "./jobs/queue";
import type { JobType } from "./jobs/queue";
import { isValidCron, nextRun } from "./jobs/cron";

/** Job types that run on a schedule (execute-epic is enqueued on approval, never on cron). */
export type ScheduledJobType = Extract<
  JobType,
  "review-fix" | "nightly-stringer" | "orphan-grooming"
>;

export type ScheduleRow = typeof schema.schedules.$inferSelect;

export interface ScheduleSummary {
  id: string;
  projectId: string;
  type: string;
  cron: string;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
}

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

function toEpoch(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  return Number(value);
}

export function toScheduleSummary(row: ScheduleRow): ScheduleSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    type: row.type,
    cron: row.cron,
    enabled: row.enabled,
    lastRunAt: toEpoch(row.lastRunAt),
    nextRunAt: toEpoch(row.nextRunAt),
  };
}

export interface CreateScheduleInput {
  projectId: string;
  type: ScheduledJobType;
  cron: string;
  enabled?: boolean;
}

/**
 * Create a schedule. Validates the cron up front (fail loud) and seeds `nextRunAt` so the loop
 * knows when it first fires. db-injectable for the scheduler/tests.
 */
export async function createSchedule(
  db: AntonDb,
  clock: Clock,
  input: CreateScheduleInput,
): Promise<string> {
  if (!isValidCron(input.cron)) throw new Error(`invalid cron expression: "${input.cron}"`);
  const id = randomUUID();
  const enabled = input.enabled ?? true;
  const nextRunAt = enabled ? nextRun(input.cron, clock.now()) : null;
  await db.insert(schema.schedules).values({
    id,
    projectId: input.projectId,
    type: input.type,
    cron: input.cron,
    enabled,
    nextRunAt: nextRunAt != null ? secDate(nextRunAt) : null,
  });
  return id;
}

export interface UpdateSchedulePatch {
  cron?: string;
  enabled?: boolean;
}

/**
 * Patch a schedule's cron/enabled. Recomputes `nextRunAt` whenever the cron changes or a disabled
 * schedule is (re-)enabled; disabling clears `nextRunAt` so the loop skips it.
 */
export async function updateSchedule(
  db: AntonDb,
  clock: Clock,
  id: string,
  patch: UpdateSchedulePatch,
): Promise<void> {
  const rows = await db.select().from(schema.schedules).where(eq(schema.schedules.id, id)).limit(1);
  const current = rows[0];
  if (!current) throw new Error(`schedule not found: ${id}`);

  const cron = patch.cron ?? current.cron;
  if (patch.cron !== undefined && !isValidCron(patch.cron)) {
    throw new Error(`invalid cron expression: "${patch.cron}"`);
  }
  const enabled = patch.enabled ?? current.enabled;

  const set: Partial<ScheduleRow> = { cron, enabled };
  if (!enabled) {
    set.nextRunAt = null;
  } else if (patch.cron !== undefined || (patch.enabled === true && !current.enabled)) {
    set.nextRunAt = secDate(nextRun(cron, clock.now()));
  }
  await db.update(schema.schedules).set(set).where(eq(schema.schedules.id, id));
}

/** All schedules for a project (UI read path via shared anton.db). */
export async function listSchedules(projectId: string): Promise<ScheduleSummary[]> {
  const rows = await getDb()
    .select()
    .from(schema.schedules)
    .where(eq(schema.schedules.projectId, projectId));
  return rows.map(toScheduleSummary);
}

/**
 * Sensible per-project cron defaults for the Phase 2 background jobs (anton-3t2). Seeded when a
 * project is added so the jobs run without manual setup; the (future) settings UI edits/disables
 * them. Times are local. review-fix polls often (cheap gh calls); stringer/grooming are periodic.
 */
export const DEFAULT_SCHEDULES: Array<{ type: ScheduledJobType; cron: string }> = [
  { type: "review-fix", cron: "*/15 * * * *" }, // poll open PRs every 15 min
  { type: "nightly-stringer", cron: "0 3 * * *" }, // scan + triage nightly at 03:00
  { type: "orphan-grooming", cron: "0 4 * * 1" }, // bucket loose tickets weekly, Mon 04:00
];

/** Idempotently seed the default schedules for a project (no-op for types it already has). */
export async function seedDefaultSchedules(
  db: AntonDb,
  clock: Clock,
  projectId: string,
): Promise<void> {
  for (const d of DEFAULT_SCHEDULES) {
    await ensureSchedule(db, clock, { projectId, type: d.type, cron: d.cron });
  }
}

/**
 * Idempotently ensure a project has a schedule of `type` — used to seed sensible defaults without
 * duplicating on every boot. Returns the existing or newly-created schedule id.
 */
export async function ensureSchedule(
  db: AntonDb,
  clock: Clock,
  input: CreateScheduleInput,
): Promise<string> {
  const existing = await db
    .select()
    .from(schema.schedules)
    .where(and(eq(schema.schedules.projectId, input.projectId), eq(schema.schedules.type, input.type)))
    .limit(1);
  if (existing[0]) return existing[0].id;
  return createSchedule(db, clock, input);
}
