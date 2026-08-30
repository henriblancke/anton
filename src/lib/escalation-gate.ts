/**
 * The one stall whose answer is not really about the run: a wait on a PERSON (`needs-human`). It
 * hangs on a gate, so both verbs close the gate as well as acting on the work.
 *
 * WHICH work that is, the frozen snapshot cannot say — a gate outlives a reparent — so neither verb's
 * liveness veto is applied to the ancestor it froze; each re-derives its own target and re-reads the
 * lease there ({@link gateDispatch} for the resume, `abandonTicket`'s `requireStopped` for the
 * abandon), which is also what stops a run on the bead the gate LEFT from vetoing an answer it has
 * nothing to do with.
 *
 * Resume is resolve-and-resume — "I did it, carry on" — and closes the gate FIRST, because
 * execute-epic re-reads the board and a run enqueued against an open gate simply parks on the same
 * wait again. For the same reason it re-derives from the live board WHICH target the gate now
 * releases, and resumes only once that board says it may run — the automatic path's own dispatch
 * rule, not a subset of it (see {@link gateDispatch}); anything else still holding it means the
 * founder's answer ends that one wait and nothing more. A resume that DOES land marks handed back
 * ({@link markGatesResumed}) EVERY closed gate that target now covers, not just the one answered,
 * because a closed gate left unmarked is re-dispatched by gate-check forever.
 *
 * Abandon closes the gate LAST, after the bead: a gate that closes over an open bead hands the work
 * straight back to gate-check's own resume, which is the opposite of an abandon. Either way the gate
 * must close, because it is not on the bead's lifecycle — left open it keeps `detectOpenHumanGates`
 * raising this same escalation every sweep, against work that has since been settled. Dismiss is
 * deliberately NOT offered — and refused in escalation-actions.ts, not merely hidden in the panel: a
 * wait on a person is not something to acknowledge and leave open, and a dismissal that left the gate
 * open would settle the row into a board that raises it again on the next sweep, forever.
 */
import { beads } from "./beads/bd";
import { loadAllIssues } from "./beads/issues";
import { nudgeSync } from "./beads/sync-nudge";
import {
  beadBlockedByGate,
  gatesReleasingTarget,
  GATE_RESUMED_LABEL,
  runTargetAbove,
  undispatchableReason,
} from "./jobs/gate-targets";
import { systemClock } from "./jobs/queue";
import { resolveOperator } from "./operator";
import { actOnBead, readBead } from "./escalation-work";
import type { Bead } from "./beads/bd";
import type { EscalationAction, EscalationView } from "./escalations";
import type { Project } from "./types";

/**
 * What an applied verb reports back. `detail` is the fixed key the panel has copy for; `note` is the
 * prose behind it, carried only where that key alone would MISLEAD.
 *
 * Which today means the hold, and so lives here: `gate-still-blocked` covers a target that is
 * unapproved, abandoned, claimed by another operator, already in review, blocked by a second gate,
 * running on another machine, or on a board that wouldn't read — and only one of those is a blocker
 * that clears on its own. One line of copy for all of them promises a recovery that mostly never
 * comes. The reason is already prose for exactly this purpose ({@link undispatchableReason}), so it
 * is handed on to the operator rather than left in the server log.
 */
export interface Applied {
  detail: string;
  note?: string;
}

/**
 * Both answers to a wait on a person — the founder's "I did it, carry on" and their "this isn't
 * happening" — which share one act: closing the gate. Neither answer is complete without it (see the
 * module note), and the ORDER around the work is what makes each of them mean what it says.
 *
 * `target` is the escalation's frozen pointer and only ever a HINT: absent when the gate blocks nothing
 * anton runs — a molecule step, a bead this board read doesn't carry — and dropped when that work
 * settled itself since the sweep.
 */
export function answerGateWait(
  project: Project,
  action: EscalationAction,
  view: EscalationView,
  gateId: string,
  target?: string,
): Promise<Applied> {
  return action === "abandon"
    ? abandonGateWait(project, view, gateId, target)
    : resumeGateWait(project, view, gateId, target);
}

/**
 * "This isn't happening": close the bead, then the gate.
 *
 * That order is what keeps the gate safe from a stale abandon: a wait on a person can sit on the
 * panel for days, long enough for its bead to be reparented under a run target another machine now
 * holds, and `abandonTicket`'s `requireStopped` refuses on that target's live lease (see `stopRun`) —
 * before the bead is closed and therefore before the gate is.
 */
async function abandonGateWait(
  project: Project,
  view: EscalationView,
  gateId: string,
  target?: string,
): Promise<Applied> {
  const detail = target ? await actOnBead(project, "abandon", view, target) : undefined;
  await resolveGate(project, gateId, gateReason(view, "abandon"));
  return { detail: detail ?? "gate-resolved" };
}

/**
 * "I did it, carry on": close the gate, then restart whatever it was holding.
 *
 * The resume asks the live board which target the gate releases NOW ({@link gateDispatch}) before
 * deciding there is nothing to restart — even when the frozen pointer is gone. The gate's own `blocks`
 * edge outlives the ancestor the sweep froze, so a bead reparented out from under a since-closed epic
 * still has a run target, and that is the one this answer releases. Closing the gate is the whole
 * answer only when that read finds nothing — the wait was on the person either way.
 */
async function resumeGateWait(
  project: Project,
  view: EscalationView,
  gateId: string,
  target?: string,
): Promise<Applied> {
  await resolveGate(project, gateId, gateReason(view, "resume"));
  const dispatch = await gateDispatch(project, gateId, target);
  if (dispatch.verdict === "nothing") {
    console.info(
      `[unstick] gate ${gateId} resolved, but it no longer releases anything anton runs — not resuming`,
    );
    return { detail: "gate-resolved" };
  }
  if (dispatch.verdict === "hold") return reportHold(dispatch);
  // Reuses the automatic path's own verb, so a resolve-and-resume and a gate-check resume of the
  // same target are the same idempotent call — whichever lands second is absorbed as a no-op.
  const outcome = await actOnBead(project, "resume", view, dispatch.target);
  await markGatesResumed(project, dispatch.gates);
  return { detail: outcome };
}

/** The gate closed but nothing was restarted, and why — for the log and for the panel. */
function reportHold(dispatch: Extract<GateDispatch, { verdict: "hold" }>): Applied {
  const on = dispatch.target ? ` on ${dispatch.target}` : "";
  // The suffix names what gate-check is actually waiting on: an unread board clears on the next
  // read, every other hold clears only when its own condition does (approval, a claim, a second
  // blocker). Promising "the board reads clear" for those sends the operator hunting a transient
  // read problem instead of the thing that needs their attention.
  const line =
    `[unstick] gate resolved${on}, but ${dispatch.reason} — not resuming; ` +
    `gate-check dispatches it once ${dispatch.unread ? "the board reads clear" : "the hold clears"}`;
  // A board that didn't answer is an anomaly worth the louder level; a board that answered "not
  // yet" is the feature working.
  if (dispatch.unread) console.warn(line);
  else console.info(line);
  // The reason goes back with the detail (see {@link Applied}), not just into this log. "Still
  // blocked" is the only hold the panel's one line describes truthfully, and it is not the common
  // one: a founder told the work resumes "once that clears" for a target they never approved is
  // waiting on an event that never fires.
  return { detail: "gate-still-blocked", note: dispatch.reason };
}

/**
 * What the resolve-and-resume does next, decided against the LIVE board:
 *   • `run`     — this is the run target the gate now releases, and the board says it may run. `gates`
 *                 is every closed gate that one run hands back (see {@link markGatesResumed}).
 *   • `hold`    — it may not, and why (with `unread` when the board itself is what didn't answer). The
 *                 target is unnamed when the board went unread AND the escalation left no pointer to
 *                 name it by.
 *   • `nothing` — the gate no longer releases anything anton runs, so there is nothing to resume.
 */
type GateDispatch =
  | { verdict: "run"; target: string; gates: string[] }
  | { verdict: "hold"; target?: string; reason: string; unread?: boolean }
  | { verdict: "nothing" };

/**
 * WHICH target the closed gate releases, and whether the board lets it run.
 *
 * Re-derived rather than taken from the escalation's frozen `epicBeadId`, because a gate blocks a
 * BEAD and the thing anton runs for that bead is whatever run target sits above it NOW. Reparenting
 * is a supported move (the gardener's apply steps, `beads.reparent`), so the ancestor the sweep froze
 * can have stopped being the run target while this row sat on the panel. Resuming it would run the
 * wrong feature and then mark the gate handed back — and since gate-check skips a marked gate, the
 * bead's real run target would never be released at all. So the mapping is recomputed with the
 * automatic path's own two helpers ({@link beadBlockedByGate} → {@link runTargetAbove}), and the mark
 * that follows a landed resume belongs to whatever they name.
 *
 * The frozen target stands in only when this read cannot map the gate to a bead at all (see
 * {@link unmappedGate}).
 *
 * Holding is not a lost resume: the gate is closed and unmarked, which is precisely what gate-check's
 * `plainGateResumes` dispatches once the board clears — on whichever machine may run it. So the wait
 * ends when the founder says it does, and the run starts when the board says it may.
 *
 * FAILS SAFE to held — a board read that didn't land proves nothing about the way being clear. The
 * cost of being wrong that way is one pass of delay; the other way is a parked job.
 */
async function gateDispatch(
  project: Project,
  gateId: string,
  frozen?: string,
): Promise<GateDispatch> {
  const read = await readGateBoard(project.repoPath);
  if ("hold" in read) return unreadBoard(read.hold, frozen);
  const { board } = read;
  const blocked = beadBlockedByGate(board, gateId);
  const frozenRow = frozen ? board.find((b) => b.id === frozen) : undefined;
  const target = blocked ? runTargetAbove(board, blocked.id) : frozenRow;
  if (!target) return unmappedGate(blocked, frozen);
  return dispatchVerdict(board, gateId, target);
}

/** A board read that didn't land — held, on whatever target the escalation could still name. */
function unreadBoard(reason: string, frozen?: string): GateDispatch {
  return { verdict: "hold", target: frozen, unread: true, reason };
}

/**
 * The shared board, re-read for the dispatch decision.
 *
 * Pull before reading, exactly as `readTargetState` and the runner's own `liveRunCheck` do: the local
 * Dolt working set trails the shared remote by a sync heartbeat, so a lease another machine published
 * while the gate was closing reads as absent here and the liveness check would answer "clear" on an
 * unread board. A pull that didn't land is that same unread board.
 *
 * `loadAllIssues`, not a bare `bd list`: bd omits gate beads from ordinary listings, and a second
 * gate is exactly the blocker this question exists for — an unread one would answer "clear".
 */
async function readGateBoard(repoPath: string): Promise<{ board: Bead[] } | { hold: string }> {
  const pulled = await beads.pull(repoPath).then(
    () => true,
    () => false,
  );
  if (!pulled) return { hold: "the shared board could not be re-read" };
  const board = await loadAllIssues(repoPath, { strictGates: true }).catch(() => undefined);
  return board ? { board } : { hold: "its board could not be read" };
}

/**
 * The gate maps to no run target at all.
 *
 * A gate this board DOES map has answered the question itself — the gate was moved onto work anton
 * doesn't run — and so has one with no frozen pointer left to fall back on: the escalation named no
 * run target, or the one it named has since been deleted or closed by hand, and the `blocks` edge
 * this read followed found nothing above it either. Only a pointer the board could not confirm is an
 * unread board.
 */
function unmappedGate(blocked: Bead | undefined, frozen?: string): GateDispatch {
  return blocked || !frozen
    ? { verdict: "nothing" }
    : unreadBoard("its board row could not be read", frozen);
}

/**
 * Whether the board lets that target run — the whole dispatch rule, not just the blockers.
 *
 * A target can carry a second open human gate, but it can equally be unapproved, abandoned, already
 * in review, or claimed by another operator, and each of those raises the very same "waiting on you"
 * row. Resuming any of them enqueues work execute-epic then refuses at job start — a poison job for
 * work the founder never approved, or a run queued on a machine that doesn't own it. So the manual
 * path applies the automatic path's own predicate ({@link undispatchableReason}), rather than a
 * looser subset of it.
 *
 * Liveness is re-judged HERE, on whatever target the read above names — not only upstream in
 * `readTargetState`. That check ran a gate close and a board load ago, and this is the last look
 * before anything is enqueued: another anton sharing this board sees the same closed gate, and its
 * gate-check dispatches from the same rule, so the target can have been claimed inside that window.
 * Missing it enqueues a second execute-epic for work already running elsewhere — one that can only
 * retry behind the foreign lease and sit queued or parked until someone clears it. No exemption for
 * the frozen target, unlike upstream: a wait on a PERSON names no run of its own
 * (`detectOpenHumanGates` records no `runId`), so there is no leftover lease of ours to mistake for a
 * holder — every live lease here is another machine's, whether the gate stayed put or the board moved
 * it.
 */
async function dispatchVerdict(
  board: Bead[],
  gateId: string,
  target: Bead,
): Promise<GateDispatch> {
  const reason = undispatchableReason(board, target, await resolveOperator());
  if (reason) return { verdict: "hold", target: target.id, reason };
  if (beads.isRunLive(target, systemClock.now())) {
    return { verdict: "hold", target: target.id, reason: "another machine is running it" };
  }
  // The answered gate is included whatever the board says about it: the resolve landed before this
  // read, and a gate that maps to no bead at all (the frozen fallback above) is covered by this run
  // just the same.
  const covered = gatesReleasingTarget(board, target.id).map((gate) => gate.id);
  return {
    verdict: "run",
    target: target.id,
    gates: covered.includes(gateId) ? covered : [gateId, ...covered],
  };
}

/**
 * Mark the gates as handed back, exactly as gate-check's `dispatchReleased` does after its own
 * dispatch — and for the same reason: a resolved gate stays on its bead FOREVER, so an unmarked one
 * is re-dispatched by `plainGateResumes` on every later pass. Unmarked, a resume the founder made
 * here would be re-run every ten minutes, retrying a run that has since parked or failed on the exact
 * failure the founder was answering.
 *
 * EVERY gate the resumed target covers, not only the one the founder answered ({@link
 * gatesReleasingTarget}). Two waits on one target are answered one at a time — the first closes and
 * holds, the second closes and runs — so the run this marks is the one that releases both. The
 * automatic path reaches the same end state by dispatching once per gate and marking each; marking
 * only the second here would leave the first closed and unmarked over work that is now running.
 *
 * Only after the resume LANDS. A resume that was held back, or that threw, leaves the gates unmarked
 * on purpose: that closed-and-unmarked gate is what makes those cases gate-check's to recover (see
 * the module note).
 *
 * A failed mark is logged, not thrown — the resume happened, and failing the action would report
 * otherwise. The cost is one redundant gate-check dispatch, which `resumeEpic` absorbs; the same
 * trade gate-check itself makes. The marks are SHARED-board writes, so they are pushed like the gate
 * close they follow: unpushed, a second anton reading this board re-dispatches anyway.
 */
async function markGatesResumed(project: Project, gateIds: string[]): Promise<void> {
  let marked = false;
  for (const gateId of gateIds) {
    try {
      await beads.tag(project.repoPath, gateId, [GATE_RESUMED_LABEL]);
      marked = true;
    } catch (e) {
      console.error(`[unstick] failed to mark gate ${gateId} as handed back:`, e);
    }
  }
  // One nudge for the batch — a push carries whatever landed, and a batch where every write failed
  // has nothing to propagate.
  if (marked) nudgeSync(project, "gate-resumed");
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
 * open — or when bd could not answer, which proves nothing either way (see `BeadRead`).
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
