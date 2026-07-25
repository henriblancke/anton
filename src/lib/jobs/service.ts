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
  resolveBudgetPolicy as resolveBudgetPolicyFromSettings,
} from "../projects";
import { beads } from "../beads/bd";
import { allIssues } from "../beads/issues";
import { preflightBd } from "../beads/bd-bin";
import { makeExecuteEpicHandler } from "./execute-epic";
import { makeReviewFixHandler } from "./review-fix";
import { makeNightlyStringerHandler } from "./nightly-stringer";
import { makeOrphanGroomingHandler } from "./orphan-grooming";
import { JobRunner, type RunnerLogger, type RunningJobInfo } from "./runner";
import { Scheduler } from "./scheduler";
import { activeExecuteEpicId, getJob, systemClock } from "./queue";
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
 * Per-project budget policy for the proactive governor (anton-szld), gated by the budget-aware
 * master-switch (anton-7mpv.1). Returns `null` unless the project has `budgetAware` turned ON — off is
 * the default — which the runner reads as "not governed": it never defers that project's work AND
 * never reads Claude usage on its behalf, so the nav usage pill isn't starved of the shared cache.
 * When on, it projects the operator's knobs onto the governor's full {@link BudgetPolicy}. A
 * project-less job is never budget-aware (empty settings → off).
 */
async function resolveBudgetPolicy(projectId: string | undefined) {
  const settings = projectId ? await getProjectSettings(getDb(), projectId) : {};
  if (!settings.budgetAware) return null;
  return resolveBudgetPolicyFromSettings(settings);
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

/**
 * Bead-label source for the runner's per-job value gate (anton-k05r): the labels of a queued
 * execute-epic job's target bead, so `jobValueScore` can rank governed work at lease time. Serves
 * off the shared issue snapshot (warm within its max-age) rather than `bd show`, so the 2s runner
 * tick never spawns bd per queued job. Returns `null` on any miss — the gate fails open on null.
 */
async function readBeadLabels(projectId: string, beadId: string): Promise<readonly string[] | null> {
  try {
    const project = await getProjectById(getDb(), projectId);
    if (!project) return null;
    const bead = (await allIssues(project.repoPath)).find((b) => b.id === beadId);
    return bead?.labels ?? null;
  } catch {
    return null;
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
    resolveBudgetPolicy,
    liveRunCheck,
    readBeadLabels,
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
  // Preflight (anton-346): resolve bd before any job can spawn it. A server launched with a PATH
  // that can't reach bd fails loud HERE with actionable guidance, instead of booting and then
  // parking execute-epic/review-fix jobs mid-run with `spawn bd ENOENT`.
  preflightBd();
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
  opts?: { bypassBudget?: boolean },
): Promise<string | undefined> {
  return getRunner().enqueueExecuteEpic(projectId, epicBeadId, opts);
}

/**
 * Enqueue an execute-epic job for an owner-changing take-over, but only when THIS instance has no
 * job for the epic yet (any status). Returns the new job id, or `undefined` when a local job already
 * covers it. Jobs are machine-local, so a take-over that reassigns the reservation from another
 * operator must give the new owner's instance its own runnable job — otherwise the approved work
 * strands with the original owner's (now-poisoning) job on a different machine (anton-i71, PR #39).
 */
export function enqueueExecuteEpicIfAbsent(
  projectId: string,
  epicBeadId: string,
  opts?: { bypassBudget?: boolean },
): Promise<string | undefined> {
  return Promise.resolve(getRunner().enqueueExecuteEpicIfAbsent(projectId, epicBeadId, opts));
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

/**
 * Live info for a running job (anton-susu): the session id + cwd its handler reported via
 * ctx.report, plus the job type. Scoped to the project so a route can't introspect another
 * project's job by id. Undefined when the job doesn't exist, belongs to another project, or is
 * not in flight on this instance (jobs are machine-local; the info clears when the job settles).
 */
export async function getRunningJobInfo(
  projectId: string,
  jobId: string,
): Promise<RunningJobInfo | undefined> {
  const job = await getJob(getDb(), jobId);
  if (!job || job.projectId !== projectId) return undefined;
  return getRunner().runningJobInfo(jobId);
}

/**
 * Batch live-info read for job ids ALREADY verified to belong to the caller's project — e.g. rows
 * from a project-scoped list query. Skips getRunningJobInfo's per-job ownership lookup (one
 * redundant DB query per running job otherwise); routes resolving an untrusted client-supplied id
 * must keep using getRunningJobInfo. Purely an in-memory runner read: ids not in flight on this
 * instance are simply absent from the result.
 */
export function getRunningJobInfos(jobIds: string[]): Record<string, RunningJobInfo> {
  const runner = getRunner();
  const infos: Record<string, RunningJobInfo> = {};
  for (const id of jobIds) {
    const info = runner.runningJobInfo(id);
    if (info) infos[id] = info;
  }
  return infos;
}

/**
 * Outcome of a project-scoped cancel, so the route can pick the right HTTP status:
 *   • `ok`              — the job was terminalized (200).
 *   • `not-found`       — no such job, or it belongs to a different project (404). Project-scoping is
 *                         enforced here so a route can't kill another project's job by id.
 *   • `not-cancellable` — the job exists in this project but is already terminal (409).
 */
export type CancelResult = { ok: true } | { ok: false; reason: "not-found" | "not-cancellable" };

/**
 * Force-kill a job from the UI (anton-a4jj). Aborts its in-flight child (when this process holds one)
 * and durably marks it `cancelled` so no durability path revives it. Scoped to the project so a route
 * can't cancel another project's job by id — a cross-project (or missing) job is `not-found`, an
 * already-terminal one is `not-cancellable`.
 */
export async function cancelJob(projectId: string, jobId: string): Promise<CancelResult> {
  const job = await getJob(getDb(), jobId);
  if (!job || job.projectId !== projectId) return { ok: false, reason: "not-found" };
  const acted = await getRunner().cancel(jobId);
  return acted ? { ok: true } : { ok: false, reason: "not-cancellable" };
}

/**
 * Force-kill the active execute-epic job for a run target, if one is live here (anton-6xj0).
 * Abandoning work whose run is still executing must stop the agent — otherwise it keeps burning
 * tokens on a ticket a human just killed and races the board writes that record the decision. Runs
 * BEFORE the beads writes so the job row is already terminal (`cancelled`) when the aborted handler
 * settles: the runner then skips its park/retry path entirely, which is what keeps an abandon from
 * being recorded as a park. Returns whether a job was killed; jobs are machine-local, so `false`
 * just means nothing was running on this instance (a run on another machine stops at its next
 * lease/ticket boundary, where the abandoned bead is skipped).
 */
export async function cancelRunForTarget(projectId: string, epicBeadId: string): Promise<boolean> {
  const jobId = activeExecuteEpicId(getDb(), projectId, epicBeadId);
  if (!jobId) return false;
  return getRunner().cancel(jobId);
}
