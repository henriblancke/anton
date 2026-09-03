/**
 * The RUN phase of the walk (anton-lnkt — extracted from execute-epic.ts in anton-1lix): every
 * formula step after the commit, in the order the project's formula puts them, dispatched through
 * the same registry the ticket phase uses.
 *
 * These steps speak for the run as a whole — they read its whole diff and open its single PR — so
 * each runs ONCE, and one at a time: they share a worktree and a PR, so a formula whose steps could
 * overlap is still not a licence to fan out.
 */
import { beads, LABELS } from "../beads/bd";
import { updateRun } from "../runs";
import { releaseRunResources } from "./worktree-reaper";
import type { SkipCause } from "./execute-epic-board";
import type { DispatchOutcome } from "./execute-epic-dispatch";
import { armMergeGate } from "./execute-epic-merge-gate";
import { runReviewStep } from "./execute-epic-review-step";
import type { RunPhaseCarry, RunStepDispatch } from "./execute-epic-run-step";
import { safe } from "./execute-epic-persist";
import type { RunPreparation } from "./execute-epic-prepare";
import { stalePrBodyNote, stalePrBodyRunError } from "./execute-epic-review";
import type { EpicRun } from "./execute-epic-run";


/** Walk the formula's post-commit steps, then finalize the run and release its checkout. */
export async function walkRunPhase(
  run: EpicRun,
  prep: Extract<RunPreparation, { done: false }>,
  dispatched: DispatchOutcome,
): Promise<void> {
  const carry: RunPhaseCarry = { advisories: [], staleBodyFallback: null };
  for (const { step: cooked, definition } of prep.runSteps) {
    // A step boundary is a lease checkpoint: never dispatch run-level work — and never open a
    // PR — under a lease this run can no longer prove it holds.
    run.lease.assertHeld();
    const dispatch: RunStepDispatch = {
      cooked,
      definition,
      stepCtx: {
        ...prep.runStep,
        tickets: dispatched.delivered,
        step: cooked,
        advisories: carry.advisories,
      },
    };
    if (definition.name === "review") {
      await runReviewStep(run, prep, dispatch, carry);
      continue;
    }
    if (definition.name === "pr") {
      await runPrStep(run, dispatch, carry);
      continue;
    }
    await runOtherStep(run, dispatch);
  }
  await finishRun(run, prep, dispatched.skipped, carry);
}

/** Open the run's ONE pull request, stamp the ref, and move the target into review. */
async function runPrStep(
  run: EpicRun,
  dispatch: RunStepDispatch,
  carry: RunPhaseCarry,
): Promise<void> {
  const { repo, targetId: epicBeadId, all, standaloneRun } = run;
  const { cooked, definition, stepCtx } = dispatch;
  const advisoryFindings = carry.advisories;
  // Open the run's ONE PR, stamp the ref, and (for an epic) move it to in-review. A
  // standalone target is NOT closed here: like an epic it stays OPEN, tagged stage:in-review
  // (the ticket phase already applied that on commit), carrying its PR ref until the PR
  // actually MERGES — at which point review-fix's merge-finalize path closes it. Closing it
  // now would derive it as Done on the board while its PR is still open and drop it out of
  // review-fix's in-review sweep.
  const pr = (await definition.handler(stepCtx)).facts?.pr;
  if (!pr) {
    throw new Error(
      `formula step "${cooked.id}" (step:pr) reported no pull request — the run has no way to ` +
        `reach a human, so it is not done`,
    );
  }
  if (pr.bodyStale) {
    const note = stalePrBodyNote(pr, advisoryFindings);
    // If that write ALSO fails (a locked or unavailable beads DB) the findings have no home
    // left, and the run would still finish `done` — the advisory detail silently dropped
    // between this review and the merge gate. Carry the whole note out on the run row
    // instead, the same durable fallback the park path uses (see reviewParkMessage).
    if (!(await safe(() => beads.note(repo, epicBeadId, note)))) {
      carry.staleBodyFallback = stalePrBodyRunError(epicBeadId, note);
    }
  }
  await safe(() => beads.setPrRef(repo, epicBeadId, pr.ref));
  // The merge wait becomes board state, not a polling job (anton-k0kj): past this step the
  // only thing left to learn is whether this PR merges, which `bd gate check` answers for the
  // whole project in one call per slot. Best-effort like the writes around it — the
  // review-fix sweep still finalizes a merge it happens to see, so a failed arm costs
  // latency, not correctness.
  await safe(() => armMergeGate(repo, epicBeadId, pr.ref, all));
  if (!standaloneRun) {
    await safe(() => beads.tag(repo, epicBeadId, [LABELS.stage("in-review")]));
    await safe(() => beads.untag(repo, epicBeadId, [LABELS.stage("implementing")]));
  }
}

/** Any other step the project put after its commit — a `step:verify` it moved there. */
async function runOtherStep(run: EpicRun, dispatch: RunStepDispatch): Promise<void> {
  const { targetId: epicBeadId } = run;
  const { cooked, definition, stepCtx } = dispatch;
  // Anything else the project put after its commit — a `step:verify` it moved there. Never a
  // step that DISPATCHES an agent: the floor (anton-6b99, `diff-after-commit`) refuses every
  // `producesDiff` step here, which is both `implement` and `claude`, and it is asserted on
  // every attempt before the walk begins. So nothing reaching this line carries a
  // `facts.selfReport`, and an agent's ask or block is judged where the agents actually run —
  // the ticket phase (see the `needs-human` throw in runTicket). A step that RAN and did not
  // achieve its work stops the run: the registry leaves that judgement to the caller, and
  // carrying on would report a delivery on a pipeline that didn't finish.
  const result = await definition.handler(stepCtx);
  if (!result.ok) {
    throw new Error(
      result.detail ??
        `formula step "${cooked.id}" (step:${definition.name}) failed for ${epicBeadId}`,
    );
  }
}

/** Step 5. Say what the run did NOT deliver, settle the row, and hand the checkout back. */
async function finishRun(
  run: EpicRun,
  prep: Extract<RunPreparation, { done: false }>,
  skipped: Map<string, SkipCause>,
  carry: RunPhaseCarry,
): Promise<void> {
  const { db, clock, ctx, projectId, repo, runId, targetId: epicBeadId, timedOut } = run;
  const { worktree } = prep;
  const staleBodyFallback = carry.staleBodyFallback;
  // A feature that delivered most of itself still owes the founder the part it didn't
  // (anton-t1mo). The timed-out tickets are blocked on the board with their own notes, but the
  // TARGET is what the founder opens at the merge gate — so it says, in one place, that this PR
  // is the feature minus these tickets. Best-effort like the other target writes; the run row
  // below carries the same sentence when the bead write fails.
  const timeoutNotice = timedOut.length
    ? `${timedOut.length} ticket(s) ran out of time and did not finish — ` +
      `${timedOut.map((t) => t.id).join(", ")}. Each is blocked with its own note saying ` +
      `whether its work is in this PR; re-scope them or raise ticketTimeoutMinutes, then run them.`
    : null;
  if (timeoutNotice) await safe(() => beads.note(repo, epicBeadId, `anton: ${timeoutNotice}`));

  // The tickets the timeout took down with it (anton-67xj) — the founder reads the TARGET at the
  // merge gate, so the PR's missing half is named there too, not only on each skipped bead.
  const skippedNotice = skipped.size
    ? `${skipped.size} ticket(s) were never dispatched because the work they depend on was ` +
      `rolled back — ` +
      `${[...skipped].map(([id, c]) => `${id} (waiting on ${c.waitingOn})`).join(", ")}. ` +
      `Each is open, unassigned and noted; run them once the tickets they wait on land.`
    : null;
  if (skippedNotice) await safe(() => beads.note(repo, epicBeadId, `anton: ${skippedNotice}`));

  // 5. Finalize run + clean up the worktree (the branch/PR carry the work now). The run IS done —
  //    the branch and its PR carry the work — so a stale-body salvage rides along as the row's
  //    error rather than failing a delivery that landed.
  await updateRun(db, clock, runId, {
    status: "done",
    endedAt: clock.now(),
    error: [timeoutNotice, skippedNotice, staleBodyFallback].filter(Boolean).join(" — ") || null,
  });
  // The branch and its PR carry the work now, so the checkout is residue; the branch survives
  // because the target is still open in review (anton-hrun.1). The claim comes off first: the
  // release below force-removes the checkout, which a live claim refuses — ours as much as
  // anyone's, since the lock says nothing about which run inside this process took it.
  await run.releaseWorktreeHold();
  await safe(() =>
    releaseRunResources({
      db,
      clock,
      ctx,
      projectId,
      runId,
      repoPath: repo,
      worktree,
      beadId: epicBeadId,
      status: "done",
    }),
  );
}
