/**
 * What a run says when its self-review gate refuses the pull request (anton-1lix — extracted from
 * execute-epic.ts): the reason, the orphan-PR reconcile every gate failure owes the branch, and the
 * park note/message the founder actually reads.
 *
 * Kept together because the bead note and the run error must tell ONE story — the message hedges on
 * whether the note landed, so the two are composed side by side rather than in two modules.
 */
import { markPullRequestDraft, lookupOpenPullRequest, type PullRequest } from "../git/ops";
import { describeScoreRegression, formatScoreSeries } from "./review-alarm";
import { findingLines, type ReviewFinding } from "./review-context";
import { finalViolation, type ReviewGateResult } from "./review-gate";

/**
 * Why the gate refused the PR, in one clause — shared by the park note and the thrown error so the
 * bead and the run log say the same thing.
 */
export function reviewFailureReason(review: ReviewGateResult, blocking: ReviewFinding[]): string {
  // Ahead of the blocking count: the alarm is why the loop STOPPED where it did, and a founder
  // reading one sentence in the escalation panel needs the trend, not this round's finding tally.
  // The series rides along here because the run row is the only copy when the bd note fails.
  if (review.regression) {
    return (
      `${describeScoreRegression(review.regression)} — ${formatScoreSeries(review.rounds)}` +
      (blocking.length > 0 ? `, with ${blocking.length} blocking finding(s) still open` : ``)
    );
  }
  if (blocking.length > 0) return `${blocking.length} blocking finding(s) survived the gate`;
  switch (finalViolation(review)) {
    case "worktree-modified":
      return `the reviewer modified the worktree it was judging`;
    case "malformed-findings":
      return `the reviewer's findings list was unreadable`;
    case "missing-rationale":
      return `the reviewer scored the run without justifying the score`;
    case "trailing-content":
      return `the reviewer appended text after its report block`;
    default:
      return `the reviewer never reported a valid score`;
  }
}

/** What the park path found on the run's branch: an untracked PR it defused, or a lookup gh refused. */
export interface OrphanPullRequest {
  /** The untracked PR open on the branch. Absent when the lookup itself failed. */
  pr?: PullRequest;
  /** Whether that PR is now a draft — it already was, or we flipped it. */
  drafted?: boolean;
  /** True when `gh` could not be asked at all, so an orphan may be sitting there un-drafted. */
  lookupFailed?: boolean;
}

/**
 * Defuse a PR a PREVIOUS attempt opened on this branch that never made it onto the bead (anton-3apm).
 *
 * `gh pr create` can succeed server-side with its response — or the best-effort `setPrRef` after it —
 * lost, so a retry finds no PR ref, re-runs, and reaches this gate with a live PR nobody tracks. Park
 * without touching it and un-reviewed work stays mergeable at the founder's merge gate while anton
 * reports no PR was opened: a false green of exactly the kind this gate exists to prevent. Converting
 * it to a draft keeps the PR (number, threads, body) while making it unmergeable until a resumed run
 * passes the gate and `openPullRequest` readies it again.
 *
 * The ref is deliberately NOT stamped onto the bead here: step 0a treats a ref whose PR is OPEN as
 * proof another run finished the epic, so recording it would make the next resume short-circuit as
 * done — retiring the epic with its blocking findings unaddressed.
 *
 * A lookup gh could not answer is reported as such, never as "no PR": the whole point of this pass is
 * that an un-drafted orphan stays mergeable, and telling the founder no PR was opened on the strength
 * of a network blip is the same false green in a quieter form.
 */
export async function reconcileOrphanPullRequest(
  repoPath: string,
  branch: string,
): Promise<OrphanPullRequest | undefined> {
  const { pr, failed } = await lookupOpenPullRequest(repoPath, branch);
  if (failed) return { lookupFailed: true };
  if (!pr) return undefined;
  return { pr, drafted: pr.isDraft === true || (await markPullRequestDraft(repoPath, pr.ref)) };
}

/** What became of an orphan PR, appended to the park message — empty when the branch had none. */
export function orphanClause(orphan: OrphanPullRequest | undefined): string {
  if (!orphan) return "";
  if (orphan.lookupFailed || !orphan.pr) {
    return (
      ` WARNING: anton could NOT check whether an earlier attempt left a PR open on this branch ` +
      `(the \`gh\` lookup failed) — if one is open it is still mergeable with this un-reviewed work. ` +
      `Check the branch by hand.`
    );
  }
  return orphan.drafted
    ? ` A PR an earlier attempt had already opened (${orphan.pr.url}) was converted to a DRAFT so ` +
        `this un-reviewed work can't be merged; it returns to ready when the gate passes.`
    : ` WARNING: a PR an earlier attempt had already opened (${orphan.pr.url}) is still open and ` +
        `could NOT be converted to a draft — draft or close it by hand so this un-reviewed work ` +
        `isn't merged.`;
}

/**
 * The park reason on the RUN row — and, when the bead write failed, the findings themselves.
 *
 * A parked run opens no PR, and the score comments carry counts and a rationale, never the notes:
 * the bead note is the findings' only home. If `bd note` fails (locked or unavailable DB) that home
 * doesn't exist, so the run error stops pointing at the bead and reproduces the whole note instead —
 * the run row is persisted (`updateRun`) and surfaced to the founder, which makes it the durable
 * fallback. Claiming "the findings are on the bead" unconditionally was the data loss: the only copy
 * discarded, under a message that told nobody to go looking.
 */
export function reviewParkMessage(args: {
  targetId: string;
  outcome: ReviewGateResult["outcome"];
  /** {@link reviewFailureReason} — the one-line why, without trailing punctuation. */
  reason: string;
  /** {@link reviewParkNote} — the full findings text this run tried to write to the bead. */
  note: string;
  /** Did that write land? */
  noted: boolean;
  orphan?: OrphanPullRequest;
}): string {
  const head = `${args.targetId} did not pass its pre-PR self-review (${args.outcome}): ${args.reason}.`;
  // The note already carries the orphan clause and the resume instruction, so the fallback branch
  // must not append them a second time.
  return args.noted
    ? `${head} No PR opened — the findings are on the bead; resolve them (or fix the ticket) and ` +
        `resume the run.${orphanClause(args.orphan)}`
    : `${head} No PR opened, and writing the findings to ${args.targetId} FAILED (a locked or ` +
        `unavailable beads DB) — nothing else holds them, so they are reproduced here in full; put ` +
        `them back on the bead by hand before resuming:\n\n${args.note}`;
}

/**
 * The park reason on the target bead: what the reviewer refused to pass, in its own words.
 *
 * The ADVISORIES ride along with the blocking findings, because this note is the only place they
 * survive. A parked run opens no PR — the body is where advisories normally reach the founder — and
 * the resumed run re-reviews from scratch with an empty carry, so an advisory the next reviewer
 * doesn't happen to restate would vanish between the review that found it and the merge gate it was
 * meant to reach. The score comment records their count, never their text.
 *
 * A run parked by the score-regression alarm (anton-i98r) leads with the SERIES instead: each round's
 * comment carries its own score, but nobody deciding rework-vs-accept should have to reassemble the
 * trend from a comment thread to see what the alarm saw.
 */
export function reviewParkNote(
  review: ReviewGateResult,
  blocking: ReviewFinding[],
  advisory: ReviewFinding[],
  orphan?: OrphanPullRequest,
): string {
  const rounds = review.rounds.length;
  const head = review.regression
    ? // The series is the finding here: no single round failed, the trend did — so it leads, and the
      // blocking findings (if any) are listed beneath it as the detail they now are.
      `anton: the pre-PR self-review stopped on a score regression — ` +
      `${describeScoreRegression(review.regression)}. ` +
      `Score series: ${formatScoreSeries(review.rounds)}. No PR was opened; this needs your call, not ` +
      `another fix round.` +
      (blocking.length > 0 ? `\n\nStill open at that point:` : ``)
    : blocking.length > 0
      ? `anton: the pre-PR self-review left ${blocking.length} blocking finding(s) unresolved after ` +
        `${rounds} round(s) (${review.outcome}) — no PR was opened:`
      : violationParkHead(review, rounds);
  const orphanLine = orphanClause(orphan).trim();
  return [
    head,
    ...findingLines(blocking),
    ``,
    ...(advisory.length > 0
      ? [
          `Advisory findings from the same review (${advisory.length}) — they did not park the run, ` +
            `but no PR carries them, so they are recorded here:`,
          ...findingLines(advisory),
          ``,
        ]
      : []),
    ...(orphanLine ? [orphanLine, ``] : []),
    // A protocol violation lists no findings, so there is no "them" to resolve — the head already
    // named the one thing to fix. A regression names no single fault at all: what it asks for is a
    // decision about the work, which is the whole point of escalating instead of grinding.
    review.regression
      ? `Decide what this run needs — rework the ticket, split it, or accept the work as it stands — ` +
        `then resume the run.`
      : blocking.length > 0
        ? `Resolve them (or correct the ticket), then resume the run.`
        : `Correct the issue above, then resume the run.`,
  ].join("\n");
}

/** The park-note headline when the verdict itself was untrustworthy — which way it broke, and why. */
function violationParkHead(review: ReviewGateResult, rounds: number): string {
  switch (finalViolation(review)) {
    case "worktree-modified":
      return (
        `anton: the pre-PR self-review EDITED the worktree it was judging after ${rounds} round(s) ` +
        `— its changes were reverted and its verdict discarded, because a reviewer that fixes the ` +
        `code cannot vouch for it. No PR was opened; check which reviewer this project is using.`
      );
    case "malformed-findings":
      return (
        `anton: the pre-PR self-review reported an unreadable findings list after ${rounds} round(s) ` +
        `(${review.outcome}) — no PR was opened, because a report anton cannot parse may be hiding a ` +
        `blocking finding.`
      );
    case "missing-rationale":
      return (
        `anton: the pre-PR self-review reported a score with no rationale after ${rounds} round(s) ` +
        `(${review.outcome}) — no PR was opened, because a bare number says nothing about which ` +
        `Acceptance criteria were checked. Check that the reviewer emits a "rationale" with its score.`
      );
    case "trailing-content":
      return (
        `anton: the pre-PR self-review appended text AFTER its report block after ${rounds} round(s) ` +
        `(${review.outcome}) — no PR was opened, because trailing prose is where a reviewer retracts ` +
        `or corrects the verdict above it. Check that the reviewer ends its final message with the ` +
        `json block and nothing else.`
      );
    default:
      return (
        `anton: the pre-PR self-review never reported a valid score after ${rounds} round(s) ` +
        `(${review.outcome}) — no PR was opened, because silence is not a clean review.`
      );
  }
}

/**
 * The salvage note for a reused PR whose body could not be refreshed: this run's advisory findings,
 * plus the warning that the PR text belongs to an earlier attempt.
 *
 * The PR body is the ONLY place the findings' text is written — the score comments carry counts, a
 * verdict and a rationale, not the notes — so without this a `gh pr edit` that failed on a permission
 * or a network blip silently discards every actionable detail this review produced, while the founder
 * reads a stale finding list at the merge gate as if it were current.
 */
export function stalePrBodyNote(pr: PullRequest, advisory: ReviewFinding[]): string {
  return [
    `anton: this run reused the PR at ${pr.url} but could NOT rewrite its title/body — what GitHub ` +
      `shows is an earlier attempt's text, not this run's. Read the findings below instead of the PR body.`,
    ``,
    ...(advisory.length > 0
      ? [`Advisory findings from this run's self-review (${advisory.length}):`, ...findingLines(advisory)]
      : [`This run's self-review reported no advisory findings.`]),
  ].join("\n");
}

/**
 * The run-row salvage when BOTH homes for a stale-body run's findings failed: `gh pr edit` refused
 * the refresh AND `bd note` could not record them either (a locked or unavailable beads DB).
 *
 * The run still delivered — the branch and its PR carry the work — so this rides on the completed
 * run row (persisted by `updateRun` and surfaced to the founder) rather than failing it. It
 * reproduces the note IN FULL because at this point nothing else holds the findings' text: the PR
 * body is an earlier attempt's, and the score comment records only their count.
 */
export function stalePrBodyRunError(targetId: string, note: string): string {
  return (
    `The PR body could not be refreshed AND writing this run's self-review findings to ${targetId} ` +
    `FAILED (a locked or unavailable beads DB) — nothing else holds them, so they are reproduced ` +
    `here in full; put them back on the bead by hand:\n\n${note}`
  );
}
