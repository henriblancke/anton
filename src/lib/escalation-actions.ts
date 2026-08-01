/**
 * The answers a founder can give an escalation (anton-wvcy): retry the work, call it won't-do, or —
 * for a stall anton has no verb for — acknowledge it.
 *
 * Both settle the escalation FIRST, with the status CAS in `settleEscalation` as the lock: whoever
 * flips `open → resolved` owns the decision, so a double-click (or two operators on one board)
 * cannot resume the same epic twice or abandon a bead that is already closing. That CAS is local,
 * though, so a bead-backed verb re-reads the shared board's run-lease before it (see
 * {@link contestedByLiveRun}) — the escalation is a frozen snapshot, and another machine may have
 * picked the work up since. The action then runs.
 * If it fails, the escalation is already resolved but the stall is not — which is recoverable rather
 * than silent: the finding is still in the next run-health report, so the next unstick pass raises a
 * fresh escalation for it. That partial state is logged where an operator debugging the failure will
 * find it, because the row it concerns has already left the panel.
 *
 * The verbs themselves are reused, never re-implemented: resume shares `resumeEpic` with the
 * automatic path, abandon is the same `abandonTicket` the board's own abandon uses (kill the live
 * run, cascade to open descendants, close with a reason) plus the settle for the stopped rows that
 * abandon has no reach into (see `settleAbandonedWork`), and a stall that names only a JOB — an
 * exhausted `sync-push`/`run-health`/`unstick`, which strands no bead — is answered with the jobs
 * list's own resume/cancel. Without that last path such an escalation would have no settling move at
 * all and would sit on the board forever.
 *
 * `dismiss` is the third answer, and the honest one for a STALE PR: the work is already delivered
 * and open for review, so execute-epic's PR short-circuit makes a resume a no-op — it would settle
 * the escalation while changing nothing about the PR, and the next sweep would raise it again. What
 * a stale PR actually needs is a reviewer, which is a human act outside anton. Dismiss says exactly
 * that: it settles the row, touches nothing, and lets the sweep re-raise the finding if the PR is
 * still idle — so acknowledging a stall can never hide one.
 */
import { getDb } from "./db";
import { abandonTicket } from "./abandon";
import { beads } from "./beads/bd";
import { getEscalation, settleEscalation, toEscalationView } from "./escalations";
import { cancelJob, resumeJob, resumeStalledEpic } from "./jobs/service";
import { getJob, systemClock } from "./jobs/queue";
import { settleParkedRun } from "./runs";
import { MAX_ABANDON_REASON_CHARS } from "./types";
import type { EscalationResolution, EscalationView } from "./escalations";
import type { Project } from "./types";

export type EscalationAction = "resume" | "abandon" | "dismiss";

export function isEscalationAction(value: unknown): value is EscalationAction {
  return value === "resume" || value === "abandon" || value === "dismiss";
}

/**
 * Why an action couldn't run:
 *   • `not-found`  — no such escalation in this project (404).
 *   • `not-open`   — someone already settled it (409).
 *   • `no-target`  — the finding names neither a bead/epic nor a job, so there is nothing to resume
 *                    or abandon (409).
 *   • `contested`  — another machine picked the work back up since the stall was raised (409).
 */
export type EscalationActionFailure = "not-found" | "not-open" | "no-target" | "contested";

export type EscalationActionResult =
  | { ok: true; action: EscalationAction; escalation: EscalationView; detail: string }
  | { ok: false; reason: EscalationActionFailure };

/** The abandon reason recorded on the bead — the escalation's own evidence, capped to bd's limit. */
function abandonReason(escalation: EscalationView): string {
  const reason = `Abandoned from a run-health escalation (${escalation.kind}): ${escalation.reason}`;
  return reason.slice(0, MAX_ABANDON_REASON_CHARS);
}

/**
 * Apply a founder's decision to one escalation. Project-scoped so a route can't settle another
 * project's item by id.
 */
export async function actOnEscalation(
  project: Project,
  escalationId: string,
  action: EscalationAction,
): Promise<EscalationActionResult> {
  const db = getDb();
  const row = await getEscalation(db, project.id, escalationId);
  if (!row) return { ok: false, reason: "not-found" };
  if (row.status !== "open") return { ok: false, reason: "not-open" };

  const view = toEscalationView(row);

  // Dismiss settles the row and nothing else, so it needs no target and can't fail half-way.
  if (action === "dismiss") {
    if (!(await settleEscalation(db, systemClock, escalationId, "dismissed"))) {
      return { ok: false, reason: "not-open" };
    }
    return { ok: true, action, escalation: view, detail: "dismissed" };
  }

  const target = action === "resume" ? view.epicBeadId : view.beadId;
  // No bead to act on falls back to the job the stall named — an alert with no settling move is an
  // alert that trains the operator to ignore the panel.
  if (!target && !view.jobId) return { ok: false, reason: "no-target" };

  // The escalation froze the stall as the sweep saw it; a bead-backed verb is applied later, by
  // hand. Re-check the cross-machine lease first — before the settle, so a refusal leaves the row
  // on the panel for the next sweep to re-judge.
  if (target && (await contestedByLiveRun(project, view, target))) {
    return { ok: false, reason: "contested" };
  }

  // Claim the decision before acting — see the module note: the CAS is the lock.
  if (!(await settleEscalation(db, systemClock, escalationId, resolutionOf(action)))) {
    return { ok: false, reason: "not-open" };
  }

  try {
    const detail = target
      ? await actOnBead(project, action, view, target)
      : await actOnJob(project.id, action, view.jobId!);
    return { ok: true, action, escalation: view, detail };
  } catch (e) {
    // Settled but not acted: the route answers 500, and the row is already gone from the panel, so
    // this line is the only place the two halves of that state meet. The stall itself isn't lost —
    // it is still in the next run-health report, which raises it again.
    console.error(
      `[unstick] escalation ${escalationId} was settled as ${resolutionOf(action)} but the ` +
        `${action} failed — the stall is unchanged and re-surfaces on the next run-health sweep`,
      e,
    );
    throw e;
  }
}

/**
 * Is the work this escalation names executing on ANOTHER machine right now? Jobs and runs are
 * machine-local, so the run-lease on the epic bead is the only record that someone else picked the
 * stall back up between the sweep raising it and a founder clicking. The unstick pass stands down on
 * that lease before it escalates, but an already-open escalation outlives the pass: later sweeps
 * hold the finding without resolving the row, so the stale button survives on the board. Applying it
 * then resumes work already in flight — or, worse, abandons it, and `abandonTicket` reads only the
 * bead's own status, so nothing downstream catches that.
 *
 * Pull before reading, like the runner's enqueue-time `liveRunCheck` and the unstick pass: the local
 * Dolt working set trails the shared remote by a sync heartbeat. Same fail-open posture too — a pull
 * that fails (offline, transient) falls back to the local snapshot rather than disabling the
 * founder's only settling move, and any evidence it does hold still counts.
 *
 * The lease is published under the RUN id, so the stalled run's own leftover is ours, not a foreign
 * holder; a finding with no run of its own (a dead lease) treats any live lease as foreign.
 */
async function contestedByLiveRun(
  project: Project,
  view: EscalationView,
  target: string,
): Promise<boolean> {
  // Runs are keyed by epic, so that is where execute-epic publishes the lease; `target` is the epic
  // already for a resume, and the fallback for a finding that named no epic at all.
  const epicBeadId = view.epicBeadId ?? target;
  try {
    await beads.pull(project.repoPath).catch(() => {});
    const bead = await beads.show(project.repoPath, epicBeadId);
    const nowMs = systemClock.now();
    return view.runId
      ? beads.foreignRunLeaseLive(bead, nowMs, view.runId)
      : beads.isRunLive(bead, nowMs);
  } catch {
    // bd is unreachable, or the bead is gone. Neither is evidence of a live run, and the verbs keep
    // their own guards (abandonTicket 404s on a missing bead; a resumed epic re-parks on a foreign
    // lease), so the panel stays usable rather than refusing every action bd can't answer for.
    return false;
  }
}

/** Resume/abandon against the work itself — the epic a run stalled on, or the bead to close. */
async function actOnBead(
  project: Project,
  action: EscalationAction,
  view: EscalationView,
  target: string,
): Promise<string> {
  if (action === "resume") return resumeStalledEpic(project.id, target);
  const reason = abandonReason(view);
  await abandonTicket(project, target, reason);
  await settleAbandonedWork(project.id, view, reason);
  return "abandoned";
}

/**
 * The machine-local rows an abandon must settle beyond the bead. `abandonTicket` kills only an ACTIVE
 * (queued/running) job, but an escalation is raised precisely against work that already STOPPED — a
 * parked run, a parked/failed job. Left as they are, the bead closes while the local rows stay in the
 * exact state `detectParkedRuns` / `detectExhaustedJobs` report, so the next sweep escalates work
 * whose target is already abandoned. Both settles are status-guarded CASes, so work an operator
 * restarted between the raise and the click keeps running.
 *
 * Runs after the bead closes, so a failure here propagates like any other action failure (see the
 * module note) while the abandon it follows still stands.
 */
async function settleAbandonedWork(
  projectId: string,
  view: EscalationView,
  reason: string,
): Promise<void> {
  if (view.jobId) await cancelJob(projectId, view.jobId, STOPPABLE_FROM);
  if (view.runId) await settleParkedRun(getDb(), systemClock, projectId, view.runId, reason);
}

/**
 * The statuses an exhausted-job escalation is raised against, and the only ones its "stop retrying"
 * may terminalize. The unstick pass re-validates before RAISING, but the button lives on the board
 * until someone clicks it: an operator who resumed the job in between put it back to work, and
 * cancelling then would abort a live child on the strength of a stale control.
 */
const STOPPABLE_FROM = ["parked", "failed"] as const;

/**
 * The same decision for a stall that names only a job: resume gives it a fresh retry budget, abandon
 * cancels it so it never runs again. Both move the job out of `parked`/`failed` — the only states
 * `detectExhaustedJobs` reports — so settling here also stops the next sweep re-raising this exact
 * finding. A job that has since moved on reports that rather than claiming an action it didn't take.
 */
async function actOnJob(
  projectId: string,
  action: EscalationAction,
  jobId: string,
): Promise<string> {
  if (action === "resume") {
    return (await resumeJob(projectId, jobId)) ? "resumed-job" : "job-not-resumable";
  }
  const result = await cancelJob(projectId, jobId, STOPPABLE_FROM);
  if (result.ok) return "cancelled-job";
  // The guard refused it. Say WHICH way, so the operator learns their stale button hit a job that is
  // running again rather than one that had merely stopped on its own.
  const job = await getJob(getDb(), jobId);
  return job?.status === "queued" || job?.status === "running"
    ? "job-restarted"
    : "job-already-settled";
}

function resolutionOf(action: EscalationAction): EscalationResolution {
  if (action === "resume") return "resumed";
  return action === "abandon" ? "abandoned" : "dismissed";
}
