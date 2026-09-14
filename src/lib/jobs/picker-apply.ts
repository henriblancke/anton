/**
 * APPLY: the board-picker starts its top-ranked target (R1.5-R1.7).
 *
 * The pass above this one decides and records; this is the only place it WRITES. It writes exactly
 * what a human approval writes, through the same code: `approved` plus the auto-claim, as one
 * operation under the bead's claim-write lock (`beads/approve-claim.ts`, shared with the approve
 * route), then an enqueue through `enqueueExecuteEpicIfAbsent` — the idempotent path unstick and
 * gate-check already use, so two overlapping passes leave exactly one run — or, where that path
 * finds a run already parked on the target, the same resume unstick would give it.
 *
 * ONE target per pass, the top of the ranking. The plan is a view of the board, never a queue of
 * events (gate-check.ts's rule, which this inherits): "listed" must not read as "start it", so the
 * pass takes the single pick its ranking is confident about and re-decides everything else from a
 * fresh board next cadence, when the brakes, the budget and the operator's vetoes have all had a
 * chance to move.
 *
 * Five things this deliberately does NOT do:
 *
 *   • It never takes a target a HUMAN holds. The plan already excludes claimed targets, and the
 *     guard re-asks under the lock — a claim landing in that window loses the target, not the claim.
 *   • It never writes `approved` speculatively. The label is contingent on the CAS, so a lost claim
 *     race leaves the bead exactly as it found it: unapproved, unclaimed, and startable by whoever
 *     won. Losing is a SKIP, never a retry — retrying into a race is how one target becomes two runs.
 *   • It never bypasses the budget. The enqueue asks for no `bypassBudget`, so a governed project
 *     paces a policy start exactly as it paces a queued one.
 *   • It never outlives its own cancellation. The pass's signal is carried through every seam here,
 *     not just checked before the call, and the queue verbs run through the runner's quiesce gate —
 *     so a project being deleted mid-apply gets its writes taken back rather than a run it has to
 *     sweep and a bead left approved and claimed by anton (see {@link cancelled}) — and the same
 *     check is handed back for the awaits the CALLER spends after a start (see {@link ConfirmStart}).
 *   • It never invents a claim protocol. The bead write-lock and the assignee CAS are the ones the
 *     approve route uses; on an embedded board the mirror they judge is refreshed first, and on
 *     every board with a second writer the reservation is settled and read back before anything is
 *     enqueued (both in `./picker-apply-claim`) — the pass stands down whenever either leg fails.
 *
 * This module is the ORDER those properties come from, and nothing else. Each phase is its own
 * sibling, and the sequence below is the whole argument: the claim protocol, reversible end to end
 * (`./picker-apply-claim`); the brakes that are the last chance to call the start off
 * (`./picker-apply-gate`); and the enqueue and its records, which cannot be taken back
 * (`./picker-apply-start`). The re-checks all three re-ask live in `./picker-apply-checks`.
 */
import { nudgeSync } from "../beads/sync-nudge";
import type { PickerPlanEntry } from "../board-picker-plan";
import { resolveOperator } from "../operator";
import {
  pickerDisarmed,
  pickerStance,
  pickerWipHold,
  pickerWipLimit,
  type PickerDisarmCheck,
  type PickerHoldCheck,
  type PickerStanceCheck,
  type PickerWipLimitCheck,
} from "./picker-apply-checks";
import { claimTarget, settleHeldClaim, type ClaimSettleDeps } from "./picker-apply-claim";
import { confirmStartGate } from "./picker-apply-gate";
import { cancelled, type PickerApplyOutcome } from "./picker-apply-outcome";
import { startRun, type PickerRunOps } from "./picker-apply-start";
import type { AntonDb, Clock } from "./queue";

export {
  pickerDisarmed,
  pickerStance,
  pickerWipHold,
  pickerWipLimit,
  type PickerDisarmCheck,
  type PickerHoldCheck,
  type PickerHoldVerdict,
  type PickerStanceCheck,
  type PickerWipLimitCheck,
} from "./picker-apply-checks";
export { type ClaimSettleDeps } from "./picker-apply-claim";
export {
  type ConfirmStart,
  type PickerApplyOutcome,
  type PickerSkip,
  type PickerStart,
} from "./picker-apply-outcome";
export { pickerStartNote, POLICY_ACTOR, type PickerRunOps } from "./picker-apply-start";

export interface PickerApplyInput {
  db: AntonDb;
  clock: Clock;
  projectId: string;
  repoPath: string;
  /** The plan this pass decided, in rank order. Only its first entry is ever started. */
  entries: readonly PickerPlanEntry[];
  /** The settle seam — production passes none. See {@link ClaimSettleDeps}. */
  settle?: ClaimSettleDeps;
  /**
   * The pass's cancellation, carried THROUGH the apply rather than only checked before it (PR #218
   * review). The refresh, the settle and the claim are seconds of awaits, and a cancel landing in
   * them is `abortProject` tearing the project down: the writes this pass has made must come back
   * off rather than be left on the board of a project that is going away. See {@link cancelled}.
   */
  signal?: AbortSignal;
  /**
   * The two queue verbs a start needs, injectable exactly as unstick's `EpicResumeOps` is, so the
   * scheduled pass routes them through the runner singleton — whose quiesce gate refuses a project
   * mid-teardown — while a test drives them db-directly.
   */
  run?: PickerRunOps;
  /**
   * The standing-approval re-check, defaulting to {@link pickerStance} over this pass's own db. A
   * seam only so a test can drive the withdrawal window without a settings row to race against.
   */
  stance?: PickerStanceCheck;
  /**
   * The safety-brake re-check, defaulting to {@link pickerDisarmed} over this pass's own db. A seam
   * only so a test can latch the freeze inside the window rather than around it.
   */
  disarmed?: PickerDisarmCheck;
  /**
   * The flow-brake re-check, defaulting to {@link pickerWipHold} over this pass's own db. A seam so
   * the scheduled pass can hand down its injected `gh` reader, and so a test can fill the review
   * queue inside the window rather than around it.
   */
  held?: PickerHoldCheck;
  /**
   * The flow brake's limit on its own, defaulting to {@link pickerWipLimit} over this pass's own db.
   * Read on both sides of every hold verdict so a limit the operator moved inside one cannot be
   * spent (PR #218 review); a seam only so a test can move it there.
   */
  wipLimit?: PickerWipLimitCheck;
}

/** The four re-checks this pass re-asks, defaulted over its own db — see `./picker-apply-checks`. */
interface ApplyChecks {
  stance: PickerStanceCheck;
  disarmed: PickerDisarmCheck;
  held: PickerHoldCheck;
  wipLimit: PickerWipLimitCheck;
}

/**
 * Resolve the four re-check seams. Each defaults to the reader over this pass's own db and is
 * overridable only so a test can move the answer INSIDE the window rather than around it — and so
 * the scheduled pass can hand the flow brake its injected `gh` reader.
 */
function resolveChecks(input: PickerApplyInput): ApplyChecks {
  const { db, projectId, repoPath, signal } = input;
  return {
    stance: input.stance ?? pickerStance(db, projectId),
    disarmed: input.disarmed ?? pickerDisarmed(db, projectId),
    held: input.held ?? pickerWipHold(db, { projectId, repoPath, ...(signal ? { signal } : {}) }),
    wipLimit: input.wipLimit ?? pickerWipLimit(db, projectId),
  };
}

/**
 * Start the plan's top-ranked target: approve it, claim it, enqueue its run, and record why.
 *
 * The caller owns the decision to CALL this — the armed level, the disarms, the WIP hold; all three
 * are re-asked here before the enqueue, because the window between that entry gate and this write is
 * long enough for any of them to move. What is owned here is that the start is atomic, idempotent
 * and reversible: no label without a claim, no second run behind an overlapping pass, and nothing
 * left half-written when the enqueue falls over.
 *
 * The four phases below are ordered by what they can undo. The claim protocol and the brakes can
 * both stand the pass down and put its writes back; the enqueue cannot, so it goes last and every
 * doubt is spent before it.
 */
export async function applyPickerPlan(input: PickerApplyInput): Promise<PickerApplyOutcome> {
  const { db, clock, projectId, repoPath, entries, signal } = input;
  const top = entries[0];
  if (!top) return { skipped: { reason: "the plan ranked nothing to start" } };

  const { stance, disarmed, held, wipLimit } = resolveChecks(input);

  // Publish this pass's writes on EVERY path that made one, not only the started one (PR #218
  // review). A skip is not a no-op once the approval and the claim have landed: unpublished, they
  // are invisible to the second machine, whose next pass then reads the target as free — the very
  // double-start the refresh and the settle spend a round trip each to prevent.
  const publish = () => nudgeSync({ id: projectId, repoPath }, "picker-apply");

  // This machine's identity, exactly as the approve route resolves it: the assignee a run's ownership
  // gate reads. Without one the pass REFUSES to start anything (PR #218 review): the assignee is the
  // whole cross-machine guard, and an undefined one makes the CAS an unassigned→unassigned no-op that
  // settles nothing — two pickers would both approve and both enqueue the same target. A human
  // approving by hand is present to see that; an unattended start has only the claim as its proof.
  const operator = await resolveOperator();
  if (!operator) {
    const reason =
      "this machine has no claim identity to start work under — set ANTON_OPERATOR (or a global " +
      "git user.name)";
    return { skipped: { beadId: top.beadId, reason } };
  }

  // The cheapest cancel to honour: nothing is written yet, so a pass cancelled while it resolved its
  // identity stands down with no board state of its own to take back.
  if (cancelled(signal)) {
    const reason = "the pass was cancelled before it claimed anything";
    return { skipped: { beadId: top.beadId, reason } };
  }

  const claimed = await claimTarget({
    repoPath,
    beadId: top.beadId,
    operator,
    stance,
    disarmed,
    publish,
  });
  if (!("standDown" in claimed)) return claimed;

  const settled = await settleHeldClaim(claimed, {
    repoPath,
    beadId: top.beadId,
    operator,
    stance,
    ...(input.settle ? { settle: input.settle } : {}),
  });
  if (!("settled" in settled)) return settled;

  const gate = await confirmStartGate({
    repoPath,
    beadId: top.beadId,
    operator,
    claimed,
    stance,
    disarmed,
    held,
    wipLimit,
    settledBoard: settled.settled,
    ...(signal ? { signal } : {}),
  });
  if (!("board" in gate)) return gate;

  return startRun({
    db,
    clock,
    projectId,
    repoPath,
    entry: top,
    ranked: entries.length,
    claimed,
    publish,
    ...(signal ? { signal } : {}),
    ...(input.run ? { run: input.run } : {}),
  });
}
