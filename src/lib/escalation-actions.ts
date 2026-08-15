/**
 * The answers a founder can give an escalation (anton-wvcy): retry the work, call it won't-do, or —
 * for a stall anton has no verb for — acknowledge it.
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
 * A wait on a PERSON (`needs-human`) is the one stall whose answer is not really about the run: it
 * hangs on a gate, so both verbs close the gate as well as acting on the work. Resume is
 * resolve-and-resume — "I did it, carry on" — and closes the gate FIRST, because execute-epic
 * re-reads the board and a run enqueued against an open gate simply parks on the same wait again. For
 * the same reason it resumes only once the whole board says the target may run — the automatic path's
 * own dispatch rule, not a subset of it (see {@link heldBack}); anything else still holding it means
 * the founder's answer ends that one wait and nothing more. A resume that DOES land marks the gate
 * handed back ({@link markGateResumed}), because a closed gate is otherwise re-dispatched by
 * gate-check forever.
 * Abandon closes the gate LAST, after the bead: a gate that closes over an open bead hands the work
 * straight back to gate-check's own resume, which is the opposite of an abandon. Either way the gate
 * must close, because it is not on the bead's lifecycle — left open it keeps `detectOpenHumanGates`
 * raising this same escalation every sweep, against work that has since been settled. Dismiss is
 * deliberately NOT offered — and refused here, not merely hidden in the panel: a wait on a person is
 * not something to acknowledge and leave open, and a dismissal that left the gate open would settle
 * the row into a board that raises it again on the next sweep, forever.
 *
 * `dismiss` is the third answer, and the honest one for a STALE PR: the work is already delivered
 * and open for review, so execute-epic's PR short-circuit makes a resume a no-op — it would settle
 * the escalation while changing nothing about the PR, and the next sweep would raise it again. What
 * a stale PR actually needs is a reviewer, which is a human act outside anton. Dismiss says exactly
 * that: it settles the row, touches nothing, and lets the sweep re-raise the finding if the PR is
 * still idle — so acknowledging a stall can never hide one.
 */
import { getDb } from "./db";
import { abandonTicket, RunRestartedError } from "./abandon";
import { beads, isMissingBeadError } from "./beads/bd";
import { loadAllIssues } from "./beads/issues";
import { nudgeSync } from "./beads/sync-nudge";
import { getEscalation, settleEscalation, toEscalationView } from "./escalations";
import { GATE_RESUMED_LABEL, undispatchableReason } from "./jobs/gate-targets";
import { cancelJob, resumeJob, resumeStalledEpic, runIsLiveForTarget } from "./jobs/service";
import { getJob, systemClock } from "./jobs/queue";
import { resolveOperator } from "./operator";
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
    // Except on a wait for a PERSON, where settling the row alone settles nothing: the gate stays
    // open, `detectOpenHumanGates` sees it on the very next sweep, and the board bounces the same
    // "Waiting on you" row forever. The panel offers no Dismiss there (see the module note); this is
    // that rule where it is enforceable, since a direct POST never passes through the panel.
    if (view.kind === "needs-human") return { ok: false, reason: "not-dismissable" };
    if (!(await settleEscalation(db, systemClock, escalationId, "dismissed"))) {
      return { ok: false, reason: "not-open" };
    }
    return { ok: true, action, escalation: view, detail: "dismissed" };
  }

  // The gate a wait on a person hangs on. Both verbs close it (see the module note), and it is a
  // settling move in its own right: a gate can block work anton doesn't run, and that wait still
  // ends when the person says it does.
  const gateId = view.gateId;

  const target = action === "resume" ? view.epicBeadId : view.beadId;
  // No bead to act on falls back to the job the stall named — an alert with no settling move is an
  // alert that trains the operator to ignore the panel.
  if (!target && !view.jobId && !gateId) return { ok: false, reason: "no-target" };

  // The work the verb still has to act on, once the board has been re-read: cleared when the work
  // settled itself since the sweep froze this stall, which for a gate wait leaves the gate.
  let liveTarget = target;

  // The escalation froze the stall as the sweep saw it; a bead-backed verb is applied later, by
  // hand. Re-check that the work is still stopped first — before the settle, so a refusal leaves the
  // row on the panel for the next sweep to re-judge. Locally first: it costs one indexed read, where
  // the lease re-check costs a bd pull.
  if (target) {
    const epicBeadId = view.epicBeadId ?? target;
    // Re-run AFTER the board read as well as before it: `readTargetState` awaits a bd pull that can
    // take seconds, and a resume that lands inside that window republishes the stalled run's own id
    // — which the lease check exempts as this escalation's own leftover. Checked before it too
    // because it is one indexed read and refusing early spares the pull entirely.
    const abandonWouldKillLiveWork = () =>
      action === "abandon" && restartedLocally(project.id, epicBeadId);
    if (abandonWouldKillLiveWork()) return { ok: false, reason: "contested" };
    const state = await readTargetState(project, view, target);
    if (state === "contested" || abandonWouldKillLiveWork()) {
      return { ok: false, reason: "contested" };
    }
    // Shared state couldn't be confirmed. Both verbs are cross-machine acts judged off the run-lease
    // (see {@link readTargetState}), so they wait rather than act on an unproven snapshot: an extra
    // sweep of stall costs a glance, a duplicate run costs a duplicate PR and an abandon closes a
    // bead underneath live work.
    if (state === "unverified") return { ok: false, reason: "unverified" };
    // The work settled itself after the sweep froze this stall — deleted, or closed by hand — so
    // neither verb has anything to act on (see {@link readTargetState}). Settle the row as the no-op
    // it is rather than refusing: the panel offers Dismiss only on a stale PR, so a refusal would
    // strand this escalation with no move that could ever retire it, and the detail says plainly
    // which way the work ended and that nothing was restarted.
    if (state === "gone" || state === "closed") {
      // A wait on a person outlives the work it blocked: the gate is still open, and only a person
      // closes it. So a gate wait falls through to the settle and the act below with nothing left to
      // resume or abandon — otherwise the gate would keep raising this escalation forever, and every
      // answer to it would report "nothing to act on".
      if (!gateId) {
        if (!(await settleEscalation(db, systemClock, escalationId, "dismissed"))) {
          return { ok: false, reason: "not-open" };
        }
        const detail = state === "gone" ? "target-gone" : "target-closed";
        return { ok: true, action, escalation: view, detail };
      }
      liveTarget = undefined;
    }
  }

  // Claim the decision before acting — see the module note: the CAS is the lock.
  if (!(await settleEscalation(db, systemClock, escalationId, resolutionOf(action)))) {
    return { ok: false, reason: "not-open" };
  }

  const apply = (): Promise<string> => {
    if (gateId) return answerGateWait(project, action, view, gateId, liveTarget);
    if (liveTarget) return actOnBead(project, action, view, liveTarget);
    return actOnJob(project.id, action, view.jobId!);
  };

  try {
    const detail = await apply();
    return { ok: true, action, escalation: view, detail };
  } catch (e) {
    // The abandon's own boundary check caught a resume that landed after the settle: it refused
    // before touching anything, so the run is still executing and the bead is still open. That is the
    // same answer the pre-settle checks give, so report `contested` rather than a failure — the only
    // cost is a row settled as abandoned, which the next sweep re-raises if the work stalls again.
    if (e instanceof RunRestartedError) {
      console.warn(
        `[unstick] escalation ${escalationId} was settled as abandoned but its work restarted first ` +
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
 *
 * Every call here is a SNAPSHOT: the settle, and the bd reads inside the abandon, all await after it.
 * It refuses early and cheaply; the answer that actually gates the destruction is the identical read
 * `abandonTicket`'s `requireStopped` makes at the cancel boundary itself.
 */
function restartedLocally(projectId: string, epicBeadId: string): boolean {
  return runIsLiveForTarget(projectId, epicBeadId);
}

/**
 * What the board says NOW about the work an escalation froze: `clear` to act on, `contested` by a
 * run on another machine, `unverified` when bd couldn't say either way, `gone` because the bead
 * itself was deleted, or `closed` because someone settled it by hand. The last two are one meaning —
 * nothing left to act on — kept apart only so the panel can say which way the work ended.
 */
type TargetState = "clear" | "contested" | "unverified" | "gone" | "closed";

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
 *   • The work SETTLED — the bead was deleted, or closed by hand. Then the verb has nothing left to
 *     act on: a resume hands execute-epic a bead it either can only park back on with
 *     `bead ... not found`, turning an intentional deletion into a poison job, or runs work that was
 *     explicitly called done, and an abandon's `abandonTicket` throws on both — after the settle.
 *     The unstick pass makes this exact call on the sweep side (`epicSettled`); this is the same
 *     rule for the manual path.
 *
 * Pull before reading, like the runner's enqueue-time `liveRunCheck` and the unstick pass: the local
 * Dolt working set trails the shared remote by a sync heartbeat. Both verbs then FAIL CLOSED on
 * anything that leaves current shared state unread — a rejected pull, a bead bd couldn't answer for
 * — exactly as `leaseStandDown` does on the sweep side. A stale mirror can only be wrong in the
 * direction that double-runs, and neither verb is cheap to be wrong about: a resume duplicates a run
 * another machine owns, an abandon closes its bead underneath it. Refusing costs one more sweep of
 * stall and leaves the row on the panel, so the founder's move is deferred, never lost — and a
 * workspace with no remote at all resolves the pull (`not-wired`) rather than rejecting, so a
 * single-machine board is unaffected. `dismiss` reads none of this and stays available regardless.
 *
 * Evidence the local mirror does hold still counts against the work EXISTING — a deletion or a
 * close can only have got there by being made here or synced from elsewhere — because settling the
 * row on those changes nothing about the work.
 *
 * The lease is published under the RUN id, so the stalled run's own leftover is ours, not a foreign
 * holder; a finding with no run of its own (a dead lease) treats any live lease as foreign.
 */
async function readTargetState(
  project: Project,
  view: EscalationView,
  target: string,
): Promise<TargetState> {
  const pulled = await beads.pull(project.repoPath).then(
    () => true,
    () => false,
  );
  // Existence is checked on the bead the VERB acts on — the epic a resume re-enqueues, the ticket an
  // abandon closes — which is not always the one carrying the lease.
  const acted = await readBead(project.repoPath, target);
  if (acted === "missing") return "gone";
  // A bead bd could not answer for is no evidence of anything (see {@link BeadRead}): it can neither
  // say the work was closed out from under this escalation nor rule out a run holding it.
  if (acted === "unreadable") return "unverified";
  if (acted.status === "closed") return "closed";

  // Runs are keyed by RUN TARGET, so that is the bead execute-epic publishes the lease on, and it is
  // what `epicBeadId` holds for every kind: the run's epic for a parked run, the finding's own bead
  // for a stale PR or a dead lease (both name a run target — `inReviewTargets` classifies with
  // `isRunTarget`, and only run targets ever carry a lease). `target` is the fallback for a finding
  // that recorded no epic at all, and the common case where the two coincide costs no second read.
  const epicBeadId = view.epicBeadId ?? target;
  const holder = epicBeadId === target ? acted : await readBead(project.repoPath, epicBeadId);
  if (holder === "unreadable") return "unverified";
  // A gone EPIC carries no lease — and that is evidence, not a failed read — so an abandon of its
  // (existing) ticket is still worth doing.
  if (holder !== "missing") {
    const nowMs = systemClock.now();
    const live = view.runId
      ? beads.foreignRunLeaseLive(holder, nowMs, view.runId)
      : beads.isRunLive(holder, nowMs);
    if (live) return "contested";
  }
  // Every read landed — but a lease another machine published seconds ago reaches this mirror only
  // through the pull, so without one "no live lease" is an unread answer, not a clear board.
  return pulled ? "clear" : "unverified";
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
  // `requireStopped`: the checks above are snapshots, and the settle that follows them awaits. The
  // abandon re-reads liveness where it would actually kill the run and refuses there instead (see
  // {@link restartedLocally}), so a resume landing in that window is answered with a
  // `RunRestartedError` and an untouched board rather than a cancelled job and a closed bead.
  await abandonTicket(project, target, reason, { requireStopped: true });
  await settleAbandonedWork(project.id, view, reason);
  return "abandoned";
}

/**
 * Both answers to a wait on a person — the founder's "I did it, carry on" and their "this isn't
 * happening" — which share one act: closing the gate. Neither answer is complete without it (see the
 * module note), and the ORDER around the work is what makes each of them mean what it says.
 *
 * Resume closes the gate first: execute-epic re-reads the board, so a run enqueued while the gate is
 * still open just parks on the same wait. Abandon closes it last: a gate that closes over a still-open
 * bead is exactly what gate-check's `plainGateResumes` dispatches, so it would hand the work back at
 * the moment the founder said to stop.
 *
 * `target` is absent when the gate blocks nothing anton runs — a molecule step, a bead this board read
 * doesn't carry — or when that work settled itself since the sweep. Closing the gate is then the whole
 * answer: the wait was on the person either way.
 */
async function answerGateWait(
  project: Project,
  action: EscalationAction,
  view: EscalationView,
  gateId: string,
  target?: string,
): Promise<string> {
  if (action === "abandon") {
    const detail = target ? await actOnBead(project, action, view, target) : undefined;
    await resolveGate(project, gateId, gateReason(view, action));
    return detail ?? "gate-resolved";
  }
  await resolveGate(project, gateId, gateReason(view, action));
  if (!target) return "gate-resolved";
  const held = await heldBack(project, target);
  if (held) {
    const note =
      `[unstick] gate resolved on ${target}, but ${held.reason} — not resuming; gate-check ` +
      `dispatches it once the board reads clear`;
    // A board that didn't answer is an anomaly worth the louder level; a board that answered "not
    // yet" is the feature working.
    if (held.unread) console.warn(note);
    else console.info(note);
    return "gate-still-blocked";
  }
  // Reuses the automatic path's own verb, so a resolve-and-resume and a gate-check resume of the
  // same target are the same idempotent call — whichever lands second is absorbed as a no-op.
  const outcome = await resumeStalledEpic(project.id, target);
  await markGateResumed(project, gateId);
  return outcome;
}

/**
 * Why the board says this target must NOT be re-enqueued after the gate closed — undefined when it
 * may be. The whole dispatch rule, not just the blockers: a target can carry a second open human
 * gate, but it can equally be unapproved, abandoned, already in review, or claimed by another
 * operator, and each of those raises the very same "waiting on you" row. Resuming any of them
 * enqueues work execute-epic then refuses at job start — a poison job for work the founder never
 * approved, or a run queued on a machine that doesn't own it. So the manual path applies the
 * automatic path's own predicate ({@link undispatchableReason}), rather than a looser subset of it.
 *
 * Liveness is judged upstream instead ({@link readTargetState}), which exempts THIS escalation's own
 * stalled run — the lease clause of the automatic rule cannot tell that leftover from a foreign
 * holder, and would refuse the resume being asked for.
 *
 * Holding is not a lost resume: the gate is closed and unmarked, which is precisely what gate-check's
 * `plainGateResumes` dispatches once the board clears — on whichever machine may run it. So the wait
 * ends when the founder says it does, and the run starts when the board says it may.
 *
 * FAILS SAFE to held — a board read that didn't land proves nothing about the way being clear. The
 * cost of being wrong that way is one pass of delay; the other way is a parked job.
 */
async function heldBack(project: Project, target: string): Promise<HeldBack | undefined> {
  // `loadAllIssues`, not a bare `bd list`: bd omits gate beads from ordinary listings, and a second
  // gate is exactly the blocker this question exists for — an unread one would answer "clear".
  const board = await loadAllIssues(project.repoPath, { strictGates: true }).catch(() => undefined);
  const bead = board?.find((b) => b.id === target);
  if (!board || !bead) return { reason: "its board row could not be read", unread: true };
  const reason = undispatchableReason(board, bead, await resolveOperator());
  return reason ? { reason } : undefined;
}

/** Why the resume is held, and whether that answer came from the board or from failing to read it. */
interface HeldBack {
  reason: string;
  unread?: boolean;
}

/**
 * Mark the gate as handed back, exactly as gate-check's `dispatchReleased` does after its own
 * dispatch — and for the same reason: a resolved gate stays on its bead FOREVER, so an unmarked one
 * is re-dispatched by `plainGateResumes` on every later pass. Unmarked, a resume the founder made
 * here would be re-run every ten minutes, retrying a run that has since parked or failed on the exact
 * failure the founder was answering.
 *
 * Only after the resume LANDS. A resume that was held back, or that threw, leaves the gate unmarked
 * on purpose: that closed-and-unmarked gate is what makes those cases gate-check's to recover (see
 * the module note).
 *
 * A failed mark is logged, not thrown — the resume happened, and failing the action would report
 * otherwise. The cost is one redundant gate-check dispatch, which `resumeEpic` absorbs; the same
 * trade gate-check itself makes. The mark is a SHARED-board write, so it is pushed like the gate
 * close it follows: unpushed, a second anton reading this board re-dispatches anyway.
 */
async function markGateResumed(project: Project, gateId: string): Promise<void> {
  try {
    await beads.tag(project.repoPath, gateId, [GATE_RESUMED_LABEL]);
    nudgeSync(project, "gate-resumed");
  } catch (e) {
    console.error(`[unstick] failed to mark gate ${gateId} as handed back:`, e);
  }
}

/** What bd records on the gate: which answer ended the wait, traceable back to the row that asked. */
function gateReason(view: EscalationView, action: EscalationAction): string {
  const verb = action === "abandon" ? "the work was abandoned" : "resolved";
  return `Wait ended from the anton board (${verb}) — escalation ${view.id.slice(0, 8)}`;
}

/**
 * Close the gate, treating one that is already closed as done rather than as a failure.
 *
 * Measured on bd 1.1.2: `bd gate resolve` is idempotent — resolving a closed gate exits 0 — so the
 * ordinary "someone got there first" case (the founder ran `bd gate resolve` themselves, another
 * operator clicked, another machine synced it in) needs no special handling at all. What DOES fail is
 * a gate that no longer exists, and that is the same end state: the wait is over. So a failure is
 * re-judged against the gate itself, and only kept when the gate is provably still there and still
 * open — or when bd could not answer, which proves nothing either way (see {@link BeadRead}).
 *
 * The close lands in the LOCAL Dolt working set, so it is pushed like every other operator board
 * write (anton-nowq): heartbeats are pull-only, and nothing else here covers this one — the abandon's
 * own nudge fires BEFORE this write, and a gate blocking work anton doesn't run has no other write at
 * all. Unpushed, teammates keep seeing the wait open and their next sweep raises this same escalation
 * against a question the founder already answered.
 */
async function resolveGate(project: Project, gateId: string, reason: string): Promise<void> {
  try {
    await beads.gateResolve(project.repoPath, gateId, reason);
  } catch (e) {
    const gate = await readBead(project.repoPath, gateId);
    // No write of ours landed, so there is nothing of ours to propagate: a gate already gone or
    // already closed was settled by whoever got there first, and pushing it is theirs.
    if (gate === "missing" || (gate !== "unreadable" && gate.status === "closed")) return;
    throw e;
  }
  nudgeSync(project, "gate-resolve");
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
