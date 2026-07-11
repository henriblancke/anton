/**
 * The durable job queue (anton-dzh.1). Thin, testable persistence over the `jobs` table:
 * enqueue, atomically lease due/reclaimable jobs, renew leases, and settle (complete / reschedule
 * / park). The runner (runner.ts) layers the durability *policy* on top. See DESIGN.md §4.
 *
 * All ops take an explicit `db` + `Clock` so the runner and tests can inject a temp DB / fake
 * clock. Times are stored as unix SECONDS (the schema's timestamp mode); this module works in ms
 * and converts at the boundary.
 */
import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
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

/**
 * Atomically lease up to `limit` runnable jobs and return them. Runnable =
 *   • `queued` and due (runAt ≤ now), OR
 *   • `running` but the lease expired (crashed worker → reclaim).
 * Leasing sets status=`running`, a fresh lease, and increments `attempts`.
 *
 * The runner is single-process, so a read-then-write inside one better-sqlite3 transaction is
 * sufficient mutual exclusion.
 */
export async function leaseDue(
  db: AntonDb,
  clock: Clock,
  opts: { leaseMs: number; limit: number },
): Promise<JobRow[]> {
  const nowMs = clock.now();
  const nowDate = secDate(nowMs);
  const leaseDate = secDate(nowMs + opts.leaseMs);

  const due = await db
    .select()
    .from(schema.jobs)
    .where(
      or(
        and(eq(schema.jobs.status, "queued"), lte(schema.jobs.runAt, nowDate)),
        and(eq(schema.jobs.status, "running"), lte(schema.jobs.leaseExpiresAt, nowDate)),
      ),
    )
    .orderBy(schema.jobs.runAt)
    .limit(opts.limit);

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
