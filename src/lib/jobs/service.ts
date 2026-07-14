/**
 * The process-wide job runner + scheduler singletons (anton-dzh/anton-3t2). Constructed once over
 * the shared anton.db, with every job handler registered and the cron scheduler wired in. Started
 * from `src/instrumentation.ts` on server boot; API routes enqueue through the runner. See DESIGN §4.
 */
import { getDb } from "../db";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_JOB_TIMEOUT_MINUTES,
  DEFAULT_MAX_RETRIES,
  getProjectSettings,
} from "../projects";
import { makeExecuteEpicHandler } from "./execute-epic";
import { makeReviewFixHandler } from "./review-fix";
import { makeNightlyStringerHandler } from "./nightly-stringer";
import { makeOrphanGroomingHandler } from "./orphan-grooming";
import { JobRunner, type RunnerLogger } from "./runner";
import { Scheduler } from "./scheduler";
import { getJob, systemClock } from "./queue";

const log: RunnerLogger = {
  info: (msg, meta) => console.log(`[jobs] ${msg}`, meta ?? ""),
  error: (msg, meta) => console.error(`[jobs] ${msg}`, meta ?? ""),
};

let _runner: JobRunner | null = null;
let _scheduler: Scheduler | null = null;

/**
 * Global ceiling on total in-flight jobs across all projects — a safety bound above the per-project
 * caps. Override with ANTON_MAX_CONCURRENT. Must be ≥ the largest project concurrency to not
 * bottleneck it (default 8 comfortably covers the 1–6 per-project range).
 */
const GLOBAL_MAX_CONCURRENT = Number(process.env.ANTON_MAX_CONCURRENT) || 8;

/** Read a project's job policy from its settings, filling in defaults for any unset field. */
async function resolvePolicy(projectId: string | undefined) {
  const settings = projectId ? await getProjectSettings(getDb(), projectId) : {};
  return {
    concurrency: settings.concurrency ?? DEFAULT_CONCURRENCY,
    timeoutMs: (settings.jobTimeoutMinutes ?? DEFAULT_JOB_TIMEOUT_MINUTES) * 60_000,
    maxAttempts: settings.maxRetries ?? DEFAULT_MAX_RETRIES,
  };
}

export function getRunner(): JobRunner {
  if (_runner) return _runner;
  const db = getDb();
  const runner = new JobRunner({
    db,
    clock: systemClock,
    log,
    config: { maxConcurrent: GLOBAL_MAX_CONCURRENT },
    resolvePolicy,
  });
  runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db }));
  runner.registerHandler("review-fix", makeReviewFixHandler({ db }));
  runner.registerHandler("nightly-stringer", makeNightlyStringerHandler({ db }));
  runner.registerHandler("orphan-grooming", makeOrphanGroomingHandler({ db }));
  _runner = runner;
  return runner;
}

export function getScheduler(): Scheduler {
  if (_scheduler) return _scheduler;
  _scheduler = new Scheduler({ db: getDb(), clock: systemClock, log });
  return _scheduler;
}

/**
 * Idempotent: reconcile crash-orphaned jobs/runs (anton-nbd), then start the background runner loop
 * + the cron scheduler. Call once at server boot. Reconciliation runs before the loop so a restart
 * re-dispatches in-flight work on the first tick rather than after a lease window; it's best-effort
 * and never blocks startup.
 */
export async function startRunner(): Promise<void> {
  await getRunner().reconcile();
  getRunner().start();
  getScheduler().start();
}

/**
 * Enqueue an execute-epic job for an approved epic. Returns the job id — the existing one when an
 * active (queued|running) run for this epic already exists, so a double approval or retrigger can't
 * spawn duplicate concurrent runs (anton-761).
 */
export function enqueueExecuteEpic(projectId: string, epicBeadId: string): Promise<string> {
  return Promise.resolve(getRunner().enqueueExecuteEpic(projectId, epicBeadId));
}

/**
 * Un-park a parked/failed job from the UI (anton-ner.4). Scoped to the project so a route can't
 * resume another project's job by id. Returns true if a resumable job was returned to `queued`
 * (the runner re-leases it next tick), false if the job doesn't exist, isn't in this project, or
 * isn't in a resumable state (already queued/running/done → rejected no-op).
 */
export async function resumeJob(projectId: string, jobId: string): Promise<boolean> {
  const job = await getJob(getDb(), jobId);
  if (!job || job.projectId !== projectId) return false;
  return getRunner().resume(jobId);
}
