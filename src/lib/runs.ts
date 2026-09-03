/**
 * Read-only access to the machine-local `runs` table. Runs are execution plumbing (worktree,
 * lease, model, agent); stage/PR live in beads. See DESIGN.md §3.
 */
import { and, count, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { AntonDb, Clock } from "./jobs/queue";
import {
  ACTIVE_RUN_STATUSES,
  type RunDetail,
  type RunStatus,
  type RunSummary,
} from "@/components/runs/run-view-utils";

/**
 * The run vocabulary is declared once, in the client-safe module, and imported here — never the
 * reverse (anton-f3qj). Re-exported so server callers keep asking `@/lib/runs` for it.
 */
export type { RunDetail, RunStatus, RunSummary };

export type RunRow = typeof schema.runs.$inferSelect;

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
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

function toDetail(row: typeof schema.runs.$inferSelect): RunDetail {
  return {
    ...toSummary(row),
    leaseExpiresAt: toEpoch(row.leaseExpiresAt),
    attemptStartedAt: toEpoch(row.attemptStartedAt),
    error: row.error ?? undefined,
    jobId: row.jobId ?? undefined,
    reviewScore: row.reviewScore ?? undefined,
    formula: row.formula ?? undefined,
    formulaVariant: row.formulaVariant ?? undefined,
  };
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
  return row ? toDetail(row) : undefined;
}

// ── Write path (anton-dzh.5): db-injectable so the runner/tests share one connection ──

/**
 * The next value of the `runs.write_seq` counter, taken inside the statement that writes the row —
 * SQLite serializes writers, so MAX+1 is atomic there and needs no separate sequence table.
 *
 * Stamped by EVERY write path below, without exception: the column is only settlement order
 * (see its note in schema.ts) because a settled run's last write is its settlement, and a write
 * that skipped the stamp would leave that run ordered by the second-granular proxy instead.
 */
function nextWriteSeq() {
  return sql`(SELECT IFNULL(MAX(w.write_seq), 0) + 1 FROM runs w)`;
}

export interface CreateRunInput {
  id: string;
  projectId: string;
  epicBeadId: string;
  /** The execute-epic job starting this attempt (anton-rgso) — see the column's own note. */
  jobId?: string;
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
    jobId: input.jobId,
    ticketBeadId: input.ticketBeadId,
    worktreePath: input.worktreePath,
    branch: input.branch,
    model: input.model,
    agentTag: input.agentTag,
    status: input.status ?? "running",
    startedAt: secDate(nowMs),
    attemptStartedAt: secDate(nowMs),
    updatedAt: secDate(nowMs),
    writeSeq: nextWriteSeq(),
  });
  return input.id;
}

export type RunPatch = Partial<{
  status: RunStatus;
  /** Rewritten on every resume: the job behind the attempt is the one a cancel would name. */
  jobId: string | null;
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
  /** The score this attempt's review gate reported (anton-cekf) — see the column's own note. */
  reviewScore: number | null;
  /** ms; converted to seconds. Rewritten by a resume — see the column's own note. */
  attemptStartedAt: number;
  endedAt: number; // ms; converted to seconds
}>;

/** Patch a run row (touches updatedAt). Pass endedAt (ms) to close it out. */
export async function updateRun(
  db: AntonDb,
  clock: Clock,
  id: string,
  patch: RunPatch,
): Promise<void> {
  const set: Record<string, unknown> = {
    updatedAt: secDate(clock.now()),
    writeSeq: nextWriteSeq(),
  };
  for (const [k, v] of Object.entries(patch)) {
    if ((k === "endedAt" || k === "attemptStartedAt") && typeof v === "number") set[k] = secDate(v);
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
      writeSeq: nextWriteSeq(),
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
 * A project's most recently active runs, newest first (anton-d2sx). db-injectable and strictly
 * read-only, unlike {@link listRuns}, which reads the shared anton.db for the UI — this one is asked
 * by a background job, which must see the connection its caller injected.
 *
 * "How did the last few attempts go" is the one input a ranking judgment cannot get from the board:
 * a bead looks identical whether the runs against it landed or parked.
 */
export async function listRecentRuns(
  db: AntonDb,
  projectId: string,
  limit: number,
): Promise<RunSummary[]> {
  return (await recentRunRows(db, projectId, limit)).map(toSummary);
}

/**
 * The newest `limit` runs of a project, in a TOTAL order (anton-rgso).
 *
 * `updatedAt` is stored whole-second, so runs settling in the same second tie on it — and with
 * concurrent execution that is ordinary, not exotic. Left as the only key, SQLite is free to return
 * such a tie either way round, and the autopilot breakers read this list as a sequence: one
 * delivered run placed before rather than after two same-second failures resets a streak instead of
 * latching it, and at the boundary the `limit` itself would take different rows on different reads.
 *
 * `writeSeq` breaks it, and breaks it CORRECTLY: it is a global counter stamped on every write to a
 * run row, so a settled run's stamp is the instant it settled, ordered against every other run's at
 * a granularity the second-wide timestamps cannot express. Start order would only be a proxy, and a
 * proxy that inverts exactly where it is needed — a run started first can finish after one started
 * later — so a later-started delivery would sort newest and reset a streak that the failure it
 * actually settled before should have kept.
 *
 * `startedAt` and `rowid` remain behind it for the rows written before the column existed, whose
 * `writeSeq` is null: deterministic, which is the weaker property those rows can still have.
 */
function recentRunRows(
  db: AntonDb,
  projectId: string,
  limit: number,
  offset = 0,
): Promise<(typeof schema.runs.$inferSelect)[]> {
  return db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.projectId, projectId))
    .orderBy(
      desc(schema.runs.updatedAt),
      desc(schema.runs.writeSeq),
      desc(schema.runs.startedAt),
      sql`rowid desc`,
    )
    .limit(limit)
    .offset(offset);
}

/**
 * {@link listRecentRuns} with each run's ERROR and review SCORE attached (anton-rgso, anton-cekf).
 * Both autopilot breakers read a column the list view has no use for: the consecutive-failure one
 * compares failures BY their message — that is how it tells one broken environment from several hard
 * tickets — and the score-regression one judges each attempt on the score that attempt earned.
 * db-injectable and read-only, like its sibling.
 *
 * `offset` pages further back in that same total order. The score breaker needs it because it
 * collapses a target's repeat attempts onto one entry, so how many ROWS its window costs is not
 * knowable before the read (see `jobs/picker-score-breaker.ts`).
 */
export async function listRecentRunOutcomes(
  db: AntonDb,
  projectId: string,
  limit: number,
  offset = 0,
): Promise<RunDetail[]> {
  return (await recentRunRows(db, projectId, limit, offset)).map(toDetail);
}

/**
 * When work carrying each of these beads DELIVERED — in unix SECONDS, unordered.
 *
 * Read for the repair weigher alone (gardener/repair.ts): a repair's double weight lasts only until
 * the repaired bead next delivers, and a delivery that old is behind the streak the breaker walks —
 * it is not in the run window and no board read remembers it.
 *
 * TWO sources, because the run row cannot name every bead a run delivered (PR #223 review). It
 * carries one `ticketBeadId`, and a grouped run OVERWRITES it per child (jobs/execute-epic-ticket.ts
 * `openTicketSession`) — so on the rows alone a repaired child that succeeded, followed by any other
 * child, leaves no delivery at all, and its stamp goes on weighing later unrelated failures double
 * until the breaker disarms the picker early. So the rows answer for the run's TARGET and its final
 * ticket, and each ticket's own `execute` session — opened per child and settled `done` only once
 * that child's work committed — answers for the rest.
 *
 * A ticket session settles `done` on its own commit, whatever becomes of the run around it: the
 * repair the child carried was PROVEN by that landing, which is the whole test this evidence exists
 * to apply.
 *
 * Bounded by the ids handed in — the beads that actually carry a repair stamp — so an unrepaired
 * board costs no query at all.
 */
export async function listDeliveriesByBead(
  db: AntonDb,
  projectId: string,
  beadIds: readonly string[],
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (beadIds.length === 0) return out;
  const ids = [...new Set(beadIds)];
  const wanted = new Set(ids);
  const record = (id: string, at: number) => out.set(id, [...(out.get(id) ?? []), at]);
  const rows = await db
    .select({
      epicBeadId: schema.runs.epicBeadId,
      ticketBeadId: schema.runs.ticketBeadId,
      endedAt: schema.runs.endedAt,
      updatedAt: schema.runs.updatedAt,
    })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.projectId, projectId),
        eq(schema.runs.status, "done"),
        or(inArray(schema.runs.epicBeadId, ids), inArray(schema.runs.ticketBeadId, ids)),
      ),
    );
  for (const row of rows) {
    // A settled row's `updatedAt` is when it settled — the fallback for rows written before
    // `endedAt` was recorded, exactly as the breakers' own fence reads them.
    const at = toEpoch(row.endedAt) ?? toEpoch(row.updatedAt);
    if (at === undefined) continue;
    for (const id of [row.epicBeadId, row.ticketBeadId]) {
      if (id === null || !wanted.has(id)) continue;
      record(id, at);
    }
  }

  const ticketRows = await db
    .select({ beadId: schema.sessions.beadId, endedAt: schema.sessions.endedAt })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.projectId, projectId),
        eq(schema.sessions.kind, "execute"),
        eq(schema.sessions.status, "done"),
        inArray(schema.sessions.beadId, ids),
      ),
    );
  for (const row of ticketRows) {
    // `endedAt` is written with the `done` status in one update (sessions.ts `endSession`), so a
    // row without one is not a delivery this read can place in time — and a delivery it cannot
    // place is not one it may spend a repair stamp on.
    const at = toEpoch(row.endedAt);
    if (at === undefined || row.beadId === null) continue;
    record(row.beadId, at);
  }
  return out;
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
    // `updatedAt` is second-granular, so two attempts inside one second can tie; `writeSeq` — the
    // per-write counter — breaks it by which attempt actually settled last, with `startedAt` behind
    // it for rows written before that column existed.
    .orderBy(desc(schema.runs.updatedAt), desc(schema.runs.writeSeq), desc(schema.runs.startedAt))
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
        inArray(schema.runs.status, ACTIVE_RUN_STATUSES),
      ),
    )
    .orderBy(desc(schema.runs.updatedAt))
    .limit(1);
  return rows[0];
}
