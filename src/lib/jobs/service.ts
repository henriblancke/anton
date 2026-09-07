/**
 * anton's public job API (anton-dzh/anton-3t2): the project-scoped verbs API routes, server
 * components and lib callers use to enqueue, resume, introspect and cancel jobs. Every one of them
 * routes through the process-wide runner singleton, which — with the scheduler, the boot lifecycle,
 * the handler table and the policy sources — lives in ./service-runner and its siblings. Kept thin
 * on purpose (anton-6fo2): a new job type or a new boot preflight must not widen this module.
 */
import { getDb } from "../db";
import { activeExecuteEpicId, getJob, systemClock } from "./queue";
import { resumeEpic, type ResumeOutcome } from "./unstick";
import type { RunningJobInfo } from "./runner";
import { getPickerNudge, getRunner, getScheduler, startRunner } from "./service-runner";

export { getPickerNudge, getRunner, getScheduler, startRunner };

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
 * Restart a stalled epic from an escalation (anton-wvcy) — the founder-facing half of the unstick
 * pass's own resume path, sharing its exact decision (`resumeEpic`) so a one-click resume and an
 * automatic one can never diverge. Routed through the runner so a project mid-teardown is refused
 * rather than handed a fresh job row.
 */
export function resumeStalledEpic(
  projectId: string,
  epicBeadId: string,
): Promise<ResumeOutcome> {
  const runner = getRunner();
  return resumeEpic(getDb(), systemClock, projectId, epicBeadId, {
    resume: (jobId) => runner.resume(jobId),
    enqueueIfAbsent: (project, epic) => runner.enqueueExecuteEpicIfAbsent(project, epic),
  });
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
 *
 * `only` restricts which statuses may be cancelled, for a caller whose decision was made against a
 * job it read earlier (see `cancelJob` in queue.ts); a job that has since left those statuses
 * reports `not-cancellable` rather than being killed.
 */
export async function cancelJob(
  projectId: string,
  jobId: string,
  only?: readonly string[],
): Promise<CancelResult> {
  const job = await getJob(getDb(), jobId);
  if (!job || job.projectId !== projectId) return { ok: false, reason: "not-found" };
  const acted = await getRunner().cancel(jobId, only);
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

/**
 * Whether a run target has a live (queued/running) execute-epic job on THIS instance — exactly what
 * `cancelRunForTarget` would kill. The precondition for a caller whose decision was made against work
 * that had already STOPPED: read it at the moment the kill would land, not from an earlier snapshot
 * (see `abandonTicket`'s `requireStopped`).
 */
export function runIsLiveForTarget(projectId: string, epicBeadId: string): boolean {
  return activeExecuteEpicId(getDb(), projectId, epicBeadId) !== undefined;
}
