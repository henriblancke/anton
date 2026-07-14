/**
 * The durable job queue (anton-dzh.1). Thin, testable persistence over the `jobs` table:
 * enqueue, atomically lease due/reclaimable jobs, renew leases, and settle (complete / reschedule
 * / park). The runner (runner.ts) layers the durability *policy* on top. See DESIGN.md §4.
 *
 * All ops take an explicit `db` + `Clock` so the runner and tests can inject a temp DB / fake
 * clock. Times are stored as unix SECONDS (the schema's timestamp mode); this module works in ms
 * and converts at the boundary.
 */
import { and, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { randomUUID } from "node:crypto";
import * as schema from "../db/schema";

export type AntonDb = BetterSQLite3Database<typeof schema>;

export type JobType =
  | "execute-epic"
  | "review-fix"
  | "nightly-stringer"
  | "orphan-grooming";

/**
 * `queued`  — eligible when runAt ≤ now (also how a backoff/quota reschedule is represented).
 * `running` — leased by the runner; reclaimed if the lease expires (crash recovery).
 * `parked`  — poison-pill: failed maxAttempts / permanent error; waits for a human.
 * `done`    — completed successfully.
 * `failed`  — terminal, non-retryable (reserved).
 */
export type JobStatus = "queued" | "running" | "parked" | "done" | "failed";

export type JobRow = typeof schema.jobs.$inferSelect;

export interface Clock {
  /** Milliseconds since epoch. */
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

/** timestamp mode stores seconds as a Date; normalize either to ms. */
export function toMs(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return value.getTime();
  return Number(value) * 1000;
}

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

export async function enqueue(
  db: AntonDb,
  clock: Clock,
  input: {
    type: JobType;
    projectId?: string;
    payload?: unknown;
    /** ms epoch; default = now (immediately due). */
    runAt?: number;
  },
): Promise<string> {
  const id = randomUUID();
  const nowMs = clock.now();
  await db.insert(schema.jobs).values({
    id,
    type: input.type,
    projectId: input.projectId,
    payloadJson: JSON.stringify(input.payload ?? {}),
    status: "queued",
    runAt: secDate(input.runAt ?? nowMs),
    attempts: 0,
    createdAt: secDate(nowMs),
    updatedAt: secDate(nowMs),
  });
  return id;
}

/** The active statuses that must hold at most one execute-epic job per (project, epic). */
const ACTIVE_STATUSES = ["queued", "running"] as const;

/** Is `e` a SQLite UNIQUE-constraint violation (the partial-index backstop firing)? */
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT";
}

/** Id of the currently-active execute-epic job for this project + epic, if any. */
function activeExecuteEpicId(
  tx: Pick<AntonDb, "select">,
  projectId: string,
  epicBeadId: string,
): string | undefined {
  const rows = tx
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.type, "execute-epic"),
        eq(schema.jobs.projectId, projectId),
        inArray(schema.jobs.status, [...ACTIVE_STATUSES]),
        eq(sql`json_extract(${schema.jobs.payloadJson}, '$.epicBeadId')`, epicBeadId),
      ),
    )
    .limit(1)
    .all();
  return rows[0]?.id;
}

/**
 * Enqueue an execute-epic run, deduped against any already-active job for the same project + epic.
 * Returns the existing job's id (inserting no new row) when a `queued`/`running` execute-epic job
 * exists for that epic; otherwise inserts a fresh `queued` job and returns its id. Prior
 * done/parked/failed jobs don't block a new run.
 *
 * The select-existing + insert run in one better-sqlite3 transaction. That connection is single and
 * synchronous, so the read→write pair can't interleave — two near-simultaneous approvals serialize
 * and yield exactly one active job. The partial unique index `jobs_active_epic_unique` is the
 * DB-level backstop; if an insert ever races past the guard it raises UNIQUE, which we absorb by
 * returning the row that won. See anton-761.
 */
export function enqueueExecuteEpicDeduped(
  db: AntonDb,
  clock: Clock,
  projectId: string,
  epicBeadId: string,
): string {
  const nowMs = clock.now();
  try {
    return db.transaction((tx) => {
      const existing = activeExecuteEpicId(tx, projectId, epicBeadId);
      if (existing) return existing;

      const id = randomUUID();
      tx.insert(schema.jobs)
        .values({
          id,
          type: "execute-epic",
          projectId,
          payloadJson: JSON.stringify({ projectId, epicBeadId }),
          status: "queued",
          runAt: secDate(nowMs),
          attempts: 0,
          createdAt: secDate(nowMs),
          updatedAt: secDate(nowMs),
        })
        .run();
      return id;
    });
  } catch (e) {
    // Backstop: the index rejected a concurrent insert. Return the job that won the race.
    if (isUniqueViolation(e)) {
      const winner = activeExecuteEpicId(db, projectId, epicBeadId);
      if (winner) return winner;
    }
    throw e;
  }
}

/**
 * Atomically lease up to `limit` runnable jobs and return them. Runnable =
 *   • `queued` and due (runAt ≤ now), OR
 *   • `running` but the lease expired (crashed worker → reclaim).
 * Leasing sets status=`running`, a fresh lease, and increments `attempts`.
 *
 * The runner is single-process, so a read-then-write inside one better-sqlite3 transaction is
 * sufficient mutual exclusion.
 *
 * `capOf` opts in to per-bucket concurrency: for a candidate it returns the max jobs allowed to be
 * in flight in that candidate's bucket (keyed by projectId). `Infinity` means ungated (only the
 * global `limit` applies). Jobs whose bucket is already at capacity are skipped in favor of the
 * next-due job for a different bucket. Currently the runner gates execute-epic per project.
 */
export async function leaseDue(
  db: AntonDb,
  clock: Clock,
  opts: { leaseMs: number; limit: number; capOf?: (job: JobRow) => number },
): Promise<JobRow[]> {
  const nowMs = clock.now();
  const nowDate = secDate(nowMs);
  const leaseDate = secDate(nowMs + opts.leaseMs);

  // Without per-bucket caps, the DB `limit` alone bounds the result. With caps we must scan more
  // candidates than `limit` (some get skipped for being at capacity), so widen the fetch.
  const scanLimit = opts.capOf ? Math.max(opts.limit * 8, 200) : opts.limit;
  const candidates = await db
    .select()
    .from(schema.jobs)
    .where(
      or(
        and(eq(schema.jobs.status, "queued"), lte(schema.jobs.runAt, nowDate)),
        and(eq(schema.jobs.status, "running"), lte(schema.jobs.leaseExpiresAt, nowDate)),
      ),
    )
    .orderBy(schema.jobs.runAt)
    .limit(scanLimit);

  if (candidates.length === 0) return [];

  let due = candidates;
  if (opts.capOf) {
    const capOf = opts.capOf;
    // Count jobs actively in flight (running, lease not yet expired) per bucket — the live load a
    // new lease competes with. Only gated buckets are tracked.
    const active = await db
      .select({ projectId: schema.jobs.projectId, type: schema.jobs.type })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.status, "running"), gt(schema.jobs.leaseExpiresAt, nowDate)));
    const usedByBucket = new Map<string, number>();
    for (const row of active) {
      if (capOf(row as JobRow) === Infinity) continue;
      const key = row.projectId ?? "";
      usedByBucket.set(key, (usedByBucket.get(key) ?? 0) + 1);
    }

    const picked: JobRow[] = [];
    for (const job of candidates) {
      if (picked.length >= opts.limit) break;
      const cap = capOf(job);
      if (cap === Infinity) {
        picked.push(job);
        continue;
      }
      const key = job.projectId ?? "";
      const used = usedByBucket.get(key) ?? 0;
      if (used >= cap) continue; // bucket at capacity — leave queued, try the next candidate
      usedByBucket.set(key, used + 1);
      picked.push(job);
    }
    due = picked;
  }

  if (due.length === 0) return [];

  const ids = due.map((j) => j.id);
  await db
    .update(schema.jobs)
    .set({
      status: "running",
      leaseExpiresAt: leaseDate,
      attempts: sql`${schema.jobs.attempts} + 1`,
      updatedAt: nowDate,
    })
    .where(inArray(schema.jobs.id, ids));

  // Return the leased rows re-read so callers see the incremented attempts + new lease.
  return db.select().from(schema.jobs).where(inArray(schema.jobs.id, ids));
}

/**
 * Distinct project ids that currently have a `queued` or `running` job of the given type. Used by
 * the runner to know which projects' concurrency caps it must resolve before leasing. A job with
 * no project surfaces as `null`.
 */
export async function projectIdsWithPendingJobs(
  db: AntonDb,
  type: JobType,
): Promise<(string | null)[]> {
  const rows = await db
    .selectDistinct({ projectId: schema.jobs.projectId })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.type, type), inArray(schema.jobs.status, ["queued", "running"])));
  return rows.map((r) => r.projectId);
}

/** Heartbeat: extend the lease on a running job while its handler works. */
export async function renewLease(
  db: AntonDb,
  clock: Clock,
  jobId: string,
  leaseMs: number,
): Promise<void> {
  const nowMs = clock.now();
  await db
    .update(schema.jobs)
    .set({ leaseExpiresAt: secDate(nowMs + leaseMs), updatedAt: secDate(nowMs) })
    .where(eq(schema.jobs.id, jobId));
}

export async function complete(db: AntonDb, clock: Clock, jobId: string): Promise<void> {
  const nowMs = clock.now();
  await db
    .update(schema.jobs)
    .set({ status: "done", leaseExpiresAt: null, lastError: null, updatedAt: secDate(nowMs) })
    .where(eq(schema.jobs.id, jobId));
}

/**
 * Reschedule a job to run again at `runAtMs` (used for both quota backoff and retry). Returns it
 * to `queued` and clears the lease so it is picked up when due. Optionally rewinds `attempts`
 * (quota isn't the job's fault, so it shouldn't burn the poison budget).
 */
export async function reschedule(
  db: AntonDb,
  clock: Clock,
  jobId: string,
  runAtMs: number,
  opts?: { lastError?: string; refundAttempt?: boolean },
): Promise<void> {
  const nowMs = clock.now();
  await db
    .update(schema.jobs)
    .set({
      status: "queued",
      runAt: secDate(runAtMs),
      leaseExpiresAt: null,
      lastError: opts?.lastError ?? null,
      attempts: opts?.refundAttempt
        ? sql`MAX(${schema.jobs.attempts} - 1, 0)`
        : schema.jobs.attempts,
      updatedAt: secDate(nowMs),
    })
    .where(eq(schema.jobs.id, jobId));
}

/** Poison-pill: park the job for a human. Terminal until manually retried. */
export async function park(
  db: AntonDb,
  clock: Clock,
  jobId: string,
  lastError: string,
): Promise<void> {
  const nowMs = clock.now();
  await db
    .update(schema.jobs)
    .set({ status: "parked", leaseExpiresAt: null, lastError, updatedAt: secDate(nowMs) })
    .where(eq(schema.jobs.id, jobId));
}

export async function getJob(db: AntonDb, jobId: string): Promise<JobRow | undefined> {
  const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  return rows[0];
}
