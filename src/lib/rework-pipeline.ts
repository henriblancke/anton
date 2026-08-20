/**
 * What the TARGET'S OWN PULL REQUEST allows a send-back to do (anton-leit), and the writes that act
 * on the answer: the mode the PR decides, the finished-run marker a still-open PR lets anton retire,
 * the verify that stands behind that retire, and the rollback for when it can't.
 *
 * One module because these all turn on a single unstable fact — the state `gh` reports for one PR —
 * which is read three times on purpose (decide, re-check under the lock, verify after the writes) and
 * is the only thing here no lock of ours can order against GitHub.
 */
import { beads, LABELS, type Bead } from "./beads/bd";
import { pullRequestState, type PullRequestState } from "./git/ops";
import { ReworkConflictError, ReworkUnavailableError } from "./rework-contract";
import { settledPhrase } from "./rework-notes";
import { isBoardCard } from "./ticket-view";
import type { Project, ReworkMode, ReworkPipeline } from "./types";

/**
 * The stage labels a finished run leaves behind, which every send-back strips: `stage:in-review`
 * makes the bead resume-SKIPPED (ticket-view's `resumeSkipped`) and `stage:implementing` makes it
 * derive as in-progress on every board surface. One list, because {@link retireFinishedRun} has to
 * put back exactly what it took off.
 */
export const RUN_STAGE_LABELS: string[] = [LABELS.stage("implementing"), LABELS.stage("in-review")];

/** The stage labels this bead is currently wearing — exactly what a rollback has to put back. */
export function stageLabelsOn(bead: Bead): string[] {
  return RUN_STAGE_LABELS.filter((l) => bead.labels?.includes(l));
}

/**
 * How this send-back will be applied, once the target's PR has had its say.
 */
export interface ReworkPlan {
  /** What that PR allows, if it has anything to say at all ({@link resolvePipeline}). */
  pipeline?: ReworkPipeline;
  /** The founder's mode, as the PR may have redirected it. */
  mode: ReworkMode;
  /**
   * Does a lost race have a CHILD's reopen to undo as well as the target's retire? Only a reopen
   * writes to a bead this request may have to put back, and only on a grouped target is that bead
   * distinct from the one the retire's own rollback restores.
   */
  rollsBackTicket: boolean;
}

/**
 * Decide the send-back against the target's pull request, before ANY write.
 *
 * The PR is consulted only where its answer can change something. A follow-up on a target that is NOT
 * a board card comes out parentless either way ({@link applyFollowUp}, lib/rework-modes.ts) — its own
 * run target, which this target's PR neither carries nor gates — so asking `gh` there would let an
 * unreachable GitHub (503, {@link ReworkUnavailableError}) block a send-back that never needed it.
 */
export async function planRework(
  repo: string,
  target: Bead,
  ticket: Bead,
  all: Bead[],
  requested: ReworkMode,
): Promise<ReworkPlan> {
  const needsPipeline = requested === "reopen" || isBoardCard(target, all);
  const pipeline = needsPipeline ? await resolvePipeline(repo, target, requested) : undefined;
  const mode = pipeline?.redirected ? "follow-up" : requested;
  return { pipeline, mode, rollsBackTicket: mode === "reopen" && ticket.id !== target.id };
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
 *     `runsUnderTarget` ({@link AppliedRework}, lib/rework-modes.ts). A follow-up on a standalone
 *     target comes out PARENTLESS and is its own run target, so this target's run would not carry
 *     the fix and its open PR stays exactly as it is.
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
export async function resolvePipeline(
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

/** The target and (where a rollback would reach it) the ticket, exactly as this request found them. */
export interface PreWriteSnapshot {
  target: Bead;
  /**
   * The reopened CHILD's own pre-write state, on a grouped target where the mode moves a bead the
   * target's rollback never touches. Read off the same pre-write board, so the two describe one
   * instant.
   */
  ticket?: Bead;
}

/**
 * The beads as they stand before ANY write of this request, plus the guard the mode's writes are
 * predicated on ({@link assertPrStillOpen}) — taken together so the guard always precedes them.
 *
 * The snapshot is taken HERE rather than inside {@link retireFinishedRun} because on a standalone
 * target the ticket IS the target: the mode's writes reopen it and strip its stage labels, so a
 * snapshot taken after them would roll the retire back onto that already-reopened state and leave a
 * merged original open, untagged and outside its own merge finalization.
 */
export async function snapshotBeforeWrites(
  repo: string,
  target: Bead,
  ticket: Bead,
  rollsBackTicket: boolean,
): Promise<PreWriteSnapshot> {
  const targetBefore = await beads.show(repo, target.id);
  const ticketBefore = rollsBackTicket ? await beads.show(repo, ticket.id) : undefined;
  await assertPrStillOpen(repo, targetBefore);
  return { target: targetBefore, ticket: ticketBefore };
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
 * rollback covers that window on a standalone target because it restores the pre-write snapshot
 * taken alongside this read ({@link restoreFinishedRun}).
 */
async function assertPrStillOpen(repo: string, target: Bead): Promise<void> {
  // The ref as it is NOW — the under-the-lock read, not the pre-lock snapshot: a rival request that
  // already retired this cycle leaves nothing to invalidate, and the retire below will report it as
  // `already-retired`.
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
export type RetireResult =
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
 * ({@link rollBackRetire}). Either way the caller turns it into an error the founder can act on
 * ({@link assertRetireStood}). The read that survives is the last one, so what remains open is a
 * merge landing after it — no write of ours follows, and no client-side check can order that against
 * GitHub.
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
export async function retireFinishedRun(
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

  const stages = stageLabelsOn(before);
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
  if (settled !== "open") return rollBackRetire(repo, before, reopened, pr, stages, settled);

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
 * Undo a retire the verify could no longer stand behind: the target's three writes, the reopen the
 * MODE landed on a ticket of this target (which no later write of this request would otherwise put
 * back), and the record of why — in that order, so the marker a reader judges the bead by goes last.
 */
async function rollBackRetire(
  repo: string,
  before: Bead,
  reopened: Bead | undefined,
  pr: string,
  stages: string[],
  settled: PullRequestState,
): Promise<RetireResult> {
  await restoreFinishedRun(repo, before, pr, stages, settled);
  if (reopened) await restoreReworkedTicket(repo, reopened, before.id, pr, settled);
  await noteRace(repo, before.id, pr, settled);
  return settled === "unknown"
    ? { outcome: "unverifiable", pr }
    : { outcome: "raced", pr, state: settled };
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
    await beads.close(
      repo,
      before.id,
      `rework: sent back, then rolled back — ${settledPhrase(pr, state)}`,
    );
  }
  const stages = stageLabelsOn(before);
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
 * Did the retire touch the board? A rolled-back retire counts: it wrote its own record of why, and a
 * write another machine never sees is the thing the sync nudge exists to prevent.
 */
export function retireWrote(retire: RetireResult): boolean {
  return (
    retire.outcome === "retired" || retire.outcome === "raced" || retire.outcome === "unverifiable"
  );
}

/**
 * Fail loud on a retire that could not be stood behind — after the sync nudge, because a rolled-back
 * retire is still a write another machine has to see.
 *
 * Both failures end on the same clause: what the rollback undid, in the words the founder needs. On a
 * grouped reopen the child went back with the target, so it is named too.
 */
export function assertRetireStood(
  retire: RetireResult,
  applied: { targetId: string; ticketId: string; reworkedId: string; rollsBackTicket: boolean },
): void {
  const { targetId, ticketId, reworkedId, rollsBackTicket } = applied;
  const undone = rollsBackTicket
    ? `everything it had applied to ${targetId} and ${ticketId} was rolled back`
    : `everything it had applied to ${targetId} was rolled back`;
  // `gh` went unreadable across the writes (see {@link retireFinishedRun}). NOT a 409: nothing here
  // says the PR moved, so telling the founder to send it back again would be advice about a race
  // that may never have happened. The remedy is the one {@link assertPrStillOpen} gives for the same
  // answer — fix `gh` — and it is a 503 for the same reason.
  if (retire.outcome === "unverifiable") {
    throw new ReworkUnavailableError(
      `anton could no longer read the state of ${targetId}'s pull request (${retire.pr}) once this ` +
        `send-back's writes had landed, so it could not stand behind them: ${undone}, and the ` +
        `finished-run marker was left in place rather than retired off a PR anton can no longer ` +
        `prove is live. The instructions stay on ${reworkedId} as a record; check that ` +
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
      `${targetId}'s pull request (${retire.pr}) stopped being open (${retire.state}) while this ` +
        `send-back was applying, so ${undone} and its finished-run marker is still in place rather ` +
        `than retired off a PR anton can no longer prove is live. The instructions stay on ` +
        `${reworkedId} as a record; send the ticket back again and anton will re-read the ` +
        `PR — if it merged, the fix runs as its own target instead.`,
    );
  }
}
