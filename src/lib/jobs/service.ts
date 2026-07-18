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
  getProjectById,
  getProjectSettings,
} from "../projects";
import { beads } from "../beads/bd";
import { makeExecuteEpicHandler } from "./execute-epic";
import { makeReviewFixHandler } from "./review-fix";
import { makeNightlyStringerHandler } from "./nightly-stringer";
import { makeOrphanGroomingHandler } from "./orphan-grooming";
import { JobRunner, type RunnerLogger } from "./runner";
import { Scheduler } from "./scheduler";
import { getJob, systemClock } from "./queue";
import { startSyncEngine } from "../beads/sync-engine";

const log: RunnerLogger = {
  info: (msg, meta) => console.log(`[jobs] ${msg}`, meta ?? ""),
  error: (msg, meta) => console.error(`[jobs] ${msg}`, meta ?? ""),
};

let _runner: JobRunner | null = null;
let _scheduler: Scheduler | null = null;
let _reconciled = false;

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
    // Autonomy master-switch (anton-y3l): off pauses claiming of this project's execute-epic
    // jobs (they stay queued); absent defaults to on. See JobPolicy.autonomy in runner.ts.
    autonomy: settings.autonomy ?? true,
  };
}

/**
 * Cross-machine run-liveness source for the runner (anton-jz1). Reads the shared beads board to
 * tell whether an execute-epic run is already live for this epic on ANOTHER machine — the `jobs`
 * table is machine-local, so a Force run on machine B can't otherwise see a run executing on
 * machine A and would double-run it. Pulls the shared board FIRST: the local Dolt working set can
 * be a sync heartbeat (~30s) behind, so without a pull a lease machine A published moments ago
 * reads as absent and this gate lets B enqueue a second concurrent run — the exact race the lease
 * exists to close. Fails open (returns false) so a transient beads read never blocks a legitimate
 * run; the local dedupe + `jobs_active_epic_unique` still backstop same-machine.
 */
async function liveRunCheck(projectId: string, epicBeadId: string): Promise<boolean> {
  try {
    const project = await getProjectById(getDb(), projectId);
    if (!project) return false;
    // Best-effort: a pull failure (offline, transient) falls back to the local snapshot rather
    // than blocking the check — the same fail-open posture as the surrounding try/catch.
    await beads.pull(project.repoPath).catch(() => {});
    const bead = await beads.show(project.repoPath, epicBeadId);
    return beads.isRunLive(bead, Date.now());
  } catch {
    return false;
  }
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
    liveRunCheck,
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
 * + the cron scheduler + the beads sync engine. Meant to be called once at server boot, but tolerant
 * of re-entry (dev hot-reload, tests): reconciliation runs at most once — the first call only —
 * because it expires every `running` lease, and a second call while this process already has jobs in
 * flight would reclaim its own live leases and let the next tick dispatch those job ids a second
 * time. `start()`, the scheduler, and the sync engine are themselves idempotent. Reconciliation runs
 * before the loop so a restart re-dispatches in-flight work on the first tick rather than after a
 * lease window; it's best-effort and never blocks startup.
 */
export async function startRunner(): Promise<void> {
  if (!_reconciled) {
    // Set before awaiting so a concurrent second call can't slip past into a second reconcile.
    _reconciled = true;
    await getRunner().reconcile();
  }
  getRunner().start();
  getScheduler().start();
  startSyncEngine();
}

/**
 * Enqueue an execute-epic job for an approved epic. Returns the job id — the existing one when an
 * active (queued|running) run for this epic already exists in this store, so a double approval or
 * retrigger can't spawn duplicate concurrent runs (anton-761). Returns `undefined` when a run is
 * already live for the epic on ANOTHER machine (read from the shared beads board): nothing is
 * enqueued here because that run already covers the work (anton-jz1).
 */
export function enqueueExecuteEpic(
  projectId: string,
  epicBeadId: string,
): Promise<string | undefined> {
  return getRunner().enqueueExecuteEpic(projectId, epicBeadId);
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
