/**
 * The two answers a founder can give an escalation (anton-wvcy): retry the work, or call it won't-do.
 *
 * Both settle the escalation FIRST, with the status CAS in `settleEscalation` as the lock: whoever
 * flips `open → resolved` owns the decision, so a double-click (or two operators on one board)
 * cannot resume the same epic twice or abandon a bead that is already closing. The action then runs.
 * If it fails, the escalation is already resolved but the stall is not — which is recoverable rather
 * than silent: the finding is still in the next run-health report, so the next unstick pass raises a
 * fresh escalation for it. That partial state is logged where an operator debugging the failure will
 * find it, because the row it concerns has already left the panel.
 *
 * The verbs themselves are reused, never re-implemented: resume shares `resumeEpic` with the
 * automatic path, abandon is the same `abandonTicket` the board's own abandon uses (kill the live
 * run, cascade to open descendants, close with a reason), and a stall that names only a JOB — an
 * exhausted `sync-push`/`run-health`/`unstick`, which strands no bead — is answered with the jobs
 * list's own resume/cancel. Without that last path such an escalation would have no settling move at
 * all and would sit on the board forever.
 */
import { getDb } from "./db";
import { abandonTicket } from "./abandon";
import { getEscalation, settleEscalation, toEscalationView } from "./escalations";
import { cancelJob, resumeJob, resumeStalledEpic } from "./jobs/service";
import { systemClock } from "./jobs/queue";
import { MAX_ABANDON_REASON_CHARS } from "./types";
import type { EscalationView } from "./escalations";
import type { Project } from "./types";

export type EscalationAction = "resume" | "abandon";

export function isEscalationAction(value: unknown): value is EscalationAction {
  return value === "resume" || value === "abandon";
}

/**
 * Why an action couldn't run:
 *   • `not-found`  — no such escalation in this project (404).
 *   • `not-open`   — someone already settled it (409).
 *   • `no-target`  — the finding names neither a bead/epic nor a job, so there is nothing to resume
 *                    or abandon (409).
 */
export type EscalationActionFailure = "not-found" | "not-open" | "no-target";

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
  const target = action === "resume" ? view.epicBeadId : view.beadId;
  // No bead to act on falls back to the job the stall named — an alert with no settling move is an
  // alert that trains the operator to ignore the panel.
  if (!target && !view.jobId) return { ok: false, reason: "no-target" };

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

/** Resume/abandon against the work itself — the epic a run stalled on, or the bead to close. */
async function actOnBead(
  project: Project,
  action: EscalationAction,
  view: EscalationView,
  target: string,
): Promise<string> {
  if (action === "resume") return resumeStalledEpic(project.id, target);
  await abandonTicket(project, target, abandonReason(view));
  return "abandoned";
}

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
  const result = await cancelJob(projectId, jobId);
  return result.ok ? "cancelled-job" : "job-already-settled";
}

function resolutionOf(action: EscalationAction): "resumed" | "abandoned" {
  return action === "resume" ? "resumed" : "abandoned";
}
