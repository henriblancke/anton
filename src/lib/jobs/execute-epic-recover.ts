/**
 * Where a resumed run picks up (anton-jz1 — extracted from execute-epic.ts in anton-1lix).
 *
 * Two questions, asked in this order and before anything is held: what does the SHARED board say
 * now, and is there anything left for this attempt to do at all? A job that parked on another
 * machine's lease, or crashed after stamping its PR ref, re-enters the handler here — and getting
 * either answer wrong opens a duplicate pull request or re-dispatches shipped work.
 */
import { beads, LABELS, type Bead } from "../beads/bd";
import { loadAllIssues } from "../beads/issues";
import { runTickets } from "../ticket-view";
import { pullRequestState } from "../git/ops";
import { findWorktree, worktreePathFor, type Worktree } from "../git/worktree";
import { updateRun } from "../runs";
import { releaseRunResources } from "./worktree-reaper";
import { PoisonEpic } from "./errors";
import { armMergeGate } from "./execute-epic-merge-gate";
import { safe } from "./execute-epic-persist";
import type { EpicRun } from "./execute-epic-run";

/**
 * Step 0. Pull the shared board and adopt what it brings back — the target for the liveness gates,
 * and the ticket list the loop iterates. Answers whether that read can be TRUSTED, which is what
 * decides how the post-publish lease race may be arbitrated.
 */
export async function refreshRunBoard(
  run: EpicRun,
): Promise<{ preCheckTrusted: boolean; leaseTarget: Bead }> {
  const { repo, targetId: epicBeadId } = run;
  // 0. Cross-machine double-run guard (anton-jz1). A queued job that reschedules (quota/backoff)
  //    re-enters this handler WITHOUT the enqueue-time liveRunCheck. If a Force run started on
  //    ANOTHER machine while this job was parked/backing off, the target now carries that
  //    machine's unexpired run-lease. Pull the shared board and re-read the target FRESH before
  //    deciding: the `all` snapshot up top was taken before any of this setup, so a lease another
  //    machine published since (the sync heartbeat is periodic) would be invisible to a check
  //    against that stale bead and this gate would miss the concurrent run. Publishing our own
  //    lease (below) sweeps `leaseLabels`, so overwriting a foreign one would let BOTH machines
  //    run the epic at once — the exact double-run this lease exists to prevent. Treat a foreign
  //    live lease as a park/retry: RunAlreadyLiveError reschedules this job (refunding the
  //    attempt) to re-check once that run settles and clears its lease. This run's OWN lease
  //    (same runId, e.g. stranded by a crashed prior attempt) is not foreign and is adopted just
  //    below as a sweep leftover. Checked before any claim/worktree/session work so a run never
  //    half-executes into a concurrent one. Best-effort pull: a failure degrades to the last
  //    local snapshot rather than blocking a legitimate run.
  //    Track whether this pre-check ran against a TRUSTED (fresh) board read. A stale snapshot —
  //    the pull failed, or the show fell back to the top-of-handler `all` — can hide an
  //    already-live incumbent lease published by a run that started earlier. That incumbent only
  //    arbitrates the lease at ITS OWN startup and keeps running regardless of what we decide, so
  //    the post-publish race arbitration (step 1b) must NOT steal the lease from it by owner order
  //    when our pre-check couldn't rule it out (anton-jz1).
  let preCheckTrusted = true;
  try {
    await beads.pull(repo);
  } catch {
    preCheckTrusted = false; // stale local snapshot — an incumbent lease may be invisible below
  }
  let leaseTarget = run.target;
  try {
    leaseTarget = await beads.show(repo, epicBeadId);
  } catch {
    preCheckTrusted = false; // fell back to the stale top-of-handler snapshot
  }

  // Re-derive the ticket list from the freshly-pulled board (anton-jz1). `all`/`target`/`tickets`
  // up top were read BEFORE the pull above, so on a cross-machine retry a child ticket another
  // machine closed — then crashed before stamping the PR ref — still shows OPEN in that stale
  // snapshot. The ticket loop (step 4) skips only tickets whose status is `closed`, so iterating
  // the stale list would re-run claude and re-commit work the just-pulled board already reflects as
  // done. Re-list here so those remotely-closed tickets are skipped. Best-effort like the pull: a
  // failed re-list keeps the pre-pull snapshot (no worse than before this refresh existed). The
  // target's SHAPE is re-derived from the adopted board too, but in 0a-ter below — after the
  // completion short-circuit, alongside the other gates that must not fire on a finished run.
  try {
    // Strict for the same reason as the read up top — and here the catch already does the right
    // thing with a rejection: keep the gate-complete pre-pull snapshot rather than adopting a
    // fresh board whose gates are missing.
    const fresh = await loadAllIssues(repo, { strictGates: true });
    const freshTarget = fresh.find((b) => b.id === epicBeadId);
    if (freshTarget) {
      run.all = fresh;
      run.target = freshTarget;
      run.tickets = run.standaloneRun ? [freshTarget] : runTickets(fresh, epicBeadId);
      // Adopt the fresh bead for the liveness gates too (anton-jz1). When the `show` above failed
      // but this list succeeds, `leaseTarget` still points at the stale pre-pull snapshot — yet the
      // completion short-circuit (step 0a, reads the PR ref via getPrRef) and the foreign-lease gate below
      // read `leaseTarget`. Leaving it stale would let a run whose completion/lease is visible in
      // this fresh list fall through into worktree/PR handling instead of finishing idempotently.
      leaseTarget = freshTarget;
    }
  } catch {
    // keep the pre-pull snapshot
  }
  return { preCheckTrusted, leaseTarget };
}

/**
 * Step 0a. Whether this target has already been carried to a live pull request — by this run's own
 * crashed attempt, or by the run that held the lease this one parked on. Answers `true` once the
 * attempt is settled `done`; the caller returns without executing anything.
 */
export async function settleCompletedRun(run: EpicRun, leaseTarget: Bead): Promise<boolean> {
  const { db, clock, ctx, projectId, repo, runId, branch, targetId: epicBeadId, lease } = run;
  const { all, standaloneRun } = run;
  // 0a. Revalidate the target still needs execution (anton-jz1). A job that parked on a foreign
  //     live lease (foreignRunLeaseLive below) or lost the publish race (step 1b) reschedules and
  //     re-enters this handler once that lease clears — but the run that HELD the lease may have
  //     already carried this epic all the way to in-review: opened the PR, stamped the external
  //     ref, and cleared its lease on settle. Without this gate the loser would proceed, skip the
  //     already-closed tickets, and re-enter the PR step — creating a duplicate/empty PR or parking
  //     on a `gh "a pull request already exists"` failure. The PR ref is set ONLY by a
  //     completed `pr` step (setPrRef), but its mere PRESENCE is NOT proof another run
  //     finished: review-fix deliberately LEAVES the ref on a bead whose PR was CLOSED without
  //     merging so a Run/Force run can recover it. So a ref only marks completion when its PR is
  //     still live — open (review in flight) or merged; a closed-unmerged ref is stale and must
  //     fall through to the recovery path below (checked via `pullRequestState`). Nothing is left
  //     for execute-epic to do only in the live/merged case, so there we finish this attempt as
  //     done (idempotent) and settle this machine's run row rather than redoing covered work.
  //     Checked BEFORE the foreign-lease gate so a still-lingering lease from the finishing run
  //     can't re-park an epic that's already complete, and BEFORE adopting/publishing any lease so
  //     the cleanup clears nothing we don't own. A stale board read (pull/show failed) simply won't
  //     show the ref yet and falls through to the lease gate below.
  // Read the PR pointer through the seam (anton-76ej): `metadata.pr`, or a legacy `gh-*`
  // external_ref as a fallback. A tracker URL parked in external_ref (e.g. Linear) is NOT a PR
  // pointer, so getPrRef ignores it — enabling a tracker integration can never trip this guard.
  const prRef = beads.getPrRef(leaseTarget);
  if (prRef) {
    // Distinguish a stale (closed-without-merging) ref from one that proves completion (anton-jz1).
    // Only an OPEN or MERGED PR means another run carried this epic to the finish; a CLOSED-unmerged
    // ref is what review-fix leaves for recovery, so DON'T short-circuit on it — fall through and let
    // this run re-open the PR. An UNKNOWN state (no `gh`, a network/CLI error, an unparseable ref) is
    // proof of NOTHING and must not be mistaken for either: treating it as done would strand a
    // genuinely-closed epic that a retry could recover, while falling through with a genuinely-merged
    // ref would run `gh pr create` on a branch with no diff and fail the run. So retry on unknown with
    // a COUNTING error (a plain throw, NOT RunAlreadyLiveError): a transient gh/network hiccup
    // self-heals within the retry budget, but a permanently-unreadable ref (gh missing, broken auth,
    // malformed ref) exhausts `maxAttempts` and PARKS for a human instead of retrying forever.
    // RunAlreadyLiveError is reserved for real lease/liveness conflicts, which the runner refunds and
    // retries indefinitely because a foreign run may legitimately hold the lease for a long time — an
    // unreadable ref is a local failure to resolve, not that, so it must count against the budget.
    const prState = await pullRequestState(repo, prRef);
    if (prState === "unknown") {
      throw new Error(
        `${epicBeadId} carries a PR ref but its state can't be read (gh unavailable or the ref is ` +
          `unparseable) — retrying rather than treating an unreadable PR as a completed run; a ` +
          `transient gh outage self-heals within the retry budget, a permanently-unreadable ref ` +
          `parks for a human`,
      );
    }
    if (prState === "open" || prState === "merged") {
      // Sweep this run's OWN leftover lease before the idempotent short-circuit (anton-jz1). If this
      // attempt resumes after a crash that landed the PR ref (the `pr` step's setPrRef) but died
      // before the cleanup cleared its run-lease, `leaseTarget` still carries an unexpired
      // `run-lease:…:<runId>` this run published. The general lease adoption (`lease.adopt`)
      // runs AFTER this return, so without adopting here `finally` would clear
      // nothing and other machines would keep seeing the epic as live until the TTL even though its
      // PR is already open. Adopt only OUR OWN lease (matched by runId) so the cleanup clears it; a
      // foreign machine's lease is left for its own owner/TTL, honoring "the cleanup clears only what we
      // own" (the same reason this gate precedes the general adoption below).
      lease.adoptOwn(leaseTarget);
      // Restore the in-review board state before returning (anton-jz1). An epic run that crashed
      // AFTER setPrRef but before the stage updates at the tail of the `pr` step leaves the
      // epic on stage:implementing with no stage:in-review. review-fix sweeps only stage:in-review
      // targets (see review-fix.ts), so without re-applying it here the run is marked done yet its
      // PR never enters the automated review/finalization path. Idempotent — a run that already
      // tagged in-review re-tags harmlessly. Standalone targets get in-review from runTicket on
      // commit (before the ref is ever set), so only the epic path needs this here.
      if (!standaloneRun) {
        await safe(() => beads.tag(repo, epicBeadId, [LABELS.stage("in-review")]));
        await safe(() => beads.untag(repo, epicBeadId, [LABELS.stage("implementing")]));
      }
      // Reconcile the merge gate here too, for the same reason the stage label is restored
      // (anton-k0kj): arming it is the LAST thing the `pr` step does, so a crash after setPrRef — or a
      // `gateCreate` the best-effort `safe` there swallowed — leaves this target gate-less, and
      // every later attempt takes THIS return instead of the `pr` step. Without this the wait never
      // becomes board state: the merge is only ever noticed by the legacy review-fix sweep and no
      // timeout can surface a stall. Idempotent by construction (mergeGatePlan returns
      // `create: false` when this PR's gate already exists), so the common no-op short-circuit
      // writes nothing. Armed for a MERGED ref as well as an open one — gate-check closes it on
      // the next pass and dispatches finalization, which is exactly what this target still needs.
      await safe(() => armMergeGate(repo, epicBeadId, prRef, all));
      // Clean up any worktree a prior attempt left behind before short-circuiting (anton-jz1). A
      // resume that crashed AFTER the worktree-warm step (which stamps `worktreePath` on the run
      // row) leaves the git worktree registered/on disk; this idempotent return skips the normal
      // teardown the run phase ends with, so without this the run is marked done yet its worktree
      // lingers. Locate it by branch — this attempt never warmed one, so `runWorktree` is null and
      // the `catch`'s teardown could not see it either.
      //
      // Routed through the same teardown as every other terminal exit (anton-hrun.1) rather than a
      // bare removal: this is a `done` outcome like any other, so it owes the same branch policy (a
      // merged PR on a closed bead takes the branch with it) and the same session account.
      //
      // A prior attempt that DID tear its checkout down leaves branch-only residue, which owes
      // that same policy — so an absent checkout falls back to the synthetic descriptor the
      // teardown accepts (as review-fix's finalize does): a merged PR on a settled target takes
      // the branch here, instead of leaving it for the next scheduled sweep.
      // Best-effort — a run whose PR is already open must not fail over a cleanup.
      await safe(async () => {
        const staleWorktree: Worktree = (await findWorktree(repo, branch)) ?? {
          path: worktreePathFor(repo, branch),
          branch,
          baseBranch: branch,
          repoPath: repo,
        };
        await releaseRunResources({
          db,
          clock,
          ctx,
          projectId,
          runId,
          repoPath: repo,
          worktree: staleWorktree,
          beadId: epicBeadId,
          status: "done",
        });
      });
      await updateRun(db, clock, runId, { status: "done", endedAt: clock.now(), error: null });
      return true;
    }
    // Closed-without-merging ref → stale. Fall through to recover the epic: the foreign-lease gate
    // and general lease adoption below run as usual (nothing adopted here so `finally` owns only what
    // the recovery path takes), the closed tickets are skipped, and the `pr` step re-opens it.
  } else {
    // 0a, the other half of the same question. A send-back RETIRED a PR off this target
    //     (anton-leit) and that PR has since merged. The retire took the ref off on purpose —
    //     this run is the one it exists to let through — but it left the PR named on the bead
    //     (beads.retirePrRef), and a merge landing in that window changes the answer
    //     completely: the work is on
    //     the base branch now, a squash-merge left none of the tickets' `<id>:` commit subjects
    //     to recognise it by, and executing would re-dispatch shipped work onto a branch whose
    //     PR is closed. rework refuses exactly this (resolvePipeline: merged work comes back as
    //     its own target), so a merge that beat the rerun must not get in through the back door.
    //     PARK for the founder, whose call it is: the fix belongs on a new run target, which a
    //     fresh send-back now produces (resolvePipeline reads the retired pointer too).
    //     Only consulted when there is no live ref — a re-stamped one is the live answer and
    //     clears this pointer (beads.setPrRef) — and only when one was actually retired, so the
    //     ordinary run pays no `gh` call. An UNREADABLE state retries, exactly as the live-ref
    //     branch above does and for the same reason: `unknown` is proof of nothing, so letting it
    //     fall through to execute would re-dispatch shipped work whenever the retired PR had in
    //     fact merged — the corruption this branch exists to prevent, now decided by a `gh`
    //     outage. Running is not the cheap fallback it looks like either: `gh` is a hard
    //     dependency of the run (the `pr` step opens/updates the PR), so a run that cannot read it
    //     cannot finish. COUNTING (a plain throw), so a transient outage self-heals within the
    //     retry budget and a permanent one parks for a human instead of retrying forever.
    const retiredPr = beads.getRetiredPrRef(leaseTarget);
    if (retiredPr) {
      const retiredState = await pullRequestState(repo, retiredPr);
      if (retiredState === "unknown") {
        throw new Error(
          `${epicBeadId} was sent back with ${retiredPr} still open, and that pull request's ` +
            `state can't be read (gh unavailable or the ref is unparseable) — retrying rather ` +
            `than re-running a target whose work may already have merged; a transient gh outage ` +
            `self-heals within the retry budget, a permanently-unreadable ref parks for a human`,
        );
      }
      if (retiredState === "merged") {
        throw new PoisonEpic(
          `${epicBeadId} was sent back with ${retiredPr} still open, but that pull request has ` +
            `merged since — its work is on the base branch, so re-running this target would ` +
            `re-dispatch shipped tickets. Send the ticket back again: anton reads ${retiredPr} as ` +
            `merged now and carries the fix as its own run target instead.`,
        );
      }
    }
  }
  return false;
}
