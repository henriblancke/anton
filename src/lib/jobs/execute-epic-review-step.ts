/**
 * The pre-PR self-review gate as a formula step (anton-omum — extracted from execute-epic.ts in
 * anton-1lix): a fresh-context reviewer reads THIS run's diff, its blocking findings are fixed on
 * the branch, and only then does the PR open — so the PR the founder merges has already been
 * reviewed once.
 *
 * Beside the park messages it composes ({@link ./execute-epic-review}), because the verdict and what
 * anton says about it are one decision: the message hedges on whether the bead note landed.
 */
import { beads } from "../beads/bd";
import { resolveReviewConfig } from "../projects";
import { updateRun } from "../runs";
import { isForeignRunOwner, isPoisonError } from "./errors";
import { ReviewBlockedError } from "./execute-epic-errors";
import { safe } from "./execute-epic-persist";
import type { RunPreparation } from "./execute-epic-prepare";
import {
  orphanClause,
  reconcileOrphanPullRequest,
  reviewFailureReason,
  reviewParkMessage,
  reviewParkNote,
} from "./execute-epic-review";
import type { EpicRun } from "./execute-epic-run";
import type { RunPhaseCarry, RunStepDispatch } from "./execute-epic-run-step";
import { persistPartialReviewScores, persistReviewScores } from "./review-score";
import { blockingFindings, type ReviewRound } from "./review-gate";

/** The pre-PR self-review gate: dispatch it, then act on the verdict it returns. */
export async function runReviewStep(
  run: EpicRun,
  prep: Extract<RunPreparation, { done: false }>,
  dispatch: RunStepDispatch,
  carry: RunPhaseCarry,
): Promise<void> {
  const { db, clock, repo, runId, targetId: epicBeadId, settings } = run;
  const { cooked, definition, stepCtx } = dispatch;
  const { worktree } = prep;
  // The pre-PR self-review gate (anton-omum): a fresh-context reviewer reads THIS run's
  // diff, its blocking findings are fixed on the branch, and only then does the PR open — so
  // the PR the founder merges has already been reviewed once. The formula says WHERE the
  // gate runs; the project setting still says WHETHER (absent ⇒ on). Nothing about the
  // verdict is persisted as a resume marker on purpose: a parked run that is resumed
  // re-reviews the worktree as it stands now, which is the only state the fixes it just made
  // are visible in. A run that already opened its PR never reaches here — step 0a
  // short-circuits it.
  if (!resolveReviewConfig(settings).enabled) return;
  // Filled by the gate as each round completes, so a gate that THROWS — returning nothing —
  // still leaves this attempt's score history to persist below.
  const gateRounds: ReviewRound[] = [];
  const gate = await definition.handler({ ...stepCtx, rounds: gateRounds }).catch(async (e) => {
    // A throwing gate never reaches persistReviewScores below, so the rounds it DID finish
    // are written here or lost with the attempt — for a poison park (a round-3 death still
    // owes the founder rounds 1 and 2) and equally for a retryable one, where the run is
    // rescheduled and the resumed gate restarts from round 1 with nothing on the board.
    // The score goes on the RUN too, not only the board (anton-cekf): the label is the
    // target's latest across every attempt, so a later rerun would otherwise inherit this
    // one's number and let the breaker judge that run on a review it never had.
    const partialScore = await persistPartialReviewScores(repo, epicBeadId, gateRounds);
    if (partialScore !== undefined) {
      await updateRun(db, clock, runId, { reviewScore: partialScore });
    }
    // EVERY gate failure leaves the run without a PR of its own, so every one of them carries
    // the orphan hazard: a PR a previous attempt opened but never recorded (lost `gh` response
    // or lost setPrRef) stays READY and mergeable with un-reviewed work whether the gate
    // refused the verdict, died on a usage limit, or exhausted its retries. Reconcile before
    // propagating any of them. The one exception is a lease CONFIRMED lost to another machine —
    // that run owns the branch and may have opened this very PR after passing its OWN gate, so
    // drafting it would strand reviewed work with nobody left to ready it again. A lease this
    // run merely couldn't KEEP is not that evidence, and is in fact the only kind reachable
    // here: `lease.assertHeld` — local expiry, `unproven` — is the gate's sole source of
    // RunAlreadyLiveError, and skipping the reconcile on it left the orphan mergeable.
    const orphan = isForeignRunOwner(e)
      ? undefined
      : await reconcileOrphanPullRequest(repo, worktree.branch);
    // Errors anton doesn't compose a park message for are rethrown untouched — the runner keys
    // its backoff (quota reschedule, retry) off the error's TYPE, and wrapping them would lose
    // that. What the reconcile found rides out on the run row instead (see {@link settleRunRow}).
    if (!isPoisonError(e)) {
      run.orphanNotice = orphanClause(orphan);
      throw e;
    }
    // The gate parks for a human on more than a blocking verdict: an unrevertable reviewer
    // commit or a fixer that switched branches throws PoisonError from inside it. Those need
    // the SAME parked-run handling — the instruction on both is repair by hand, then resume —
    // so they are re-thrown as a gate block. Left as-is they marked the run `failed`, which
    // hides the row from findOpenRunForEpic, and the resume the human was told to do would
    // start a REPLACEMENT run instead of continuing this one and its session history.
    throw new ReviewBlockedError(`${e.message}${orphanClause(orphan)}`, { cause: e });
  });
  // The gate's verdict is the only reason this step exists; a handler that returned none is
  // an anton bug, not a run outcome, so it fails loud rather than opening an unreviewed PR.
  const review = gate.facts?.review;
  if (!review) {
    throw new Error(
      `formula step "${cooked.id}" (step:review) returned no verdict — refusing to open a PR ` +
        `on an unreviewed run`,
    );
  }
  // The score history belongs to the board, not this run's logs — written on both exits the gate
  // RETURNS from, since a run parked on blocking findings is exactly the one whose score the
  // founder needs. The throwing exit is covered by the gate's own catch above.
  const reviewScore = await persistReviewScores(repo, epicBeadId, review);
  // ...and on the run row, which is what the score-regression breaker reads: one score per
  // ATTEMPT, so a rerun that settles unreviewed reads as a gap rather than as its target's
  // older score (see picker-score-breaker.ts).
  if (reviewScore !== undefined) {
    await updateRun(db, clock, runId, { reviewScore });
  }

  const blocking = blockingFindings(review.unresolved);
  // Three states must not become a PR: blocking findings the converge loop couldn't clear, a
  // reviewer that broke the report protocol (silence — or a review that edited the code it was
  // judging — is not a clean review), and a score regression the alarm stopped the loop on
  // (anton-i98r). All three park for the founder like a no-delivery ticket does, with the
  // reason on the bead so the board shows why rather than only the run log.
  if (
    blocking.length > 0 ||
    review.outcome === "protocol-violation" ||
    review.outcome === "score-regression"
  ) {
    const orphan = await reconcileOrphanPullRequest(repo, worktree.branch);
    // The advisories go on the bead with them: this run opens no PR, so its body — their only
    // other home — never exists, and the resumed run starts its review with an empty carry.
    const parkedAdvisories = review.unresolved.filter((f) => f.severity === "advisory");
    const note = reviewParkNote(review, blocking, parkedAdvisories, orphan);
    // Whether that write landed decides what the park reason can honestly say: a locked bd DB
    // would otherwise discard the findings' only copy while the run error told the founder to
    // read them on the bead (see reviewParkMessage).
    const noted = await safe(() => beads.note(repo, epicBeadId, note));
    throw new ReviewBlockedError(
      reviewParkMessage({
        targetId: epicBeadId,
        outcome: review.outcome,
        reason: reviewFailureReason(review, blocking),
        note,
        noted,
        orphan,
      }),
    );
  }
  // Advisory findings never park (anton-3apm): they ride along in the PR body so the founder
  // sees them at the merge gate — which is why they are carried into the steps that follow.
  //
  // Replaces rather than accumulates, and only because the carry runs BOTH ways: a formula
  // with a second `step:review` seeds that gate with what this one left open (see
  // `reviewStep`), so its reviewer was shown these and its verdict IS the whole open set —
  // one it did not restate is settled, not forgotten. Accumulating here would instead
  // resurrect advisories a later reviewer judged resolved.
  carry.advisories = review.unresolved.filter((f) => f.severity === "advisory");
}
