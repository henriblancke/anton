/**
 * Read-only access to the machine-local `runs` table. Runs are execution plumbing (worktree,
 * lease, model, agent); stage/PR live in beads. See DESIGN.md §3.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
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

/** A single run's summary for the read path (UI/API). Scoped to the project to avoid id leaks. */
export async function getRunSummary(
  projectId: string,
  runId: string,
): Promise<RunSummary | undefined> {
  const rows = await getDb()
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.projectId, projectId), eq(schema.runs.id, runId)))
    .limit(1);
  return rows[0] ? toSummary(rows[0]) : undefined;
}

/** Full run summary including its lease/error/attempts, for the run meta grid. */
export interface RunDetail extends RunSummary {
  leaseExpiresAt?: number;
  error?: string;
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
