/**
 * The answers a founder can give an escalation (anton-wvcy): retry the work, call it won't-do, or —
 * for a stall anton has no verb for — acknowledge it.
 *
 * This module owns the ORDER and nothing else. Each answer is applied by the handler for the thing it
 * acts on: the work itself in escalation-work.ts (the bead a run stalled on, the job a stall named),
 * and a wait on a PERSON in escalation-gate.ts.
 *
 * Both settle the escalation FIRST, with the status CAS in `settleEscalation` as the lock: whoever
 * flips `open → resolved` owns the decision, so a double-click (or two operators on one board)
 * cannot resume the same epic twice or abandon a bead that is already closing. That CAS is local,
 * though, and the escalation is a frozen snapshot, so a bead-backed verb first re-reads the board:
 * whether the work is still unsettled at all and whether another machine is executing it (see
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
 * still idle — so acknowledging a stall can never hide one. It is refused on a wait for a person,
 * which settling the row alone cannot end (see escalation-gate.ts).
 */
import { RunRestartedError } from "./abandon";
import { getDb } from "./db";
import { getEscalation, settleEscalation, toEscalationView } from "./escalations";
import { answerGateWait } from "./escalation-gate";
import { actOnBead, actOnJob, readTargetState, restartedLocally } from "./escalation-work";
import { systemClock } from "./jobs/queue";
import type { AntonDb } from "./jobs/queue";
import type { Applied } from "./escalation-gate";
import type { TargetState } from "./escalation-work";
import type { EscalationAction, EscalationResolution, EscalationView } from "./escalations";
import type { Project } from "./types";

export type { EscalationAction };

export function isEscalationAction(value: unknown): value is EscalationAction {
  return value === "resume" || value === "abandon" || value === "dismiss";
}

/** The two answers that act on work — everything a `dismiss` deliberately does not do. */
type EscalationVerb = Exclude<EscalationAction, "dismiss">;

/**
 * Why an action couldn't run:
 *   • `not-found`  — no such escalation in this project (404).
 *   • `not-open`   — someone already settled it (409).
 *   • `no-target`  — the finding names neither a bead/epic nor a job, so there is nothing to resume
 *                    or abandon (409).
 *   • `not-dismissable`
 *                  — a wait on a PERSON, which dismissing cannot settle: the gate stays open and the
 *                    next sweep raises the same row again (409).
 *   • `contested`  — the work was picked back up since the stall was raised, here or on another
 *                    machine (409).
 *   • `unverified` — bd could not confirm CURRENT shared state (the pull or a bead read failed), so
 *                    a foreign run can't be ruled out. A bead-backed verb stays refused until it
 *                    can (409); `dismiss` never consults the board and stays available.
 */
export type EscalationActionFailure =
  | "not-found"
  | "not-open"
  | "no-target"
  | "not-dismissable"
  | "contested"
  | "unverified";

export type EscalationActionResult =
  | {
      ok: true;
      action: EscalationAction;
      escalation: EscalationView;
      detail: string;
      note?: string;
    }
  | { ok: false; reason: EscalationActionFailure };

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
  if (action === "dismiss") return dismissStall(db, view);
  return applyVerb(project, view, action);
}

/**
 * Dismiss settles the row and nothing else, so it needs no target and can't fail half-way.
 *
 * Except on a wait for a PERSON, where settling the row alone settles nothing: the gate stays open,
 * `detectOpenHumanGates` sees it on the very next sweep, and the board bounces the same "Waiting on
 * you" row forever. The panel offers no Dismiss there (see escalation-gate.ts); this is that rule
 * where it is enforceable, since a direct POST never passes through the panel.
 */
async function dismissStall(db: AntonDb, view: EscalationView): Promise<EscalationActionResult> {
  if (view.kind === "needs-human") return { ok: false, reason: "not-dismissable" };
  if (!(await settleEscalation(db, systemClock, view.id, "dismissed"))) {
    return { ok: false, reason: "not-open" };
  }
  return { ok: true, action: "dismiss", escalation: view, detail: "dismissed" };
}

/**
 * Re-read the board, claim the decision, then act — the order the module note describes.
 *
 * The gate a wait on a person hangs on is a settling move in its own right: it can block work anton
 * doesn't run, and that wait still ends when the person says it does. So no bead and no job is only
 * "nothing to act on" when there is no gate either — an alert with no settling move is an alert that
 * trains the operator to ignore the panel.
 */
async function applyVerb(
  project: Project,
  view: EscalationView,
  action: EscalationVerb,
): Promise<EscalationActionResult> {
  const target = action === "resume" ? view.epicBeadId : view.beadId;
  if (!target && !view.jobId && !view.gateId) return { ok: false, reason: "no-target" };

  const checked = await preflight(project, view, action, target);
  if (checked.verdict === "stop") return checked.result;

  // Claim the decision before acting — see the module note: the CAS is the lock.
  if (!(await settleEscalation(getDb(), systemClock, view.id, resolutionOf(action)))) {
    return { ok: false, reason: "not-open" };
  }
  return runVerb(project, view, action, checked.target);
}

/**
 * What the pre-settle board read decided: `act` on the work still left to act on (which for a gate
 * wait can be none of it), or `stop` with the answer to return as-is.
 */
type Preflight =
  | { verdict: "act"; target?: string }
  | { verdict: "stop"; result: EscalationActionResult };

/**
 * The escalation froze the stall as the sweep saw it; a bead-backed verb is applied later, by hand.
 * Re-check that the work is still stopped first — BEFORE the settle, so a refusal leaves the row on
 * the panel for the next sweep to re-judge.
 *
 * Both verbs are cross-machine acts judged off the run-lease (see {@link readTargetState}), so an
 * unverified board waits rather than acting on an unproven snapshot: an extra sweep of stall costs a
 * glance, a duplicate run costs a duplicate PR and an abandon closes a bead underneath live work.
 *
 * Work that settled itself after the sweep froze this stall — deleted, or closed by hand — leaves
 * neither verb anything to act on. That is settled as the no-op it is rather than refused: the panel
 * offers Dismiss only on a stale PR, so a refusal would strand this escalation with no move that
 * could ever retire it.
 */
async function preflight(
  project: Project,
  view: EscalationView,
  action: EscalationVerb,
  target?: string,
): Promise<Preflight> {
  if (!target) return { verdict: "act" };
  const state = await liveTargetState(project, view, action, target);
  if (state === "contested" || state === "unverified") {
    return { verdict: "stop", result: { ok: false, reason: state } };
  }
  if (state === "clear") return { verdict: "act", target };
  // A wait on a person outlives the work it blocked: the gate is still open, and only a person closes
  // it. So a gate wait drops the FROZEN pointer and acts anyway — otherwise the gate would keep
  // raising this escalation forever, and every answer to it would report "nothing to act on". The
  // answer is not dropped with the pointer: the gate is a live pointer of its own, so the resume
  // re-derives what it releases now, which after a reparent is a run target this settled ancestor
  // says nothing about.
  if (view.gateId) return { verdict: "act" };
  return settleAsNoOp(view, action, state);
}

/**
 * Liveness, judged on the ancestor this escalation FROZE — evidence only while that ancestor is still
 * what the verb acts on. For a wait on a PERSON it need not be: the gate blocks a BEAD, and
 * reparenting moves the run target above it while the row sits on the panel — so a run starting on the
 * bead the gate LEFT would veto BOTH answers, leaving a wait that offers no dismiss unanswerable until
 * unrelated work stopped. The veto moves rather than being dropped: each verb re-derives its live
 * target and re-reads the lease there (`gateDispatch` for the resume, `abandonTicket`'s
 * `requireStopped` for the abandon — see {@link actOnBead}).
 *
 * The local read runs on both sides of the board read: `readTargetState` awaits a bd pull that can
 * take seconds, and a resume that lands inside that window republishes the stalled run's own id —
 * which the lease check exempts as this escalation's own leftover. Before it too, because it is one
 * indexed read and refusing early spares the pull entirely.
 */
async function liveTargetState(
  project: Project,
  view: EscalationView,
  action: EscalationVerb,
  target: string,
): Promise<TargetState> {
  const judgeFrozenLease = !view.gateId;
  const epicBeadId = view.epicBeadId ?? target;
  const abandonWouldKillLiveWork = () =>
    judgeFrozenLease && action === "abandon" && restartedLocally(project.id, epicBeadId);
  if (abandonWouldKillLiveWork()) return "contested";
  const state = await readTargetState(project, view, target, judgeFrozenLease);
  if (state === "contested") return state;
  return abandonWouldKillLiveWork() ? "contested" : state;
}

/**
 * Settle a row whose work ended without either verb: the detail says plainly which way it ended and
 * that nothing was restarted.
 */
async function settleAsNoOp(
  view: EscalationView,
  action: EscalationVerb,
  state: "gone" | "closed",
): Promise<Preflight> {
  if (!(await settleEscalation(getDb(), systemClock, view.id, "dismissed"))) {
    return { verdict: "stop", result: { ok: false, reason: "not-open" } };
  }
  const detail = state === "gone" ? "target-gone" : "target-closed";
  return { verdict: "stop", result: { ok: true, action, escalation: view, detail } };
}

/** The settle has landed; from here a failure leaves the row settled and the stall standing. */
async function runVerb(
  project: Project,
  view: EscalationView,
  action: EscalationVerb,
  liveTarget?: string,
): Promise<EscalationActionResult> {
  try {
    const { detail, note } = await applied(project, view, action, liveTarget);
    return { ok: true, action, escalation: view, detail, note };
  } catch (e) {
    // The abandon's own boundary check caught a resume that landed after the settle: it refused
    // before touching anything, so the run is still executing and the bead is still open. That is the
    // same answer the pre-settle checks give, so report `contested` rather than a failure — the only
    // cost is a row settled as abandoned, which the next sweep re-raises if the work stalls again.
    if (e instanceof RunRestartedError) {
      console.warn(
        `[unstick] escalation ${view.id} was settled as abandoned but its work restarted first ` +
          `— nothing was cancelled or closed`,
      );
      return { ok: false, reason: "contested" };
    }
    // Settled but not acted: the route answers 500, and the row is already gone from the panel, so
    // this line is the only place the two halves of that state meet. The stall itself isn't lost —
    // it is still in the next run-health report, which raises it again. A gate wait whose resolve
    // landed and whose resume then failed is recovered by the other pass instead: a closed gate over
    // runnable work is precisely what gate-check's `plainGateResumes` dispatches.
    console.error(
      `[unstick] escalation ${view.id} was settled as ${resolutionOf(action)} but the ` +
        `${action} failed — the stall is unchanged and re-surfaces on the next run-health sweep`,
      e,
    );
    throw e;
  }
}

/** Which handler owns this answer: the gate a person waits on, the work itself, or the bare job. */
async function applied(
  project: Project,
  view: EscalationView,
  action: EscalationVerb,
  liveTarget?: string,
): Promise<Applied> {
  const gateId = view.gateId;
  if (gateId) return answerGateWait(project, action, view, gateId, liveTarget);
  if (liveTarget) return { detail: await actOnBead(project, action, view, liveTarget) };
  return { detail: await actOnJob(project.id, action, view.jobId!) };
}

function resolutionOf(action: EscalationAction): EscalationResolution {
  if (action === "resume") return "resumed";
  return action === "abandon" ? "abandoned" : "dismissed";
}
