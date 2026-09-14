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
 * `dismiss` is the third answer: it settles the row, touches the work not at all, and — since
 * anton-7gxs — STAYS settled. A dismissal stamps `dismissedAt` and the stall's signature, and
 * `raiseEscalation` refuses to re-raise a finding whose signature a human already put down. That is
 * what makes it an answer rather than a snooze: one 503 storm dismissed once does not come back
 * hourly, while the same job failing a NEW way carries a new signature and does.
 *
 * It is offered on every kind except two, and the exceptions are about what dismissing would HIDE
 * rather than about tidiness. A wait on a PERSON (`needs-human`) is an open gate: settling the row
 * ends nothing, and suppressing the re-raise would bury an ask someone is still blocked on. An
 * `autopilot-disarm` is a frozen project: only a re-arm clears it, and a dismissal would clear the
 * one row saying so while every card stayed stopped. Both are refused as `not-dismissable`.
 *
 * `restore` is dismissal's undo, and the reason dismissal can be this durable: a founder who put a
 * storm down and wants it back does not have to wait for the stall to change shape.
 */
import { RunRestartedError } from "./abandon";
import { getDb } from "./db";
import {
  getEscalation,
  restoreEscalation,
  settleEscalation,
  toEscalationView,
} from "./escalations";
import { answerGateWait } from "./escalation-gate";
import { isDismissable } from "./escalation-kinds";
import { actOnBead, actOnJob, readTargetState, restartedLocally } from "./escalation-work";
import { systemClock } from "./jobs/queue";
import type { AntonDb } from "./jobs/queue";
import type { Applied } from "./escalation-gate";
import type { TargetState } from "./escalation-work";
import type { EscalationAction, EscalationResolution, EscalationView } from "./escalations";
import type { Project } from "./types";

export type { EscalationAction };

export function isEscalationAction(value: unknown): value is EscalationAction {
  return (
    value === "resume" || value === "abandon" || value === "dismiss" || value === "restore"
  );
}

/** The two answers that act on work — everything a `dismiss` deliberately does not do. */
type EscalationVerb = Exclude<EscalationAction, "dismiss" | "restore">;

/**
 * Why an action couldn't run:
 *   • `not-found`  — no such escalation in this project (404).
 *   • `not-open`   — someone already settled it (409).
 *   • `no-target`  — the finding names neither a bead/epic nor a job, so there is nothing to resume
 *                    or abandon (409).
 *   • `not-dismissable`
 *                  — a wait on a PERSON, which dismissing cannot settle (the gate stays open and the
 *                    next sweep raises the same row again), or an autopilot DISARM, which no sweep
 *                    re-raises at all — only a re-arm clears it (409).
 *   • `not-dismissed`
 *                  — a `restore` on a row nobody dismissed, or one an open row already covers, so
 *                    there is nothing to bring back (409).
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
  | "not-dismissed"
  | "restore-conflicted"
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

  const view = toEscalationView(row);
  if (action === "restore") return restoreStall(db, project.id, view);
  if (row.status !== "open") return { ok: false, reason: "not-open" };
  if (action === "dismiss") return dismissStall(db, view);
  return applyVerb(project, view, action);
}

/**
 * Put a dismissed alert back on the list. The only answer that acts on a row that is NOT open, which
 * is why it is routed before the open guard above.
 */
async function restoreStall(
  db: AntonDb,
  projectId: string,
  view: EscalationView,
): Promise<EscalationActionResult> {
  const result = await restoreEscalation(db, systemClock, projectId, view.id);
  if (result !== "restored") {
    return { ok: false, reason: result === "conflicted" ? "restore-conflicted" : "not-dismissed" };
  }
  return { ok: true, action: "restore", escalation: view, detail: "restored" };
}

/**
 * Dismiss settles the row and nothing else, so it needs no target and can't fail half-way.
 *
 * `byHuman` is the whole point of the call: the stamp it writes is what stops the next sweep raising
 * this stall again (see escalations.ts). Two kinds are refused — see {@link isDismissable} and the
 * module note. The rule is enforced HERE and not only in the panel, since a direct POST never passes
 * through a button.
 */
async function dismissStall(db: AntonDb, view: EscalationView): Promise<EscalationActionResult> {
  if (!isDismissable(view.kind)) return { ok: false, reason: "not-dismissable" };
  if (!(await settleEscalation(db, systemClock, view.id, "dismissed", true))) {
    return { ok: false, reason: "not-open" };
  }
  return { ok: true, action: "dismiss", escalation: view, detail: "dismissed" };
}

/** One id's outcome in a bulk dismissal — enough for the route to report what it skipped and why. */
export interface BulkDismissResult {
  dismissed: string[];
  /** Ids left alone: already settled, not this project's, or a kind that can't be put down. */
  skipped: { id: string; reason: EscalationActionFailure }[];
}

/**
 * Dismiss a set of alerts in one call (anton-7gxs) — what "Dismiss all 30" on a storm needs.
 *
 * Per-row rather than all-or-nothing, and that is deliberate: a group the operator selected can
 * contain one row someone else settled a second ago, or (via a hand-rolled POST) one that can't be
 * dismissed at all. Failing the whole batch over either would make the button unusable exactly when
 * it matters. Each id gets the same guard the single-row path applies, and the caller is told which
 * ones didn't take.
 */
export async function dismissEscalations(
  project: Project,
  ids: string[],
): Promise<BulkDismissResult> {
  const db = getDb();
  const result: BulkDismissResult = { dismissed: [], skipped: [] };
  for (const id of ids) {
    const row = await getEscalation(db, project.id, id);
    if (!row) {
      result.skipped.push({ id, reason: "not-found" });
      continue;
    }
    if (row.status !== "open") {
      result.skipped.push({ id, reason: "not-open" });
      continue;
    }
    const outcome = await dismissStall(db, toEscalationView(row));
    if (outcome.ok) result.dismissed.push(id);
    else result.skipped.push({ id, reason: outcome.reason });
  }
  return result;
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
