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
  | "review-fix"
  | "nightly-stringer"
  | "orphan-grooming"
  | "run-health"
  | "unstick"
  | "gate-check"
  | "gardener"
  | "product-master"
  | "board-picker"
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
 * Insert one schedule row. Synchronous on purpose so it composes inside a transaction — the seed
 * below needs its read and its inserts to run without an await between them (see
 * {@link seedDefaultSchedules}). Validates the cron up front (fail loud) and seeds `nextRunAt` so
 * the loop knows when it first fires.
 */
function insertSchedule(
  tx: Pick<AntonDb, "insert">,
  clock: Clock,
  input: CreateScheduleInput,
): string {
  if (!isValidCron(input.cron)) throw new Error(`invalid cron expression: "${input.cron}"`);
  const id = randomUUID();
  const enabled = input.enabled ?? true;
  const nextRunAt = enabled ? nextRun(input.cron, clock.now()) : null;
  tx.insert(schema.schedules)
    .values({
      id,
      projectId: input.projectId,
      type: input.type,
      cron: input.cron,
      enabled,
      nextRunAt: nextRunAt != null ? secDate(nextRunAt) : null,
    })
    .run();
  return id;
}

/** Create a schedule. db-injectable for the scheduler/tests. */
export async function createSchedule(
  db: AntonDb,
  clock: Clock,
  input: CreateScheduleInput,
): Promise<string> {
  return insertSchedule(db, clock, input);
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
 * project is added so the jobs run without manual setup; the settings UI edits/disables them. Times
 * are local. review-fix polls often (cheap gh calls); stringer/grooming are periodic.
 *
 * review-fix is a REVIEW-EVENT poll, not a merge poll (anton-k0kj): merges arrive as a closed
 * `gh:pr` gate via gate-check. Requested changes, review comments and red CI have no gate flavour in
 * bd, so this cadence is the one wait gates cannot replace — see review-fix.ts's header.
 *
 * `enabled: false` seeds the ROW without arming it — the operator sees the automation in settings
 * and turns it on deliberately. run-health (anton-4ks0) ships that way: it reports on work a human
 * must then judge, so an operator who never asked for it shouldn't start accruing reports. unstick
 * (anton-wvcy) is armed by default but is a strict no-op until run-health has written a report, so
 * turning the sweep on is the single switch that arms the whole detect → act loop. The alternative —
 * shipping both disabled — trades an idle hourly job (one report read, no bd, no writes) for an
 * operator who enables the sweep and silently gets findings nothing ever acts on. An operator who
 * won't use run-health can turn unstick off independently; the settings row says as much.
 *
 * gardener (anton-3nv7) ships disabled for run-health's reason and one more: it is the only recurring
 * job that WRITES to the board unprompted (it closes epics bd judges done and repairs the blocked
 * flag). An operator who never asked for a patrol should not find work closed on their board — so
 * arming it is a deliberate act, and the report it produces is what earns the trust to leave it on.
 *
 * product-master (anton-d2sx) ships disabled for both of the gardener's reasons and a third: it is
 * the only schedule that spends a claude session on judgment rather than on mechanism, and every
 * proposal it files spends a founder's attention. It runs WEEKLY rather than nightly because that is
 * the natural cadence of the question — "what matters next" does not change between two Tuesdays on
 * a board a nightly pass would find identical, and re-asking it daily is how the pass becomes noise.
 * Weekly is only the DEFAULT, not a rule: arming board-picker makes this judgment load-bearing
 * rather than advisory, so the settings panel then offers to raise it to daily (anton-3xa9). The
 * offer is an offer — nothing here moves a cadence an operator did not accept.
 *
 * board-picker (anton-albm) ships disabled for the gardener's reasons: an operator who never asked
 * for a pass should not find one running. Today it DECIDES ONLY — it ranks the claimable set and
 * records the plan, writing nothing to the board and starting nothing — so arming it buys the
 * ranking, kept fresh, and nothing else. Starting a target off that plan is the arming feature's job
 * and lands behind its own switch. Ten minutes because the pass is mechanical — a board read and a
 * ranking, no Claude session — so the cadence is only how stale the recorded plan may get.
 *
 * gate-check (anton-286r) is armed by default and runs often, because it is the ONLY thing that
 * resumes a run parked on a gate: shipping it off would strand gated work indefinitely, and its
 * idle cost is two bd reads per slot on a project with no gates. The cadence is the wait's
 * resolution — a CI run that goes green at :01 resumes at :10, not the next hour.
 */
export const DEFAULT_SCHEDULES: Array<{
  type: ScheduledJobType;
  cron: string;
  enabled?: boolean;
}> = [
  { type: "review-fix", cron: "*/15 * * * *" }, // poll open PRs for review events every 15 min
  { type: "nightly-stringer", cron: "0 3 * * *" }, // scan + triage nightly at 03:00
  { type: "orphan-grooming", cron: "0 4 * * 1" }, // bucket loose tickets weekly, Mon 04:00
  { type: "run-health", cron: "0 * * * *", enabled: false }, // sweep for stalls hourly; opt-in
  { type: "unstick", cron: "10 * * * *" }, // act on the sweep's findings, 10 min after it
  { type: "gate-check", cron: "*/10 * * * *" }, // close satisfied gates + resume their work
  { type: "gardener", cron: "0 5 * * *", enabled: false }, // board hygiene patrol daily 05:00; opt-in
  { type: "product-master", cron: "0 6 * * 1", enabled: false }, // product judgment weekly, Mon 06:00; opt-in
  { type: "board-picker", cron: "*/10 * * * *", enabled: false }, // rank the board, record a plan; opt-in
];

/**
 * Idempotently seed the default schedules for a project. Returns the types it actually created, so
 * a backfill can say what it added; a type the project already has is left exactly as the operator
 * left it — same cron, same enabled — never re-created or re-armed.
 *
 * The read-then-insert runs in ONE synchronous transaction because idempotence here is only as good
 * as its atomicity: `schedules` has no unique key on `(projectId, type)`, so two callers that
 * interleave — the boot backfill re-entered by a dev hot-reload, or a second `startRunner()` — would
 * each see the same missing types and insert them twice, and the scheduler would then enqueue every
 * duplicated slot twice. No await inside means neither can interleave.
 */
export async function seedDefaultSchedules(
  db: AntonDb,
  clock: Clock,
  projectId: string,
): Promise<ScheduledJobType[]> {
  return db.transaction((tx) => {
    const existing = new Set(
      tx
        .select({ type: schema.schedules.type })
        .from(schema.schedules)
        .where(eq(schema.schedules.projectId, projectId))
        .all()
        .map((r) => r.type),
    );

    const created: ScheduledJobType[] = [];
    for (const d of DEFAULT_SCHEDULES) {
      if (existing.has(d.type)) continue;
      insertSchedule(tx, clock, {
        projectId,
        type: d.type,
        cron: d.cron,
        enabled: d.enabled,
      });
      created.push(d.type);
    }
    return created;
  });
}

/** What a backfill added for one project — empty entries are dropped, so this is a change log. */
export interface ScheduleBackfill {
  projectId: string;
  created: ScheduledJobType[];
}

/**
 * Seed every registered project's missing default schedules — the upgrade path for schedule types
 * shipped after a project was added.
 *
 * {@link seedDefaultSchedules} otherwise runs only while INSERTING a project, and no migration
 * backfills schedule rows, so on an existing installation a newly-shipped type simply never exists:
 * turning on `run-health` from settings creates just that row and leaves `unstick` unscheduled,
 * accruing reports with nothing to act on them. Run at boot (jobs/service.ts). Safe to repeat — it
 * only inserts types the project is missing, so a schedule an operator disabled stays disabled.
 */
export async function backfillDefaultSchedules(
  db: AntonDb,
  clock: Clock,
): Promise<ScheduleBackfill[]> {
  const projects = await db.select({ id: schema.projects.id }).from(schema.projects);
  const backfills: ScheduleBackfill[] = [];
  for (const project of projects) {
    const created = await seedDefaultSchedules(db, clock, project.id);
    if (created.length > 0) backfills.push({ projectId: project.id, created });
  }
  return backfills;
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
