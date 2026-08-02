/**
 * Read-only access to the machine-local `runs` table. Runs are execution plumbing (worktree,
 * lease, model, agent); stage/PR live in beads. See DESIGN.md §3.
 */
import { and, count, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { AntonDb, Clock } from "./jobs/queue";

export type RunStatus = "queued" | "running" | "parked" | "done" | "failed";
/** Statuses a run can be in while still resumable (not terminal). */
const OPEN_RUN_STATUSES: RunStatus[] = ["queued", "running", "parked"];

export type RunRow = typeof schema.runs.$inferSelect;

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

export interface RunSummary {
  id: string;
  epicBeadId: string;
  ticketBeadId?: string;
  worktreePath?: string;
  branch?: string;
  model?: string;
  agentTag?: string;
  status: RunStatus;
  attempts: number;
  startedAt?: number;
  endedAt?: number;
  updatedAt: number;
}

function toEpoch(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  return Number(value);
}

function toSummary(row: typeof schema.runs.$inferSelect): RunSummary {
  return {
    id: row.id,
    epicBeadId: row.epicBeadId,
    ticketBeadId: row.ticketBeadId ?? undefined,
    worktreePath: row.worktreePath ?? undefined,
    branch: row.branch ?? undefined,
    model: row.model ?? undefined,
    agentTag: row.agentTag ?? undefined,
    status: row.status as RunStatus,
    attempts: row.attempts,
    startedAt: toEpoch(row.startedAt),
    endedAt: toEpoch(row.endedAt),
    updatedAt: toEpoch(row.updatedAt) ?? 0,
  };
}

export async function listRuns(projectId: string): Promise<RunSummary[]> {
  const rows = await getDb()
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.projectId, projectId))
    .orderBy(desc(schema.runs.updatedAt));
  return rows.map(toSummary);
}

/** Total run rows for a project — for pagination. */
export async function countRuns(projectId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: count() })
    .from(schema.runs)
    .where(eq(schema.runs.projectId, projectId));
  return rows[0]?.n ?? 0;
}

/** One page of runs, newest activity first. */
export async function listRunsPaged(
  projectId: string,
  opts: { limit: number; offset: number },
): Promise<RunSummary[]> {
  const rows = await getDb()
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.projectId, projectId))
    .orderBy(desc(schema.runs.updatedAt))
    .limit(opts.limit)
    .offset(opts.offset);
  return rows.map(toSummary);
}

/** Full run summary including its lease/error/attempts, for the run meta grid. */
export interface RunDetail extends RunSummary {
  leaseExpiresAt?: number;
  error?: string;
  /** The pipeline this run walked — the formula file it was read from (anton-aa3m). */
  formula?: string;
  /** The bead label that selected that pipeline; absent ⇒ the project/bundled default. */
  formulaVariant?: string;
}

export async function getRunDetail(
  projectId: string,
  runId: string,
): Promise<RunDetail | undefined> {
  const rows = await getDb()
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.projectId, projectId), eq(schema.runs.id, runId)))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return {
    ...toSummary(row),
    leaseExpiresAt: toEpoch(row.leaseExpiresAt),
    error: row.error ?? undefined,
    formula: row.formula ?? undefined,
    formulaVariant: row.formulaVariant ?? undefined,
  };
}

// ── Write path (anton-dzh.5): db-injectable so the runner/tests share one connection ──

export interface CreateRunInput {
  id: string;
  projectId: string;
  epicBeadId: string;
  ticketBeadId?: string;
  worktreePath?: string;
  branch?: string;
  model?: string;
  agentTag?: string;
  status?: RunStatus;
}

/** Record a run at the start of execution (status defaults to `running`, startedAt = now). */
export async function createRun(db: AntonDb, clock: Clock, input: CreateRunInput): Promise<string> {
  const nowMs = clock.now();
  await db.insert(schema.runs).values({
    id: input.id,
    projectId: input.projectId,
    epicBeadId: input.epicBeadId,
    ticketBeadId: input.ticketBeadId,
    worktreePath: input.worktreePath,
    branch: input.branch,
    model: input.model,
    agentTag: input.agentTag,
    status: input.status ?? "running",
    startedAt: secDate(nowMs),
    updatedAt: secDate(nowMs),
  });
  return input.id;
}

export type RunPatch = Partial<{
  status: RunStatus;
  ticketBeadId: string | null;
  worktreePath: string | null;
  branch: string | null;
  model: string | null;
  agentTag: string | null;
  /** The pipeline this run walked (anton-aa3m) — written once the formula is selected + validated. */
  formula: string | null;
  formulaVariant: string | null;
  attempts: number;
  error: string | null;
  endedAt: number; // ms; converted to seconds
}>;

/** Patch a run row (touches updatedAt). Pass endedAt (ms) to close it out. */
export async function updateRun(
  db: AntonDb,
  clock: Clock,
  id: string,
  patch: RunPatch,
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: secDate(clock.now()) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "endedAt" && typeof v === "number") set.endedAt = secDate(v);
    else set[k] = v;
  }
  await db.update(schema.runs).set(set).where(eq(schema.runs.id, id));
}

/**
 * Settle a still-PARKED run as `failed` — the run-row half of abandoning the work it was executing
 * (anton-wvcy). Nothing re-dispatches a parked run, so one whose bead has just been abandoned would
 * otherwise sit exactly as `detectParkedRuns` sees it and be escalated again on every sweep, now
 * against a closed target. Both the project and the `parked` status are re-asserted in the WHERE, so
 * this is a CAS: a run an operator resumed since the decision keeps running, and no other project's
 * run can be settled by id. Returns whether it settled one.
 */
export async function settleParkedRun(
  db: AntonDb,
  clock: Clock,
  projectId: string,
  runId: string,
  reason: string,
): Promise<boolean> {
  const nowMs = clock.now();
  const settled = await db
    .update(schema.runs)
    .set({
      status: "failed",
      error: reason,
      endedAt: secDate(nowMs),
      updatedAt: secDate(nowMs),
    })
    .where(
      and(
        eq(schema.runs.id, runId),
        eq(schema.runs.projectId, projectId),
        eq(schema.runs.status, "parked"),
      ),
    )
    .returning({ id: schema.runs.id });
  return settled.length > 0;
}

export async function getRunById(db: AntonDb, id: string): Promise<RunRow | undefined> {
  const rows = await db.select().from(schema.runs).where(eq(schema.runs.id, id)).limit(1);
  return rows[0];
}

/**
 * Boot reconciliation (anton-nbd): a `runs` row left in `running` after a crash is only genuinely
 * orphaned if no execute-epic job will resume it. `activeKeys` holds `${projectId}::${epicBeadId}`
 * for every still-active job (see `activeExecuteEpicKeys`); a running run whose key is present is
 * about to be re-dispatched and MUST be left alone (touching it would break the idempotent resume —
 * `findOpenRunForEpic` reuses the same row). Any other running run has no job coming back, so mark
 * it `failed` (`interrupted`) — that clears the stale "running" from the UI. Returns the count
 * reconciled. Runs that are already `parked` are left as-is (their job resumes or a human un-parks).
 */
export async function reconcileInterruptedRuns(
  db: AntonDb,
  clock: Clock,
  activeKeys: Set<string>,
): Promise<number> {
  const running = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.status, "running"));
  const orphaned = running.filter(
    (r) => !activeKeys.has(`${r.projectId ?? ""}::${r.epicBeadId}`),
  );
  const nowMs = clock.now();
  for (const run of orphaned) {
    await updateRun(db, clock, run.id, {
      status: "failed",
      error: "interrupted by server restart",
      endedAt: nowMs,
    });
  }
  return orphaned.length;
}

/**
 * Every run of a project in the given statuses, oldest activity first (anton-4ks0). The read the
 * run-health sweep detects over — `updatedAt` on a settled run is when it settled, so ordering by
 * it puts the most-stalled work first. db-injectable; strictly read-only.
 */
export async function listRunsByStatus(
  db: AntonDb,
  projectId: string,
  statuses: readonly RunStatus[],
): Promise<RunRow[]> {
  if (statuses.length === 0) return [];
  return db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.projectId, projectId), inArray(schema.runs.status, [...statuses])))
    .orderBy(schema.runs.updatedAt);
}

/** The pipeline choice a run recorded (anton-aa3m) — what a later attempt on the same branch pins to. */
export interface RecordedFormula {
  /**
   * The formula that run walked: an absolute path for a project-local pipeline, or the
   * `bundled:` sentinel for anton's own asset (whose path belongs to the install, not the project —
   * see `BUNDLED_FORMULA_SOURCE`).
   */
  source: string;
  /** The bead label that selected it; absent ⇒ the project/bundled default. */
  variant?: string;
}

/**
 * The pipeline the most recent attempt on this epic's BRANCH recorded, whatever became of that run.
 *
 * A run's pipeline is chosen once and honored for the life of the work, not re-selected per attempt
 * — but attempts do not all share a run row. An ordinary handler error settles the row `failed`, and
 * `findOpenRunForEpic` returns only open ones, so the runner's automatic retry gets a FRESH row while
 * reusing the prior attempt's worktree and skipping the tickets it already committed. Selecting again
 * there would let a label or a variant mapping edited during the retry backoff switch pipelines
 * mid-branch: the committed tickets walked one formula, the rest walk another.
 *
 * So the branch is the unit of continuity — the same thing the retry itself resumes by. A run on a
 * branch no prior run recorded a formula for (a first run, or a new branch prefix) selects normally.
 */
export async function findRunFormulaForBranch(
  db: AntonDb,
  projectId: string,
  epicBeadId: string,
  branch: string,
): Promise<RecordedFormula | undefined> {
  const rows = await db
    .select()
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.projectId, projectId),
        eq(schema.runs.epicBeadId, epicBeadId),
        eq(schema.runs.branch, branch),
        isNotNull(schema.runs.formula),
      ),
    )
    // `updatedAt` is second-granular, so two attempts inside one second can tie; `startedAt` breaks it.
    .orderBy(desc(schema.runs.updatedAt), desc(schema.runs.startedAt))
    .limit(1);
  const row = rows[0];
  if (!row?.formula) return undefined;
  return { source: row.formula, variant: row.formulaVariant ?? undefined };
}

/** The most-recent still-open run for an epic — used to resume rather than start a duplicate. */
export async function findOpenRunForEpic(
  db: AntonDb,
  projectId: string,
  epicBeadId: string,
): Promise<RunRow | undefined> {
  const rows = await db
    .select()
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.projectId, projectId),
        eq(schema.runs.epicBeadId, epicBeadId),
        inArray(schema.runs.status, OPEN_RUN_STATUSES),
      ),
    )
    .orderBy(desc(schema.runs.updatedAt))
    .limit(1);
  return rows[0];
}
