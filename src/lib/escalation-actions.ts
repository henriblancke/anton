/**
 * The answers a founder can give an escalation (anton-wvcy): retry the work, call it won't-do, or —
 * for a stall anton has no verb for — acknowledge it.
 *
 * Both settle the escalation FIRST, with the status CAS in `settleEscalation` as the lock: whoever
 * flips `open → resolved` owns the decision, so a double-click (or two operators on one board)
 * cannot resume the same epic twice or abandon a bead that is already closing. That CAS is local,
 * though, and the escalation is a frozen snapshot, so a bead-backed verb first re-reads the board:
 * whether the work still exists at all and whether another machine is executing it (see
 * {@link readTargetState}), plus the local job queue for a resume that happened right here (see
 * {@link restartedLocally}). The action then runs.
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
import { beads, isMissingBeadError } from "./beads/bd";
import { getEscalation, settleEscalation, toEscalationView } from "./escalations";
import { cancelJob, resumeJob, resumeStalledEpic } from "./jobs/service";
import { activeExecuteEpicId, getJob, systemClock } from "./jobs/queue";
import { settleParkedRun } from "./runs";
import { MAX_ABANDON_REASON_CHARS } from "./types";
import type { Bead } from "./beads/bd";
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
 *   • `contested`  — the work was picked back up since the stall was raised, here or on another
 *                    machine (409).
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
  // hand. Re-check that the work is still stopped first — before the settle, so a refusal leaves the
  // row on the panel for the next sweep to re-judge. Locally first: it costs one indexed read, where
  // the lease re-check costs a bd pull.
  if (target) {
    const epicBeadId = view.epicBeadId ?? target;
    if (action === "abandon" && restartedLocally(project.id, epicBeadId)) {
      return { ok: false, reason: "contested" };
    }
    const state = await readTargetState(project, view, target);
    if (state === "contested") return { ok: false, reason: "contested" };
    // The work was deleted after the sweep froze this stall, so neither verb has anything to act on
    // (see {@link readTargetState}). Settle the row as the no-op it is rather than refusing: the
    // panel offers Dismiss only on a stale PR, so a refusal would strand this escalation with no
    // move that could ever retire it, and the detail says plainly that nothing was restarted.
    if (state === "gone") {
      if (!(await settleEscalation(db, systemClock, escalationId, "dismissed"))) {
        return { ok: false, reason: "not-open" };
      }
      return { ok: true, action, escalation: view, detail: "target-gone" };
    }
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
 * Has the work restarted on THIS machine since the stall was raised? Runs and jobs are machine-local,
 * so a local resume reuses the stalled run's id and republishes the lease under it — which
 * {@link contestedByLiveRun} reads as ours by design, leaving the stale control unguarded.
 *
 * Only an abandon consults this, because only an abandon is destructive: `abandonTicket` cancels the
 * run target's ACTIVE job before closing the bead, so it would kill the execution the resume just
 * started and undo it. Nothing downstream catches that — `settleAbandonedWork`'s status-guarded
 * settles run after the cancel already terminalized the job. A resume needs no such guard: `resumeEpic`
 * absorbs an epic that is already active as a no-op.
 *
 * An active execute-epic job is exactly what the abandon's cancel would reach, so this refuses in
 * precisely the cases where it has something live to destroy — a job that has parked again since is
 * stopped work, and stays abandonable.
 */
function restartedLocally(projectId: string, epicBeadId: string): boolean {
  return activeExecuteEpicId(getDb(), projectId, epicBeadId) !== undefined;
}

/**
 * What the board says NOW about the work an escalation froze: `clear` to act on, `contested` by a
 * run on another machine, or `gone` because the bead itself was deleted.
 */
type TargetState = "clear" | "contested" | "gone";

/**
 * One bead as bd answers for it now — the row, `missing` when bd says there is no such bead, or
 * `unreadable` when bd could not answer at all. The last two are NOT interchangeable: only `missing`
 * is evidence, and only evidence may refuse a founder's action (see {@link isMissingBeadError}).
 */
type BeadRead = Bead | "missing" | "unreadable";

async function readBead(repoPath: string, id: string): Promise<BeadRead> {
  try {
    // A successful lookup that names no issue says the same thing as bd's "no issue found" exit.
    return (await beads.show(repoPath, id)) ?? "missing";
  } catch (e) {
    return isMissingBeadError(e) ? "missing" : "unreadable";
  }
}

/**
 * Re-read the work an escalation names, because the escalation is a frozen snapshot while the button
 * lives on the board until someone clicks it. Later sweeps hold the finding without resolving the
 * open row, so nothing else retires a stale control. Two things can have changed underneath it:
 *
 *   • Someone else picked the stall back up. Jobs and runs are machine-local, so the run-lease on the
 *     epic bead is the only record of that. Applying the stale button then resumes work already in
 *     flight — or, worse, abandons it, and `abandonTicket` reads only the bead's own status, so
 *     nothing downstream catches it.
 *   • The bead was DELETED. Then the verb has nothing left to act on: a resume hands execute-epic an
 *     id it can only park back on with `bead ... not found`, turning an intentional deletion into a
 *     poison job, and an abandon's `abandonTicket` throws — after the settle. The unstick pass makes
 *     this exact call on the sweep side (`epicSettled`); this is the same rule for the manual path.
 *
 * Pull before reading, like the runner's enqueue-time `liveRunCheck` and the unstick pass: the local
 * Dolt working set trails the shared remote by a sync heartbeat. A pull that fails (offline,
 * transient) falls back to the local snapshot rather than disabling the founder's only settling move,
 * and any evidence it does hold still counts — including a deletion, which reaches the mirror as the
 * bead's absence and can only have got there by being made here or synced from elsewhere.
 *
 * The lease is published under the RUN id, so the stalled run's own leftover is ours, not a foreign
 * holder; a finding with no run of its own (a dead lease) treats any live lease as foreign.
 */
async function readTargetState(
  project: Project,
  view: EscalationView,
  target: string,
): Promise<TargetState> {
  await beads.pull(project.repoPath).catch(() => {});
  // Existence is checked on the bead the VERB acts on — the epic a resume re-enqueues, the ticket an
  // abandon closes — which is not always the one carrying the lease.
  const acted = await readBead(project.repoPath, target);
  if (acted === "missing") return "gone";

  // Runs are keyed by RUN TARGET, so that is the bead execute-epic publishes the lease on, and it is
  // what `epicBeadId` holds for every kind: the run's epic for a parked run, the finding's own bead
  // for a stale PR or a dead lease (both name a run target — `inReviewTargets` classifies with
  // `isRunTarget`, and only run targets ever carry a lease). `target` is the fallback for a finding
  // that recorded no epic at all, and the common case where the two coincide costs no second read.
  const epicBeadId = view.epicBeadId ?? target;
  const holder = epicBeadId === target ? acted : await readBead(project.repoPath, epicBeadId);
  // No readable lease bead is no evidence of a live run: bd being unreachable must not disable the
  // panel, and a gone EPIC still leaves an abandon of its (existing) ticket worth doing.
  if (typeof holder === "string") return "clear";

  const nowMs = systemClock.now();
  const live = view.runId
    ? beads.foreignRunLeaseLive(holder, nowMs, view.runId)
    : beads.isRunLive(holder, nowMs);
  return live ? "contested" : "clear";
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
