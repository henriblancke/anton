/**
 * What an apply pass ANSWERS with — the outcome shapes every phase of the start hands back, and the
 * cancellation each of them re-asks.
 *
 * Split out of `picker-apply.ts` so a phase module can name an outcome without importing the
 * orchestrator that composes them (which imports the phases, so the other direction is a cycle).
 */

/** What one pass started: the pick, where it stood, and the run it enqueued. */
export interface PickerStart {
  beadId: string;
  rank: number;
  rule: string;
  jobId: string;
}

/**
 * Why a pass started nothing, and whether it left anything behind.
 *
 * `wroteBoard` is the caller's cue that this skip still moved the board (PR #218 review): a target
 * an already-live run covers keeps the approval and the claim, and an unwind that could not finish
 * leaves part of them. Both are inputs to the plan's freshness fence, so a caller that stamped a
 * plan before the apply has to re-stamp it exactly as it does after a start.
 */
export interface PickerSkip {
  beadId?: string;
  reason: string;
  wroteBoard?: boolean;
}

/**
 * Re-ask the teardown question once the CALLER's own post-apply awaits are done (PR #218 review).
 *
 * `applyPickerPlan` re-checks the sweep at every seam of its own audit writes, but its last check is
 * still before it returns — and the caller then spends a board read of its own restamping the plan.
 * A cancel landing in that window is `abortProject` deleting the run this pass's writes cover, which
 * would leave the approval and the claim standing over nothing. Answers with the skip the pass
 * became, or undefined while the run stands.
 *
 * Carried by BOTH outcomes that leave writes on the board: the start, and the skip that deferred to
 * a run already covering the target (PR #218 review). Teardown deletes that covering run exactly as
 * readily as a fresh one, and the approval and the claim are just as orphaned either way.
 */
export type ConfirmStart = () => Promise<PickerApplyOutcome | undefined>;

/**
 * One apply pass's outcome. A skip is a VALUE and carries its reason: a pass that starts nothing is
 * the common case (a moved board, a claim lost, a run already covering the target), and it has to be
 * readable in the log without being an error.
 */
export type PickerApplyOutcome =
  | { started: PickerStart; confirmStart: ConfirmStart }
  | { skipped: PickerSkip; confirmStart?: ConfirmStart };

/**
 * Whether the pass has been cancelled — asked at every seam that separates two of its writes, not
 * once before the first (PR #218 review).
 *
 * The caller's pre-call gate only proves the pass was live when the apply STARTED. What follows is
 * seconds of I/O — a mirror refresh, the CAS, the settle window — and a cancel landing anywhere in
 * it is `abortProject`: the project's queued rows are being deleted, so a run enqueued after it is
 * one teardown deletes (leaving an approved, anton-claimed bead behind) or one that trips teardown's
 * own leftover guard. Both are avoided the same way — stop, and take back whatever was written.
 */
export function cancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** One wording for every stand-down in the window between the claim and the enqueue. */
export const CANCELLED_BEFORE_ENQUEUE = "the pass was cancelled before its run was enqueued";
