/**
 * Rework: send a ticket back with instructions (anton-4ocm).
 *
 * A self-review scores every run, but until now acting on a bad score meant a hand-typed `bd note` +
 * `bd reopen` in a terminal — so the loop the score was supposed to close stayed open. This module
 * is that action, in one call, with the provenance the board needs to stay honest afterwards:
 *
 *   • REOPEN — the acceptance was never actually met. The same bead runs again, carrying the
 *     founder's instructions as a human note and a `--reason` on the reopen event. Its earlier
 *     rounds keep their scores, because they scored the work that was actually delivered then.
 *   • FOLLOW-UP — the acceptance WAS met and the founder wants another pass. A NEW bead carries the
 *     instructions, linked `discovered-from` the original, so the original's score stays attached to
 *     what it shipped instead of being re-earned by later work.
 *
 * The choice is the caller's and is never inferred: which of the two is right is a judgement about
 * whether the ticket lied about being done, and only a human reading the review can make it.
 *
 * Both paths land the instructions as a HUMAN note, because that is the channel the dispatch prompt
 * already reads (`humanNotesPromptBlock`, lib/jobs/step-registry.ts) — so the implementer that picks
 * the bead up next is shown the steer without a new prompt seam.
 *
 * Neither path means anything unless the target can RUN again, which is what the target's own pull
 * request decides (anton-leit) — see {@link resolvePipeline}.
 */
import { beads, LABELS, type Bead } from "./beads/bd";
import { withBeadWriteLocks } from "./beads/claim-lock";
import { ACCEPTANCE_HEADING } from "./beads/contract";
import { refreshAllIssues } from "./beads/issues";
import { formatHumanNote, parseTicketNotes } from "./beads/notes";
import { nudgeSync } from "./beads/sync-nudge";
import { pullRequestState, type PullRequestState } from "./git/ops";
import { runIsLiveForTarget } from "./jobs/service";
import type { ReviewFinding } from "./jobs/review-context";
import { resolveOperator } from "./operator";
import { isBoardCard, runTickets } from "./ticket-view";
import {
  MAX_REWORK_INSTRUCTIONS_CHARS,
  MAX_REWORK_SUMMARY_CHARS,
  type Project,
  type ReworkMode,
  type ReworkPipeline,
  type ReworkResult,
} from "./types";

/** The founder's decision, as the route receives it. */
export interface ReworkInput {
  /** The ticket being sent back — the run target itself, or one of the tickets under it. */
  ticketId: string;
  mode: ReworkMode;
  /** One line: the reopen's `--reason`, or the follow-up bead's title. */
  summary: string;
  /** What to actually do — inlined verbatim into the implementer's prompt. */
  instructions: string;
  /** Findings the founder selected from the review report, appended to the instructions. */
  findings?: ReviewFinding[];
}

/** The request itself is malformed (missing/oversized text) — the caller's fault (400). */
export class ReworkInvalidError extends Error {}

/** The bead exists but this rework can't apply to it (422): not a run target, not one of its tickets. */
export class ReworkNotAllowedError extends Error {}

/**
 * The target moved under this request, so the send-back would race it (409). Two ways that happens:
 * a run is executing the target right now ({@link assertNoLiveRun}), or its pull request stopped
 * being open while the writes were landing ({@link retireFinishedRun}). Both are answered the same
 * way — look again and send it back — which is what makes them one status.
 */
export class ReworkConflictError extends Error {}

/** Nothing on the board answers to that id (404). */
export class ReworkNotFoundError extends Error {}

/**
 * The target's PR state can't be read, so this send-back can't be decided — or, once its writes had
 * landed, stood behind (503). Whether that PR merged is the difference between re-running the target
 * and opening the work as its own target, and guessing either way strands the send-back — so it
 * fails loud instead, before the writes ({@link assertPrStillOpen}) or by undoing them
 * ({@link retireFinishedRun}). Distinct from {@link ReworkConflictError} throughout: an unreadable
 * `gh` is not evidence the PR moved, and the fix is `gh`, not another send-back.
 */
export class ReworkUnavailableError extends Error {}

/**
 * Labels a follow-up inherits from the ticket it came from. Routing, not state: `agent:` decides
 * which specialist the run dispatches (and which the agent gate checks), and the rest are the
 * shaping metadata the board filters and sorts on. Everything else is deliberately NOT copied —
 * `approved` is the founder's gate on the new work, `stage:`/`run-lease:`/`review-score:` describe a
 * run the follow-up never had, and `abandoned` would create it already dead.
 */
const INHERITED_LABEL_PREFIXES = ["agent:", "domain:", "risk:", "size:", "area:"];

/**
 * The stage labels a finished run leaves behind, which every send-back strips: `stage:in-review`
 * makes the bead resume-SKIPPED (ticket-view's `resumeSkipped`) and `stage:implementing` makes it
 * derive as in-progress on every board surface. One list, because {@link retireFinishedRun} has to
 * put back exactly what it took off.
 */
const RUN_STAGE_LABELS: string[] = [LABELS.stage("implementing"), LABELS.stage("in-review")];

/**
 * Apply a rework to one ticket of a run target.
 *
 * Idempotent by construction rather than by token: a repeat of the same request finds its own note
 * already on a bead already in the state it wanted (reopen) or its own follow-up already linked
 * (follow-up) and writes nothing, so a double-click leaves one note and one bead. Every check and
 * its write are serialized on the ticket's AND the target's write locks, which is what makes that
 * hold for two requests in flight at once.
 */
export async function reworkTicket(
  project: Project,
  targetId: string,
  input: ReworkInput,
): Promise<ReworkResult> {
  const summary = input.summary?.trim() ?? "";
  const instructions = input.instructions?.trim() ?? "";
  // A missing id is a malformed request (400), not a rework that can't apply (422) — without this it
  // would fall through to the membership check and be reported as `'' is not part of <target>'s run`.
  const ticketId = input.ticketId?.trim() ?? "";
  if (!ticketId) throw new ReworkInvalidError("A ticket to send back is required");
  if (!summary) throw new ReworkInvalidError("A one-line summary is required");
  if (summary.length > MAX_REWORK_SUMMARY_CHARS) {
    throw new ReworkInvalidError(
      `Summary is too long (${summary.length} > ${MAX_REWORK_SUMMARY_CHARS} characters)`,
    );
  }
  if (!instructions) throw new ReworkInvalidError("Fix instructions are required");
  if (instructions.length > MAX_REWORK_INSTRUCTIONS_CHARS) {
    throw new ReworkInvalidError(
      `Instructions are too long (${instructions.length} > ${MAX_REWORK_INSTRUCTIONS_CHARS} characters)`,
    );
  }
  if (input.mode !== "reopen" && input.mode !== "follow-up") {
    throw new ReworkInvalidError(`Unknown rework mode "${String(input.mode)}"`);
  }

  // Force a fresh read, like approve/claim: a mutating decision about what a run contains must not
  // be made from a warm board snapshot that could still show a ticket the last run closed.
  const all = await refreshAllIssues(project.repoPath);
  const target = all.find((b) => b.id === targetId);
  if (!target) throw new ReworkNotFoundError(`Ticket ${targetId} not found on the board`);
  if (!beads.isRunTarget(target, all)) {
    throw new ReworkNotAllowedError(
      `${targetId} is not a run target — rework is decided against a run's review report, so send ` +
        `back a ticket of the feature (or standalone item) that actually ran`,
    );
  }
  const ticket = runMembers(target, all).find((b) => b.id === ticketId);
  if (!ticket) {
    throw new ReworkNotAllowedError(
      `${ticketId} is not part of ${targetId}'s run — only the work that run reviewed can be ` +
        `sent back from its report`,
    );
  }

  // Race-check against a live run, exactly where approve/claim do (409): rework rewrites the ticket
  // set — and the ticket's own status — that a running execute-epic is walking, so applying it
  // mid-run would either be silently overwritten by that run's own close or make it re-dispatch a
  // ticket it is already implementing. Both machines are checked: the local job (what a cancel would
  // reach) and the cross-machine run-lease on the target (the only evidence another host is on it).
  assertNoLiveRun(project.id, target);

  // What the target's own pull request allows, decided BEFORE any write: it can override the mode.
  // Asked only when the answer can change something. A follow-up on a target that is NOT a board
  // card comes out parentless either way ({@link applyFollowUp}) — its own run target, which this
  // target's PR neither carries nor gates — so consulting `gh` there would let an unreachable
  // GitHub (503, {@link ReworkUnavailableError}) block a send-back that never needed it.
  const needsPipeline = input.mode === "reopen" || isBoardCard(target, all);
  const pipeline = needsPipeline
    ? await resolvePipeline(project.repoPath, target, input.mode)
    : undefined;
  const mode = pipeline?.redirected ? "follow-up" : input.mode;

  // Does a lost race have a CHILD's reopen to undo as well as the target's retire? Only a reopen
  // writes to a bead this request may have to put back, and only on a grouped target is that bead
  // distinct from the one the retire's own rollback restores.
  const rollsBackTicket = mode === "reopen" && ticket.id !== target.id;

  // Both beads' write locks, taken together in sorted order (withBeadWriteLocks): the mode's writes
  // land on the ticket while the pipeline reset below lands on the TARGET, and the reset is only
  // correct against a target nothing else is moving. Deduped for a standalone target, where the
  // ticket IS the target.
  const findings = input.findings ?? [];
  const { result, runsUnderTarget, retire, reconciled } = await withBeadWriteLocks(
    project.repoPath,
    [ticket.id, target.id],
    async () => {
      // The target as it stands before ANY write of this request, and the PR the mode was decided
      // against re-read off it — see {@link assertPrStillOpen}. Same guard the retire runs under, so
      // it always precedes it. The snapshot is taken HERE rather than inside {@link
      // retireFinishedRun} because on a standalone target the ticket IS the target: the mode's
      // writes below reopen it and strip its stage labels, so a snapshot taken after them would roll
      // the retire back onto that already-reopened state and leave a merged original open, untagged
      // and outside its own merge finalization.
      let targetBeforeWrites: Bead | undefined;
      let ticketBeforeWrites: Bead | undefined;
      if (pipeline?.outcome === "retired") {
        targetBeforeWrites = await beads.show(project.repoPath, target.id);
        // The reopened CHILD's own pre-write state, for the same rollback and the same reason: on a
        // grouped target the mode moves a bead the target's rollback never touches. Read here, off
        // the same pre-write board, so the two snapshots describe one instant.
        ticketBeforeWrites = rollsBackTicket
          ? await beads.show(project.repoPath, ticket.id)
          : undefined;
        await assertPrStillOpen(project.repoPath, targetBeforeWrites);
      }
      const applied =
        mode === "reopen"
          ? await applyReopen(project, target, ticket, summary, instructions, findings)
          : await applyFollowUp(project, target, ticket, summary, instructions, findings, pipeline);
      // Only retire when the instructions landed on a bead THIS target's run will dispatch: a
      // parentless follow-up is its own run target, so clearing the target's ref and `stage:in-review`
      // would strip the merge gate off a PR that is still open — and hand the claimer a target whose
      // work is already on the branch — to unblock a run that was never going to carry the fix.
      // Attempted even on a no-op double submit: the first request may have written the note and
      // died before the reset, and a repeat that reported "already sent back" over a still
      // short-circuiting target would be the very false green this exists to remove. Idempotent — a
      // target whose ref is already gone has nothing left to retire.
      const retire: RetireResult =
        pipeline?.outcome === "retired" && applied.runsUnderTarget && targetBeforeWrites
          ? await retireFinishedRun(project, targetBeforeWrites, ticketBeforeWrites)
          : { outcome: "not-attempted" };
      return { ...applied, retire };
    },
  );

  // Fire-and-forget, like every other board write behind a route: the writes already landed locally
  // and the run reads local state, so don't block the response on a slow/unreachable remote. The
  // retire counts as a write of its own — it can land on the repeat that finished a half-applied
  // send-back, whose mode step wrote nothing. A retire that was rolled back wrote its own record of
  // why, and a reconcile ({@link AppliedRework}) moved a bead on a request that was otherwise a
  // no-op. Nudged before the throws below, because a rolled-back retire is still a write another
  // machine has to see.
  const retireWrote =
    retire.outcome === "retired" || retire.outcome === "raced" || retire.outcome === "unverifiable";
  if (result.applied || reconciled || retireWrote) {
    nudgeSync(project, "rework");
  }
  // What the rollback undid, in the words the founder needs — the same clause both failures below
  // end on, since on a grouped reopen the child went back with the target.
  const undone = rollsBackTicket
    ? `everything it had applied to ${target.id} and ${ticket.id} was rolled back`
    : `everything it had applied to ${target.id} was rolled back`;
  // `gh` went unreadable across the writes (see {@link retireFinishedRun}). NOT a 409: nothing here
  // says the PR moved, so telling the founder to send it back again would be advice about a race
  // that may never have happened. The remedy is the one {@link assertPrStillOpen} gives for the same
  // answer — fix `gh` — and it is a 503 for the same reason.
  if (retire.outcome === "unverifiable") {
    throw new ReworkUnavailableError(
      `anton could no longer read the state of ${target.id}'s pull request (${retire.pr}) once this ` +
        `send-back's writes had landed, so it could not stand behind them: ${undone}, and the ` +
        `finished-run marker was left in place rather than retired off a PR anton can no longer ` +
        `prove is live. The instructions stay on ${result.reworkedId} as a record; check that ` +
        `\`gh\` is installed and authenticated, then send the ticket back again.`,
    );
  }
  // The PR stopped being open under the request (see {@link retireFinishedRun}). The instructions
  // landed; the send-back itself was refused — and reporting "run it again" over a target whose
  // marker is still in place would be the false green this whole path exists to remove. So it fails
  // loud, with the one thing that fixes it: send it back again, and the fresh read decides the mode
  // correctly.
  if (retire.outcome === "raced") {
    throw new ReworkConflictError(
      `${target.id}'s pull request (${retire.pr}) stopped being open (${retire.state}) while this ` +
        `send-back was applying, so ${undone} and its finished-run marker is still in place rather ` +
        `than retired off a PR anton can no longer prove is live. The instructions stay on ` +
        `${result.reworkedId} as a record; send the ticket back again and anton will re-read the ` +
        `PR — if it merged, the fix runs as its own target instead.`,
    );
  }
  // `retired` is a claim about a write, so it is reported only where that write was the plan. A
  // follow-up that runs as its own target had nothing standing in its way, and saying "run it again"
  // over an untouched target would point the founder at a run that short-circuits.
  const reported = pipeline?.outcome === "retired" && !runsUnderTarget ? undefined : pipeline;
  return { ...result, ...(reported ? { pipeline: reported } : {}) };
}

/**
 * An applied rework, plus the one thing the pipeline reset needs to know: does the bead now carrying
 * the instructions run under THIS target? Only then does retiring the target's finished-run marker
 * ({@link retireFinishedRun}) actually put the work back in front of a runner.
 */
interface AppliedRework {
  result: ReworkResult;
  runsUnderTarget: boolean;
  /**
   * A board write this request made that its own mode didn't ask for — reconciling a follow-up an
   * earlier attempt left in a shape the target's PR has since invalidated ({@link applyFollowUp}).
   * Reported separately because it lands on a request that is otherwise a no-op, and a write that
   * isn't synced is a write another machine never sees.
   */
  reconciled?: boolean;
}

/**
 * The beads a run target's review actually covers: its tickets, or the target itself when it is one
 * unit of work. The same pair epic-detail renders and execute-epic dispatches, so the founder can
 * send back exactly what the reviewer was shown — no more.
 */
function runMembers(target: Bead, all: Bead[]): Bead[] {
  const children = runTickets(all, target.id);
  return beads.groupsChildren(target, children) ? children : [target];
}

/**
 * Refuse while a run holds this target — on this machine or, via the lease label, on any other.
 *
 * A boundary, not a lock, for the same reason `abandonTicket`'s is: a run STARTING in the window
 * between this read and the writes below is absorbed one layer down, where execute-epic re-reads the
 * board at every ticket boundary. What this catches is the case a re-read cannot — a founder acting
 * on a review report while the run that produced it is still writing the beads it names.
 */
function assertNoLiveRun(projectId: string, target: Bead): void {
  if (runIsLiveForTarget(projectId, target.id)) {
    throw new ReworkConflictError(
      `${target.id} has a run in flight — sending its work back now would race the run that is ` +
        `writing it; wait for the run to finish or park it first`,
    );
  }
  if (beads.isRunLive(target, Date.now())) {
    throw new ReworkConflictError(
      `${target.id} is being run on another machine (it holds a live run-lease) — wait for that run ` +
        `to settle before sending its work back`,
    );
  }
}

/**
 * Give the send-back a run path back past the target's own pull request (anton-leit).
 *
 * execute-epic's step 0a finishes an attempt as already-complete the moment the target carries a PR
 * ref whose PR is LIVE — open or merged. That is right for a resume and fatal for a rework: without
 * this, the reopened (or newly parented) bead sits open forever behind a PR nobody is going to
 * re-open it for. The two live states need opposite answers, so the state is READ, never assumed:
 *
 *   • OPEN — the work is on the branch and the PR is still the founder's merge gate. Retire the
 *     target's finished-run marker ({@link retireFinishedRun}) and let it run again on that same
 *     branch: the closed siblings' commits are right there, so they stay skipped, and the PR step
 *     REUSES the open PR (openPullRequest) and refreshes its body with the new round. Retiring is
 *     conditional on the send-back actually landing in that run, which only the mode decides — see
 *     `runsUnderTarget` ({@link AppliedRework}). A follow-up on a standalone target comes out
 *     PARENTLESS ({@link applyFollowUp}) and is its own run target, so this target's run would not
 *     carry the fix and its open PR stays exactly as it is.
 *   • MERGED — the work is on the base branch, so there is nothing to re-run: a fresh worktree
 *     branches off a base that already contains it, and a squash-merge leaves none of the tickets'
 *     `<id>:` commit subjects behind — so execute-epic's commit-presence check would read every
 *     closed sibling as missing and re-dispatch already-shipped work. Merged work can't be
 *     un-shipped, so the send-back becomes its OWN run target instead (a parentless follow-up),
 *     which runs on its own branch and opens its own PR. A requested `reopen` is REDIRECTED there —
 *     reported, not silent — because reopening a bead whose work merged promises a run that can only
 *     go wrong.
 *
 * A CLOSED-unmerged ref is left exactly as it is: step 0a already falls through it, and review-fix
 * leaves it on the bead on purpose so a recovery run can find its way back to that PR.
 *
 * A target an EARLIER send-back already retired has no live ref — but the PR it was retired off is
 * still on the bead ({@link beads.getRetiredPrRef}), and it is read here for the same reason the
 * live one is: that PR can merge in the window between the retire and the rerun that would have
 * re-stamped it, and a second send-back deciding `reopen` off "no ref at all" would promise exactly
 * the run against a merged base this whole function exists to prevent. Retired-and-merged answers
 * `shipped`, like any other merged PR; retired-and-still-open answers nothing, because the marker
 * this would retire is already off the bead.
 *
 * Read here, before the locks, so a slow `gh` isn't held across every other write to these beads —
 * and re-read at the write itself ({@link retireFinishedRun}), because a merge landing in between is
 * the one thing no lock of ours can order.
 */
async function resolvePipeline(
  repo: string,
  target: Bead,
  mode: ReworkMode,
): Promise<ReworkPipeline | undefined> {
  const live = beads.getPrRef(target);
  const pr = live ?? beads.getRetiredPrRef(target);
  if (!pr) return undefined;
  const state = await pullRequestState(repo, pr);
  // Unknown is proof of nothing, and the two live states are handled oppositely — so refuse rather
  // than pick one. Same judgement execute-epic makes at step 0a, where an unreadable ref retries.
  if (state === "unknown") {
    throw new ReworkUnavailableError(
      `anton can't read the state of ${target.id}'s pull request (${pr}) — whether it merged decides ` +
        `whether this ticket re-runs on the target or comes back as its own, so it won't guess; ` +
        `check that \`gh\` is installed and authenticated, then send it back again`,
    );
  }
  if (state === "merged") return { outcome: "shipped", pr, redirected: mode === "reopen" };
  // Only a LIVE ref stands between the bead and its next run, so only a live one can be retired.
  if (state === "open" && live) return { outcome: "retired", pr, redirected: false };
  return undefined;
}

/**
 * Refuse, before ANY write, a send-back whose mode the target's own PR has just invalidated.
 *
 * That PR decides the mode ({@link resolvePipeline}): a `reopen` survives as a reopen only because
 * the PR read as OPEN, and a merge redirects it into a follow-up that runs as its own target. So the
 * state is re-read here — under the lock, ahead of the mode's writes — and not only inside
 * {@link retireFinishedRun}, which runs after them. Checking it there alone checked it too late: a
 * reopen had already written its note, reopened the ticket and stripped its stage labels by the time
 * the race was caught, and on a GROUPED target the rollback reaches none of that — it restores the
 * target, and the reopened bead is one of its children — so the instructed retry opened a standalone
 * follow-up while the original ticket stayed reopened under a merged target that will never dispatch
 * it.
 *
 * Nothing has been written when this refuses, so it records nothing on the board: the target is
 * exactly as its run left it, and the retry decides the mode against a PR that has stopped moving.
 * The window it cannot close is the one no client-side check can — a merge landing between this read
 * and the writes that follow it — which is what the post-write verify and its rollback are for. The
 * rollback covers that window on a standalone target because it restores the pre-write snapshot the
 * caller takes alongside this read ({@link restoreFinishedRun}).
 */
async function assertPrStillOpen(repo: string, target: Bead): Promise<void> {
  // The ref as it is NOW — the caller's under-the-lock read, not the pre-lock snapshot: a rival
  // request that already retired this cycle leaves nothing to invalidate, and the retire below will
  // report it as `already-retired`.
  const pr = beads.getPrRef(target);
  if (!pr) return;
  const state = await pullRequestState(repo, pr);
  if (state === "open") return;
  // Unreadable is not merged, and the remedy differs: `gh` broke between the two reads, so say so
  // rather than reporting a race that may not have happened ({@link resolvePipeline} judges alike).
  if (state === "unknown") {
    throw new ReworkUnavailableError(
      `anton could no longer read the state of ${target.id}'s pull request (${pr}) as this send-back ` +
        `was about to be applied, so nothing was written — whether it merged decides how the ticket ` +
        `comes back, and it won't guess; check that \`gh\` is installed and authenticated, then send ` +
        `it back again`,
    );
  }
  throw new ReworkConflictError(
    `${target.id}'s pull request (${pr}) stopped being open (${state}) while this send-back was ` +
      `being applied, so nothing was written — sending work back to a target whose PR has merged ` +
      `would reopen a ticket nothing will run again. Send the ticket back again and anton will ` +
      `re-read the PR — if it merged, the fix runs as its own target instead.`,
  );
}

/**
 * What {@link retireFinishedRun} settled. `not-attempted` is the caller's own default for the modes
 * that never reach it, so one value answers "did anything happen to the target?".
 */
type RetireResult =
  | { outcome: "retired" | "already-retired" | "not-attempted" }
  /** The PR stopped being open between {@link resolvePipeline} and the writes — nothing was retired. */
  | { outcome: "raced"; pr: string; state: PullRequestState }
  /**
   * `gh` went unreadable across the writes, so the retire could not be VERIFIED — rolled back, and
   * reported apart from `raced` because the remedy differs: nothing here says the PR moved, only
   * that anton stopped being able to see it ({@link assertPrStillOpen} draws the same line).
   */
  | { outcome: "unverifiable"; pr: string };

/**
 * Retire the finished run cycle recorded on the target, so its next run executes instead of
 * short-circuiting. Called only when the reworked bead will run under this target — otherwise these
 * writes cost the still-open PR its merge gate and buy nothing. Three writes, each idempotent:
 *
 *   • `stage:in-review` comes off, because the target is going back to implementing — and while it
 *     is on, review-fix's sweep and gate-check's merge finalization both still treat the target as
 *     one theirs to close out.
 *   • a closed target is reopened, or nothing would dispatch it at all.
 *   • the live PR ref comes OFF (`retirePrRef`) — the marker step 0a reads as "another run already
 *     finished this" — and lands on the same bead's retired-PR key in the SAME write. The PR itself
 *     is untouched and un-notified: the next run pushes to the same branch and re-stamps this very
 *     ref, so the founder keeps one PR and one review thread. Retiring the pointer rather than
 *     deleting it is what keeps the merged-under-the-retire case readable: the PR can merge between
 *     here and that rerun, and a bead with no pointer at all leaves nothing to recognise it by —
 *     {@link resolvePipeline} would read a later send-back as an ordinary reopen, and execute-epic's
 *     step 0a would dispatch work the base branch already carries.
 *
 * That ORDER is the recovery story, not a style choice. The live ref is the only marker that brings
 * a retry back into the retire ({@link resolvePipeline} returns `retired` only for a live one), so
 * it is moved LAST: a failure part-way leaves it in place and the next send-back re-enters and
 * finishes the remaining writes. Retiring it first would strand a target mid-retire with a
 * `stage:in-review` label nothing takes off again and no finalization path (`finalizablePr`,
 * jobs/gate-targets.ts).
 *
 * The state is RE-READ from `gh` around these writes, for the one race the bead locks cannot order:
 * the locks serialize anton's writes, not GitHub's merges, so the PR that was open at
 * {@link resolvePipeline} may merge before this send-back's writes, or WHILE they land. Ahead of
 * them that read is {@link assertPrStillOpen}, which runs before the MODE's writes as well so a
 * reopen a merge has just invalidated never lands; after them it is the verify below. Retiring a
 * MERGED PR's ref would un-gate its own finalization (`finalizablePr` needs the ref AND
 * `stage:in-review`) and re-dispatch shipped work, so a state that is no longer `open` retires
 * nothing: caught before the writes, nothing is written; caught after them, they are rolled back
 * ({@link restoreFinishedRun}) — and so is the reopen the MODE landed on a ticket of this target
 * (`reopened`), which no later write of this request would otherwise put back. Either way the
 * caller turns it into an error the founder can act on. The read that survives is the last one, so
 * what remains open is a merge landing after it — no write of ours follows, and no client-side
 * check can order that against GitHub.
 *
 * Two reads of the target, because the two questions differ. What still NEEDS writing is asked of
 * the board as it is now (`fresh`) — on a standalone target the mode's reopen has already done half
 * of this. What a rollback must PUT BACK is the caller's pre-write snapshot (`before`), taken ahead
 * of the mode's writes: on that same standalone target `fresh` is the reopened, untagged bead, so
 * restoring it would leave a merged original open and outside its own merge finalization.
 *
 * An `anton:` note, not a human one: this is bookkeeping about a PR, and a human note is inlined
 * verbatim into the next implementer's prompt (`humanNotesPromptBlock`) where it would read as a
 * steer. Written only on a round that actually changed something, so a repeat adds no second line.
 */
async function retireFinishedRun(
  project: Project,
  before: Bead,
  /**
   * The reworked TICKET as it stood before this request's writes — passed only for a reopen of a
   * ticket that is not the target itself, the one set of writes the target's own rollback cannot
   * reach. See {@link restoreReworkedTicket}.
   */
  reopened?: Bead,
): Promise<RetireResult> {
  const repo = project.repoPath;
  // Re-read after the mode's writes: what is left to do is a question about the board as it is now.
  const fresh = await beads.show(repo, before.id);
  const pr = beads.getPrRef(fresh);
  if (!pr) return { outcome: "already-retired" };

  const stages = RUN_STAGE_LABELS.filter((l) => before.labels?.includes(l));
  await beads.untag(repo, before.id, RUN_STAGE_LABELS);
  if (fresh.status === "closed") {
    await beads.reopen(repo, before.id, "rework: sent back for another round");
  }
  await beads.retirePrRef(repo, fresh, pr);

  // The same question again, now that the writes have landed: a merge that arrived while they were
  // applying passed the check above and would otherwise be reported as a clean retire — over a
  // target that has already lost the ref and the label its own merge finalizes through. So the
  // retire is verified, not assumed, and an answer that is no longer `open` undoes it. An
  // UNREADABLE answer undoes it too: it is not proof the PR moved, but it is the loss of the proof
  // this write was predicated on, so the writes come off rather than standing on an unverified read.
  const settled = await pullRequestState(repo, pr);
  if (settled !== "open") {
    await restoreFinishedRun(repo, before, pr, stages, settled);
    if (reopened) await restoreReworkedTicket(repo, reopened, before.id, pr, settled);
    await noteRace(repo, before.id, pr, settled);
    return settled === "unknown"
      ? { outcome: "unverifiable", pr }
      : { outcome: "raced", pr, state: settled };
  }
  await beads.note(
    repo,
    before.id,
    `anton: rework — ${pr} is still open, so this target's finished-run marker was retired and it ` +
      `runs again. The next run continues on the same branch and updates ${pr} rather than opening ` +
      `a second one.`,
  );
  return { outcome: "retired" };
}

/**
 * Put the target back to `before` — the state it was in before this request wrote anything — when
 * the PR the retire was predicated on stopped being provably open underneath it. That is the
 * retire's three writes, and on a STANDALONE target the mode's own reopen too, because there the
 * ticket is the target and both sets of writes moved the same bead. The ORDER is the recovery story
 * again, mirrored: the live PR ref goes back LAST, because it is the mark that makes a target
 * DISPATCHABLE as a finished one — `finalizablePr` and every in-review surface read it first — and
 * nothing else here can be retried once it is exposed. Retiring it is the write a retry re-enters
 * ({@link resolvePipeline} answers `retired` only for a live ref); RESTORING it is not, because by
 * then the PR reads as merged, which resolves to `shipped` and redirects the retry into a standalone
 * follow-up. So restoring it ahead of the status and label would publish a target that is live-ref
 * in-review, still open, and stage-less, with nothing left that ever completes the rollback.
 *
 * Ordering it last is what makes the two writes BEFORE it recoverable instead. Each leaves the
 * target in the shape the retire itself produces — no live ref, the PR still named on its retired
 * key ({@link beads.retirePrRef}) — which is a state the rest of the system already reads
 * correctly: an ordinary run parks on it rather than re-dispatching shipped work (execute-epic step
 * 0a reads the retired pointer), the next send-back redirects the fix onto its own target, and a
 * reader can still follow the bead to where its work went. A failure at `tag` alone leaves the
 * target closed — terminal, and out of every dispatch path — so the residue is a missing stage
 * label on a bead nothing will run.
 *
 * `setPrRef` writes `metadata.pr`, the channel {@link beads.getPrRef} reads first, so the bead reads
 * as in-review again even where the retire also emptied a legacy `gh-` external_ref — which the
 * one-time migration (anton-ftar) is moving onto `metadata.pr` regardless.
 */
async function restoreFinishedRun(
  repo: string,
  before: Bead,
  pr: string,
  stages: string[],
  state: PullRequestState,
): Promise<void> {
  if (before.status === "closed") {
    await beads.close(repo, before.id, `rework: retire rolled back — ${settledPhrase(pr, state)}`);
  }
  if (stages.length > 0) await beads.tag(repo, before.id, stages);
  await beads.setPrRef(repo, before.id, pr);
}

/**
 * Put the reworked TICKET back too, on a GROUPED target where it is a bead of its own.
 *
 * {@link restoreFinishedRun} covers the ticket only when it IS the target. Under a feature the
 * reopen moved a child — status and stage labels — that no rollback of the target reaches, and the
 * retry the caller instructs cannot repair it either: that pass reads the PR as merged and opens a
 * standalone follow-up, leaving the original reopened and stage-stripped under a target that will
 * never dispatch it. So the same two writes are mirrored here.
 *
 * The instruction NOTE stays. bd notes are append-only, and the founder's words are the one part of
 * this request worth keeping — so the rollback is recorded beneath them instead, or a reader would
 * find a closed ticket wearing a send-back that apparently did nothing.
 */
async function restoreReworkedTicket(
  repo: string,
  before: Bead,
  targetId: string,
  pr: string,
  state: PullRequestState,
): Promise<void> {
  if (before.status === "closed") {
    await beads.close(repo, before.id, `rework: sent back, then rolled back — ${settledPhrase(pr, state)}`);
  }
  const stages = RUN_STAGE_LABELS.filter((l) => before.labels?.includes(l));
  if (stages.length > 0) await beads.tag(repo, before.id, stages);
  await beads.note(
    repo,
    before.id,
    `anton: rework — the send-back that left the instructions above was rolled back: ${targetId}'s ` +
      `pull request ${settledPhrase(pr, state)}, so this ticket was put back exactly as its run ` +
      `left it. Send it back again: anton re-reads the PR and, if it merged, carries the fix as ` +
      `its own run target instead.`,
  );
}

/**
 * How the verify read the PR, in words — the one phrase every rollback record opens with. Unreadable
 * is kept distinct from a state change everywhere it is reported: one says the PR moved, the other
 * says anton stopped being able to see it, and they are fixed differently.
 */
function settledPhrase(pr: string, state: PullRequestState): string {
  return state === "unknown"
    ? `${pr}'s state could no longer be read as it was applying`
    : `${pr} reads as ${state} now`;
}

/**
 * Record the lost race on the target itself, rather than only raising it: the instructions have
 * already landed and everything this send-back did to the TARGET was applied and undone, so a reader
 * looking at a bead sent back to a merged PR needs to see why it still wears the finished-run
 * marker — and, on a standalone target, why its own status went back with it.
 */
async function noteRace(
  repo: string,
  targetId: string,
  pr: string,
  state: PullRequestState,
): Promise<void> {
  await beads.note(
    repo,
    targetId,
    `anton: rework — ${settledPhrase(pr, state)}, though it was open when this send-back was ` +
      `decided, so the writes it had already applied to this bead were rolled back and the ` +
      `finished-run marker was LEFT in place. Send the ticket back again: anton re-reads the PR ` +
      `and, if it merged, carries the fix as its own run target instead.`,
  );
}

/**
 * Reopen: the note, then the status. Ordered that way deliberately — a note on a bead that failed to
 * reopen is a recoverable half-step (the founder sees their instructions and can reopen by hand),
 * while a reopened bead with no instructions is a ticket re-dispatched against the SAME spec that
 * just failed review, which is how a converge loop grinds.
 */
async function applyReopen(
  project: Project,
  target: Bead,
  ticket: Bead,
  summary: string,
  instructions: string,
  findings: ReviewFinding[],
): Promise<AppliedRework> {
  const repo = project.repoPath;
  const author = await resolveAuthor();
  const body = reworkNoteBody({ mode: "reopen", targetId: target.id, summary, instructions, findings });

  // Re-read under the lock: the dedupe is decided on the note blob as it is at the instant we write,
  // so a request that lost the race to an identical one sees its work already done. "Already done"
  // is the note AND the state the rework produces — an open bead with the finished run's stage
  // labels gone. On text alone, sending the same instructions back a SECOND time (after a later run
  // re-closed the ticket) would skip the reopen and leave the bead closed while the founder is told
  // it went back.
  const fresh = await beads.show(repo, ticket.id);
  // A reopen always runs under the target: the ticket was checked to be one of its run members.
  if (hasHumanNote(fresh, body) && fresh.status !== "closed" && !hasStageLabel(fresh)) {
    return {
      result: { mode: "reopen", ticketId: ticket.id, reworkedId: ticket.id, note: body, applied: false },
      runsUnderTarget: true,
    };
  }

  const note = formatHumanNote(body, author, new Date());
  await beads.note(repo, ticket.id, note, author || undefined);
  // A ticket the run never closed (it parked before the close, or the founder is reworking mid-flight)
  // is already open — `bd reopen` has nothing to do there, and the reason lives in the note either way.
  if (fresh.status === "closed") {
    await beads.reopen(repo, ticket.id, `rework: ${summary}`);
  }
  // The stage labels describe the run that just finished with this bead — see RUN_STAGE_LABELS for
  // what each one costs the ticket it is left on.
  await beads.untag(repo, ticket.id, RUN_STAGE_LABELS);
  return {
    result: { mode: "reopen", ticketId: ticket.id, reworkedId: ticket.id, note: body, applied: true },
    runsUnderTarget: true,
  };
}

/**
 * Follow-up: a new, contract-shaped bead carrying the instructions, linked `discovered-from` the
 * original. The original is left exactly as it shipped — that is the whole point of choosing this
 * mode — and gains only a provenance note pointing at what came out of its review.
 *
 * Where the new bead is PARENTED decides whether it re-enters the pipeline at all. Under a board
 * card (a feature or a non-container epic) it becomes another ticket of that target's next run.
 * Under a standalone task/bug it would become a ticket of NO run — `boardCards` only cards epics and
 * features, so nothing would ever dispatch it — so there it is created parentless, which makes it a
 * run target in its own right, claimable and approvable like any other standalone item. That same
 * choice is what `runsUnderTarget` reports, because a parentless follow-up gives the target's own
 * run nothing to carry and so must not retire its open PR ({@link resolvePipeline}).
 *
 * A SHIPPED target (its PR merged, {@link resolvePipeline}) is parented nowhere for a second reason:
 * its next run has nothing left to execute, so a child of it would never be dispatched either. The
 * follow-up carries the work as a run target of its own — and one an EARLIER attempt already parented
 * under the target is moved there too, because a merge can land between the two attempts.
 */
async function applyFollowUp(
  project: Project,
  target: Bead,
  ticket: Bead,
  summary: string,
  instructions: string,
  findings: ReviewFinding[],
  pipeline?: ReworkPipeline,
): Promise<AppliedRework> {
  const repo = project.repoPath;
  const author = await resolveAuthor();
  const shippedPr = pipeline?.outcome === "shipped" ? pipeline.pr : undefined;
  const shipped = shippedPr !== undefined;
  const body = reworkNoteBody({
    mode: "follow-up",
    targetId: target.id,
    summary,
    instructions,
    findings,
    originId: ticket.id,
    redirected: pipeline?.redirected ?? false,
  });

  // Re-read the board UNDER the lock, like the reopen path re-reads the bead: the pre-lock snapshot
  // was taken before a rival request could have created the very follow-up this one would duplicate,
  // and the whole point of the lock is that the loser sees the winner's work.
  const all = await refreshAllIssues(repo);
  const match = await existingFollowUp(repo, all, ticket.id, summary, body);
  if (match) {
    const existing = match.bead;
    // A follow-up created UNDER the target before its PR merged is stranded there: the merged target
    // has no run left to dispatch it, and a child task is not a run target of its own, so nothing
    // would ever pick it up. That is exactly the shape the instructed retry lands in — the 409 says
    // "send it back again", and this pass reads the PR as merged. So the parentage is reconciled to
    // what this request would have created had it gone first (parentless, {@link resolvePipeline}),
    // rather than the founder being told a stranded child "carries the next pass as its own run
    // target". The bead keeps its Context section, which a founder may have edited; the note is the
    // record of the move.
    const stranded = shippedPr !== undefined && beads.parentOf(existing) === target.id;
    if (stranded) {
      await beads.reparent(repo, existing.id, "");
      await beads.note(
        repo,
        existing.id,
        `anton: rework — ${target.id}'s pull request (${shippedPr}) merged after this follow-up was ` +
          `created under it, so it was detached and is its own run target now — approve it to run. ` +
          `Its Context section still names the parent it was created under.`,
      );
    }
    // A bead an earlier attempt created and linked but never got a note onto ({@link
    // existingFollowUp}) is this request's own work, half done — so finish it rather than opening a
    // second follow-up beside it. Both remaining writes are made, in the order the create path makes
    // them: the attempt died on the first, so neither can already be on the board.
    if (match.partial) {
      await beads.note(
        repo,
        existing.id,
        formatHumanNote(body, author, new Date()),
        author || undefined,
      );
      await noteOrigin(repo, ticket.id, existing.id, author, pipeline);
    }
    return {
      result: {
        mode: "follow-up",
        ticketId: ticket.id,
        reworkedId: existing.id,
        note: body,
        // A resumed creation DID write: the founder's instructions were nowhere on the board a
        // moment ago, and reporting "already sent back" would hide that this pass is what landed
        // them.
        applied: match.partial,
      },
      // Read off the bead the winner actually created — as reconciled above — so the repeat that
      // finishes a half-applied send-back retires on exactly the condition that holds now.
      runsUnderTarget: !shipped && beads.parentOf(existing) === target.id,
      reconciled: stranded,
    };
  }

  const parentId = !shipped && isBoardCard(target, all) ? target.id : undefined;
  const followUpId = await beads.create(repo, {
    title: summary,
    type: "task",
    description: followUpDescription({
      summary,
      ticket,
      targetId: target.id,
      parentId,
      pipeline,
    }),
    labels: inheritedLabels(ticket),
    ...(parentId ? { deps: [`parent-child:${parentId}`] } : {}),
  });
  // Provenance, and the reason this bead exists at all: `bd link <new> <origin> --type
  // discovered-from`. Written before the note so a failure leaves an unlinked bead the founder can
  // see and link, rather than an instruction on a bead nothing points at.
  await beads.link(repo, followUpId, ticket.id, "discovered-from");
  await beads.note(repo, followUpId, formatHumanNote(body, author, new Date()), author || undefined);
  await noteOrigin(repo, ticket.id, followUpId, author, pipeline);
  return {
    result: { mode: "follow-up", ticketId: ticket.id, reworkedId: followUpId, note: body, applied: true },
    runsUnderTarget: parentId === target.id,
  };
}

/**
 * Point the ORIGINAL ticket at what its review produced. It keeps its score and its status; all it
 * gains is this pointer. A REDIRECTED send-back says something different on purpose — the founder
 * judged the acceptance unmet, and this bead is closed only because its work merged, so claiming it
 * stands would put words in their mouth.
 *
 * Written exactly once per follow-up: the create path writes it last, and the path that RESUMES a
 * half-created follow-up ({@link existingFollowUp}) reaches it only where the attempt it is
 * finishing died before this write.
 */
async function noteOrigin(
  repo: string,
  ticketId: string,
  followUpId: string,
  author: string,
  pipeline?: ReworkPipeline,
): Promise<void> {
  const body = pipeline?.redirected
    ? `Follow-up ${followUpId} was opened from this ticket's review — the founder judged its ` +
      `acceptance unmet, but ${pipeline.pr} had already merged, so the fix runs there as its ` +
      `own target rather than reopening work that has shipped.`
    : `Follow-up ${followUpId} was opened from this ticket's review — its acceptance stands; the ` +
      `next iteration is tracked there.`;
  await beads.note(repo, ticketId, formatHumanNote(body, author, new Date()), author || undefined);
}

/**
 * The follow-up this request must not duplicate, and whether it still needs finishing.
 *
 * Two shapes qualify, and they are found in that order:
 *
 *   • DONE — an unsettled bead linked `discovered-from` the ticket, with the same title AND carrying
 *     this request's exact instruction note. All three, because each is wrong alone. The edge alone
 *     makes every LATER rework of the same ticket a no-op — a founder is entitled to send the same
 *     ticket back twice for two different reasons. Title and edge still match a bead carrying
 *     DIFFERENT instructions: two send-backs summarised the same way, or an ordinary follow-up and a
 *     reopen that a merged PR redirected here, which say opposite things about whether the
 *     original's acceptance stood ({@link reworkNoteBody}). Reusing one for the other reports a note
 *     that is nowhere on the bead and hands the next implementer the earlier request's instructions.
 *   • PARTIAL — the same title and edge on a bead carrying NO human note at all. `bd create` and
 *     `bd link` landed and the `bd note` after them did not, so an attempt died mid-sequence; the
 *     bead speaks for no request yet. Matching on the note ALONE would reject it and create a second
 *     follow-up beside it, and duplicate discovered-from work can be approved twice. Carrying no
 *     human note is what distinguishes it from another request's bead, which carries its own.
 *
 * The note blob decides either way, exactly as the reopen path's dedupe does — which needs a full
 * `bd show` per candidate, since `bd list` does not carry notes reliably. An exact match anywhere in
 * the candidates wins over a partial one, so a founder's second send-back is never mistaken for the
 * unfinished remains of their first.
 */
interface FollowUpMatch {
  bead: Bead;
  /** The creation sequence stopped before its note — this request finishes it ({@link applyFollowUp}). */
  partial: boolean;
}

async function existingFollowUp(
  repo: string,
  all: Bead[],
  ticketId: string,
  summary: string,
  body: string,
): Promise<FollowUpMatch | undefined> {
  const title = summary.trim().toLowerCase();
  const candidates = all.filter(
    (b) =>
      b.status !== "closed" &&
      (b.title ?? "").trim().toLowerCase() === title &&
      (b.dependencies ?? []).some(
        (d) => d?.type === "discovered-from" && d.issue_id === b.id && d.depends_on_id === ticketId,
      ),
  );
  let partial: Bead | undefined;
  for (const candidate of candidates) {
    const fresh = await beads.show(repo, candidate.id);
    if (hasHumanNote(fresh, body)) return { bead: candidate, partial: false };
    if (!partial && !hasAnyHumanNote(fresh)) partial = candidate;
  }
  return partial ? { bead: partial, partial: true } : undefined;
}

/** The routing/shaping labels a follow-up carries over — see {@link INHERITED_LABEL_PREFIXES}. */
function inheritedLabels(ticket: Bead): string[] {
  return (ticket.labels ?? []).filter((l) => INHERITED_LABEL_PREFIXES.some((p) => l.startsWith(p)));
}

/** Stage labels a reopen strips — one still on the bead means this rework's untag hasn't run yet. */
function hasStageLabel(bead: Bead): boolean {
  return (bead.labels ?? []).some((l) => RUN_STAGE_LABELS.includes(l));
}

/** Is this exact instruction already on the bead as a human note? Half of the double-submit guard. */
function hasHumanNote(bead: Bead, body: string): boolean {
  const wanted = normalize(body);
  return parseTicketNotes(bead.notes).some(
    (n) => n.source === "human" && normalize(n.text) === wanted,
  );
}

/**
 * Does the bead carry ANY human note? A follow-up with none speaks for no request — every path that
 * creates one writes the instructions as a human note — which is what marks it as an unfinished
 * creation rather than another send-back's work ({@link existingFollowUp}).
 */
function hasAnyHumanNote(bead: Bead): boolean {
  return parseTicketNotes(bead.notes).some((n) => n.source === "human");
}

/** Whitespace-insensitive comparison, so a note round-tripped through the blob still matches itself. */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * The instruction note both modes write. One rendering, so a founder reading the bead later sees the
 * same thing the implementer was handed: what was decided, what to do, and the reviewer's own words
 * for the problems it is meant to fix.
 */
export function reworkNoteBody(args: {
  mode: ReworkMode;
  targetId: string;
  summary: string;
  instructions: string;
  findings: ReviewFinding[];
  /** For a follow-up: the ticket this bead was discovered from. */
  originId?: string;
  /** A reopen the merged target redirected into a follow-up ({@link ReworkPipeline}). */
  redirected?: boolean;
}): string {
  const head = args.redirected
    ? `Rework — acceptance not met on ${args.originId}, but ${args.targetId} has already merged, so ` +
      `the fix runs here rather than reopening shipped work: ${args.summary}`
    : args.mode === "reopen"
      ? `Rework — acceptance not met. Sent back from ${args.targetId}'s self-review: ${args.summary}`
      : `Follow-up on ${args.originId} — its acceptance stands; ${args.targetId}'s self-review ` +
        `prompted another pass: ${args.summary}`;
  return [
    head,
    ``,
    args.instructions,
    ...(args.findings.length > 0
      ? [
          ``,
          `Findings to fix (from the self-review):`,
          ...args.findings.map((f) => `- [${f.severity}] ${f.location} — ${f.note}`),
        ]
      : []),
  ].join("\n");
}

/**
 * The follow-up bead's contract. Every section the bead contract judges is written, because an
 * unshaped bead is refused by the approve route and poison-parks the runner — a rework that produced
 * one would hand the founder a follow-up they cannot run.
 *
 * The instructions themselves are NOT repeated here: they are the human note on the same bead, which
 * the dispatch prompt inlines, and duplicating them would leave two copies to drift apart the first
 * time the founder edits one.
 */
function followUpDescription(args: {
  summary: string;
  ticket: Bead;
  targetId: string;
  parentId?: string;
  pipeline?: ReworkPipeline;
}): string {
  const { summary, ticket, targetId, parentId, pipeline } = args;
  const provenance = pipeline?.redirected
    ? `Discovered from ${ticket.id} — ${ticket.title}. The founder judged its acceptance unmet, but ` +
      `${targetId}'s pull request (${pipeline.pr}) had already merged, so this bead carries the fix ` +
      `instead of reopening work that has shipped. The founder's instructions and the findings they ` +
      `selected are the human note on this bead.`
    : `Discovered from ${ticket.id} — ${ticket.title}. That ticket's acceptance was met and it keeps ` +
      `its review score; this bead carries the next iteration ${targetId}'s self-review prompted. ` +
      `The founder's instructions and the findings they selected are the human note on this bead.`;
  return [
    `## Goal`,
    summary,
    ``,
    `## ${ACCEPTANCE_HEADING}`,
    `- [ ] ${summary}`,
    `- [ ] The findings listed in this bead's note are addressed, or answered with why they don't apply`,
    ``,
    `## Context`,
    provenance,
    parentId
      ? `It runs as a ticket of ${parentId}, in that target's next run.`
      : `It is its own run target — approve it to run.`,
    ``,
    `## Out of scope`,
    `Anything beyond the instructions in the note. ${ticket.id} already shipped its own acceptance; ` +
      `re-litigating it belongs on that ticket, not here.`,
    ``,
    `## Verify`,
    `The project's own checks stay green, and the run's self-review scores this bead against the ` +
      `acceptance above.`,
  ].join("\n");
}

/**
 * Who the note is attributed to. An unresolvable identity is not a reason to refuse — like a plain
 * note, a rework takes nothing from anyone — so `formatHumanNote`'s generic author stands in.
 */
async function resolveAuthor(): Promise<string> {
  return (await resolveOperator()) ?? "";
}
