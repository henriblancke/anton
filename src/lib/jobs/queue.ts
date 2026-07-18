/**
 * The durable job queue (anton-dzh.1). Thin, testable persistence over the `jobs` table:
 * enqueue, atomically lease due/reclaimable jobs, renew leases, and settle (complete / reschedule
 * / park). The runner (runner.ts) layers the durability *policy* on top. See DESIGN.md §4.
 *
 * All ops take an explicit `db` + `Clock` so the runner and tests can inject a temp DB / fake
 * clock. Times are stored as unix SECONDS (the schema's timestamp mode); this module works in ms
 * and converts at the boundary.
 */
import { and, eq, gt, inArray, isNull, lte, not, notInArray, or, sql } from "drizzle-orm";
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
 * `parked`  — exhausted its retry budget or hit a permanent error; paused awaiting a human.
 *             NOT terminal — `resumeJob` returns it to `queued` with a fresh attempt budget so a
 *             transient failure that ran out of retries is recoverable, not a dead end (anton-ner.2).
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

/** The `epicBeadId` carried in a job's payload, or undefined if absent/malformed. */
function epicBeadIdOf(payloadJson: string | null): string | undefined {
  try {
    const parsed = JSON.parse(payloadJson ?? "{}") as { epicBeadId?: unknown };
    return typeof parsed.epicBeadId === "string" ? parsed.epicBeadId : undefined;
  } catch {
    return undefined;
  }
}

/** Id of the currently-active execute-epic job for this project + epic, if any. */
export function activeExecuteEpicId(
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
 *
 * `exclude` drops job ids that are already dispatched in-process (rolling dispatch keeps them in the
 * runner's `inFlight` set while their handler runs). Without it, a still-running job whose lease
 * lapsed — a missed renewal from laptop sleep or a transient DB failure — would look reclaimable and
 * get leased a second time, running two handlers against the same job/worktree. Excluding it here
 * also avoids burning an attempt and overwriting its live lease.
 *
 * `excludeBucketKeys` filters out whole `(type, projectId)` buckets — keyed by `scheduleGateKey` — at
 * the SQL level, BEFORE the finite scan window. This is the starvation guard for hard-held buckets
 * (a disabled schedule or an autonomy-off project, both cap 0): `capOf` alone would let their jobs
 * fill the earliest-by-`runAt` scan window and be skipped, so every tick keeps re-scanning the same
 * gated prefix and never reaches leasable work for other schedules/projects (anton-7l7). Excluding
 * them in the query paginates past them instead. `capOf` still enforces the cap as a backstop.
 */
export async function leaseDue(
  db: AntonDb,
  clock: Clock,
  opts: {
    leaseMs: number;
    limit: number;
    capOf?: (job: JobRow) => number;
    exclude?: Iterable<string>;
    excludeBucketKeys?: Iterable<string>;
  },
): Promise<JobRow[]> {
  const nowMs = clock.now();
  const nowDate = secDate(nowMs);
  const leaseDate = secDate(nowMs + opts.leaseMs);
  const excludeIds = opts.exclude ? [...opts.exclude] : [];
  const excludeBuckets = opts.excludeBucketKeys ? [...opts.excludeBucketKeys] : [];

  // Without per-bucket caps, the DB `limit` alone bounds the result. With caps we must scan more
  // candidates than `limit` (some get skipped for being at capacity), so widen the fetch.
  const scanLimit = opts.capOf ? Math.max(opts.limit * 8, 200) : opts.limit;
  const runnable = or(
    and(eq(schema.jobs.status, "queued"), lte(schema.jobs.runAt, nowDate)),
    and(eq(schema.jobs.status, "running"), lte(schema.jobs.leaseExpiresAt, nowDate)),
  );
  // Drop hard-held buckets before the scan window so they can't crowd out leasable work. Each key is
  // `scheduleGateKey(type, projectId)`; an empty projectId segment means the null-project bucket.
  const heldBucketFilter =
    excludeBuckets.length > 0
      ? not(
          or(
            ...excludeBuckets.map((key) => {
              const [type, projectId] = key.split("\0");
              return and(
                eq(schema.jobs.type, type),
                projectId === "" ? isNull(schema.jobs.projectId) : eq(schema.jobs.projectId, projectId),
              );
            }),
          )!,
        )
      : undefined;
  const where = and(
    runnable,
    excludeIds.length > 0 ? notInArray(schema.jobs.id, excludeIds) : undefined,
    heldBucketFilter,
  );
  const candidates = await db
    .select()
    .from(schema.jobs)
    .where(where)
    .orderBy(schema.jobs.runAt)
    .limit(scanLimit);

  if (candidates.length === 0) return [];

  let due = candidates;
  if (opts.capOf) {
    const capOf = opts.capOf;
    // Count the live load a new lease competes with, per bucket. A `running` job counts if its lease
    // hasn't expired OR it's still dispatched in-process (in `exclude`): an in-flight handler whose
    // DB lease lapsed (missed heartbeat) is filtered out of the lease candidates above but is still
    // genuinely occupying its bucket, so it must count toward the cap — otherwise a spare-capacity
    // tick would lease a second job for a project already at its concurrency limit. The two
    // conditions are OR'd in one query so a job that's both leased-and-unexpired and in-flight is
    // counted once, not twice. Only gated buckets are tracked. Buckets are keyed by (type, project)
    // so a cap on one job type — execute-epic concurrency, or a disabled schedule's cap-0 — never
    // counts against a different type sharing the same project (anton-7l7).
    const bucketKey = (type: string, projectId: string | null) => `${type}\0${projectId ?? ""}`;
    const liveLoad =
      excludeIds.length > 0
        ? or(gt(schema.jobs.leaseExpiresAt, nowDate), inArray(schema.jobs.id, excludeIds))
        : gt(schema.jobs.leaseExpiresAt, nowDate);
    const active = await db
      .select({ projectId: schema.jobs.projectId, type: schema.jobs.type })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.status, "running"), liveLoad));
    const usedByBucket = new Map<string, number>();
    for (const row of active) {
      if (capOf(row as JobRow) === Infinity) continue;
      const key = bucketKey(row.type, row.projectId);
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
      const key = bucketKey(job.type, job.projectId);
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

/**
 * Park the job: it exhausted its retry budget or hit a permanent error, so pause it for a human.
 * NOT terminal — `resumeJob` is the un-park path. Quota hits reschedule (see `reschedule`) and
 * must never reach here; only plain-error exhaustion and `PoisonError` park (anton-ner.2).
 */
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

/**
 * Un-park a parked job — the recovery path a human (or the manual-resume UI, anton's separate
 * ticket) triggers. Returns a `parked` job to `queued`, due now, with `attempts` reset to 0 so it
 * gets a fresh retry budget rather than parking again on the next failure. This is what stops a
 * transient error that exhausted maxAttempts from being a permanent dead end (anton-ner.2).
 *
 * Un-parks a `parked` job or a `failed` (reserved terminal) one; a no-op for anything else (returns
 * false) — resuming a running/done/queued job would corrupt its lifecycle. The status guard is
 * applied in the UPDATE's WHERE so a concurrent settle can't race it between the read and the write.
 */
export async function resumeJob(db: AntonDb, clock: Clock, jobId: string): Promise<boolean> {
  const nowMs = clock.now();
  const job = await getJob(db, jobId);
  // Only a settled-but-recoverable job un-parks: `parked` (retry budget exhausted / permanent error
  // a human resolved) or `failed` (reserved terminal). A running/queued/done job must not be reset —
  // that would corrupt its lifecycle or duplicate work.
  if (!job || (job.status !== "parked" && job.status !== "failed")) return false;

  // Un-parking returns the job to `queued` — an active status. For execute-epic that competes with
  // `jobs_active_epic_unique`: after this job parked/failed, the dedupe path (which ignores
  // parked/failed) may have already spawned a fresh queued/running job for the same project + epic.
  // Reviving this stale row would then be a *second* active job for that epic and raise UNIQUE. So
  // no-op instead of surfacing a 500 — the fresh job already covers the work (anton-ner).
  if (job.type === "execute-epic" && job.projectId) {
    const epicBeadId = epicBeadIdOf(job.payloadJson);
    if (epicBeadId && activeExecuteEpicId(db, job.projectId, epicBeadId)) return false;
  }

  try {
    await db
      .update(schema.jobs)
      .set({
        status: "queued",
        runAt: secDate(nowMs),
        leaseExpiresAt: null,
        attempts: 0,
        lastError: null,
        updatedAt: secDate(nowMs),
      })
      // Re-assert the resumable status in the WHERE so a concurrent settle can't race it between the
      // read above and this write.
      .where(and(eq(schema.jobs.id, jobId), inArray(schema.jobs.status, ["parked", "failed"])));
  } catch (e) {
    // Backstop for the race the check above can't fully close: a concurrent enqueue could win the
    // active slot between the check and this write. Absorb the index violation as a clean no-op.
    if (isUniqueViolation(e)) return false;
    throw e;
  }
  return true;
}

/**
 * Ids of a project's active (`queued`|`running`) jobs. Project teardown (anton-adt) uses this to
 * find what must be aborted/removed before the project's rows and worktrees are deleted.
 */
export async function activeJobIdsForProject(db: AntonDb, projectId: string): Promise<string[]> {
  const rows = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.projectId, projectId),
        inArray(schema.jobs.status, [...ACTIVE_STATUSES]),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Delete a project's active (`queued`|`running`) job rows so nothing can re-lease its work
 * mid-teardown (anton-adt). Settled rows (done/parked/failed) are left for the caller's full
 * project-row delete — they hold no lease and can't be claimed.
 */
export async function deleteActiveJobsForProject(db: AntonDb, projectId: string): Promise<void> {
  await db
    .delete(schema.jobs)
    .where(
      and(
        eq(schema.jobs.projectId, projectId),
        inArray(schema.jobs.status, [...ACTIVE_STATUSES]),
      ),
    );
}

export async function getJob(db: AntonDb, jobId: string): Promise<JobRow | undefined> {
  const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  return rows[0];
}

/**
 * Boot reconciliation (anton-nbd): the runner is single-process, so at startup nothing is actually
 * in flight — every `running` row is a lease orphaned by the previous process's crash/restart.
 * Expire their leases (set `leaseExpiresAt` to now) so the very next `leaseDue` tick reclaims and
 * re-dispatches them immediately, instead of waiting out the full `leaseMs` window. Returns the
 * number of orphaned leases cleared. Idempotent — a second call finds nothing running.
 */
export async function reclaimRunningJobs(db: AntonDb, clock: Clock): Promise<number> {
  const nowDate = secDate(clock.now());
  const orphaned = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(eq(schema.jobs.status, "running"));
  if (orphaned.length === 0) return 0;
  await db
    .update(schema.jobs)
    .set({ leaseExpiresAt: nowDate, updatedAt: nowDate })
    .where(eq(schema.jobs.status, "running"));
  return orphaned.length;
}

/**
 * The set of `${projectId}::${epicBeadId}` keys for execute-epic jobs that are still active
 * (`queued` or `running`) — i.e. runs that a reclaim will resume. Used at boot to tell a genuinely
 * orphaned `runs` row (no job will ever resume it) from one whose job is about to be re-dispatched,
 * so run reconciliation doesn't fail a run that's coming back (anton-nbd).
 */
export async function activeExecuteEpicKeys(db: AntonDb): Promise<Set<string>> {
  const rows = await db
    .select({ projectId: schema.jobs.projectId, payloadJson: schema.jobs.payloadJson })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.type, "execute-epic"),
        inArray(schema.jobs.status, ["queued", "running"]),
      ),
    );
  const keys = new Set<string>();
  for (const row of rows) {
    let epicBeadId: string | undefined;
    try {
      const parsed = JSON.parse(row.payloadJson ?? "{}") as { epicBeadId?: unknown };
      if (typeof parsed.epicBeadId === "string") epicBeadId = parsed.epicBeadId;
    } catch {
      // malformed payload — can't key it; skip (its run, if any, will reconcile as orphaned)
    }
    if (epicBeadId) keys.add(`${row.projectId ?? ""}::${epicBeadId}`);
  }
  return keys;
}

/** Key a job's schedule gate by `(type, projectId)` — the grain a `schedules` row is keyed on. */
export function scheduleGateKey(type: string, projectId: string | null | undefined): string {
  return `${type}\0${projectId ?? ""}`;
}

/**
 * The set of `scheduleGateKey(type, projectId)` for schedules that are currently DISABLED. The
 * runner uses this to gate at *claim* (anton-7l7): a disabled schedule stops its already-queued or
 * backoff/quota-rescheduled jobs from being leased, not just new enqueues. Mirrors the autonomy
 * master-switch, but keyed on the schedule instead of a per-project policy, so it covers every
 * scheduled job type (review-fix, nightly-stringer, orphan-grooming). Re-enabling clears the key,
 * so the still-queued job resumes on the next tick.
 */
export async function disabledScheduleKeys(db: AntonDb): Promise<Set<string>> {
  const rows = await db
    .select({ type: schema.schedules.type, projectId: schema.schedules.projectId })
    .from(schema.schedules)
    .where(eq(schema.schedules.enabled, false));
  return new Set(rows.map((r) => scheduleGateKey(r.type, r.projectId)));
}
