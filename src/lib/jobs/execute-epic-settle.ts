/**
 * How a stopped run settles (anton-1lix — extracted from execute-epic.ts).
 *
 * Three things have to agree by the time this returns: the reservations the board still shows, the
 * status on the run row, and the error the runner sees. They can disagree in exactly one place — an
 * ask whose gate is live but whose park write failed — and that case is why the settle and the
 * cleanup are two steps rather than one: the cleanup is the last window a force-kill can land in,
 * and taking the arm back there rewrites the run's final word.
 */
import { beads } from "../beads/bd";
import { releaseChildren } from "../beads/child-assign";
import { updateRun } from "../runs";
import { releaseRunResources } from "./worktree-reaper";
import {
  isForeignRunOwner,
  isRunAlreadyLiveError,
  isUsageLimitError,
  PoisonEpic,
} from "./errors";
import { reopenAbsorbedTimeouts } from "./execute-epic-board";
import {
  askSettleError,
  BlockedTailError,
  NeedsHumanError,
  ReviewBlockedError,
  StrandedHumanGateError,
  WorktreeDirtyError,
} from "./execute-epic-errors";
import {
  armHumanGate,
  concludeCancelledArmedPark,
  liveArmedAsk,
  reconcileCancelledArmedPark,
  settleArmedAsk,
  strandedAskMessage,
  ungatedAskMessage,
  type ArmedHumanGate,
} from "./execute-epic-human-gate";
import { safe } from "./execute-epic-persist";
import type { EpicRun } from "./execute-epic-run";
import { enqueueSyncPushDeduped } from "./queue";

/** How this attempt settled the row, and what it owes the checkout. */
interface RunSettlement {
  /** What the runner finally sees — rewritable by the cleanup's own kill window. */
  thrown: unknown;
  settledAs: "parked" | "failed";
  /** A live human gate this attempt armed — the checkout follows the WAIT, not the row. */
  awaitsHumanGate: boolean;
}

/**
 * Settle a stopped attempt: hand back what it took, write the row, and release the checkout.
 * Answers what the handler throws once the cleanup has run.
 */
export async function settleStoppedRun(run: EpicRun, raw: unknown): Promise<{ thrown: unknown }> {
  await releaseRunChildren(run, raw);
  const settlement = await settleRunRow(run, raw);
  await teardownStoppedRun(run, settlement);
  return { thrown: settlement.thrown };
}

/**
 * Give the children back before settling the row (anton-0d85), and reopen the timeouts this attempt
 * absorbed (anton-67xj) — both are state a resume or retry has to find as it left it.
 */
async function releaseRunChildren(run: EpicRun, raw: unknown): Promise<void> {
  const { repo, targetId: epicBeadId, ctx, timedOut, childCascade } = run;
  // Give the children back before settling the row (anton-0d85). This attempt has stopped —
  // parked on a blocking review, killed by an abandon, backed off after losing the lease race, or
  // failed outright — so holding its reservations would leave the whole feature invisible to
  // `bd ready --unassigned` on every machine while nothing at all is executing it. The CAS
  // releases only children this run still holds, so a takeover that landed mid-run keeps its new
  // owner. A resumed attempt re-takes them at its own claim gate, which is what makes this safe to
  // do on a recoverable stop. It runs on an ABORT too (a kill, an abandon) — unlike runTicket,
  // which writes nothing there: what runTicket would rewrite is the aborted ticket's STATUS, the
  // thing the abort's author is deciding, whereas a reservation with no run behind it is anton's
  // own bookkeeping either way, and the in-flight ticket it gives back is still `in_progress`, so
  // no `bd ready` serves it to anyone before the resume re-claims it.
  // The ONE exception is a usage-limit park: that run is not dead, it is waiting out a quota
  // window and resumes on THIS machine with everything intact — the same reason runTicket keeps
  // the in-flight ticket's claim on that path, and releasing here would contradict it.
  if (childCascade && !isUsageLimitError(raw)) {
    const release = await releaseChildren(repo, childCascade.ids, childCascade.actor);
    if (release.released.length > 0) {
      console.warn(
        `[execute-epic] ${epicBeadId}: released ${release.released.length} child ticket(s) back ` +
          `to the board — ${release.released.join(", ")}`,
      );
    }
    // A release that never landed is the one outcome nothing downstream reports: the run settles
    // below either way, and those children stay assigned to an actor with no run behind them —
    // hidden from `bd ready --unassigned` on every machine until someone clears them by hand.
    if (release.failed.length > 0) {
      console.error(
        `[execute-epic] ${epicBeadId}: could not release ${release.failed.length} child ` +
          `ticket(s) — ${release.failed.map((f) => f.id).join(", ")} — they remain assigned to ` +
          `${childCascade.actor} with no active run. (${release.failed[0].error})`,
      );
    }
  }
  // Reopen the timeouts this attempt absorbed (anton-67xj). runTicket leaves a rolled-back
  // timeout `blocked` on purpose — the run walks on to its PR and the block is the founder's cue
  // — but that only holds while the run REACHES that PR. Every stop below advertises a retry or
  // a resume instead, and that attempt re-dispatches this ticket: `blocked` is a status bd
  // refuses to claim, so runTicket's hard claim gate would kill the next attempt on a bead THIS
  // one blocked, over a failure (a `not-delivered` write that wouldn't land, a held tail, a
  // review the gate refused) that has nothing to do with it. Same restore the halting paths
  // inside runTicket perform, for the same reason; the note it left is what carries the
  // timeout's account to the operator, not the status.
  //
  // Only the ROLLED-BACK ones: a ticket stopped after its commit stays blocked for a human to
  // read, and reopening it would have the next attempt re-dispatch an agent over work already
  // on the branch. Not on an ABORT either — a kill or an abandon settles these beads itself
  // (an abandon closes them), and reopening one there re-queues work a human just killed, the
  // rule runTicket's own abort path follows.
  //
  // Retried, not best-effort (PR #199 review). Every path below advertises a resume or a retry,
  // and this status is what that attempt's claim gate tests: swallowing a transient bd failure
  // here leaves the ticket `blocked` with nothing said anywhere, so the resume the park promises
  // dies on its first step for a reason nobody can see. A refusal that outlives the retries is
  // logged with its repair, the escalation every other must-land write on this seam makes.
  if (!ctx.signal.aborted) await reopenAbsorbedTimeouts(repo, epicBeadId, timedOut);
}

/** Pick the row status this stop deserves, write it, and compose what the runner sees. */
async function settleRunRow(run: EpicRun, raw: unknown): Promise<RunSettlement> {
  const { db, clock, ctx, runId, orphanNotice } = run;
  // Resolved HERE — after the release awaits, immediately before the settle that would arm the
  // gate — so a kill landing mid-unwind still converts (anton-287p). Nothing before this line
  // branches on the distinction (the release runs the same for either error), so the late read
  // costs nothing earlier.
  const e = askSettleError(raw, ctx.signal);
  // What the runner finally sees. Only the ask branch rewrites it — a kill can land INSIDE the
  // arm, after the read above (anton-287p) — so the row and the thrown error keep telling the
  // same story; that branch answers with a settlement of its own.
  const thrown: unknown = e;
  // Quota, a run already live on another machine (anton-jz1), or a self-review that refused the
  // PR → park the run (the job reschedules, re-checks liveness, or waits for the founder);
  // anything else → the run failed (job retries/parks).
  let settledAs: "parked" | "failed";
  // Only an ARMED ask can leave a live gate behind, and that branch settles itself below.
  const awaitsHumanGate = false;
  if (isUsageLimitError(e)) {
    settledAs = "parked";
    await updateRun(db, clock, runId, { status: "parked", error: `usage-limit${orphanNotice}` });
  } else if (isRunAlreadyLiveError(e)) {
    settledAs = "parked";
    // The notice rides along here too: a lease that merely lapsed still reconciles the branch's
    // orphan PR, and what that found (a PR drafted, or a `gh` lookup that failed) has nowhere
    // else to be reported — this run opens no PR and composes no park message.
    await updateRun(db, clock, runId, {
      status: "parked",
      error: `run-live-elsewhere${orphanNotice}`,
    });
  } else if (e instanceof NeedsHumanError) {
    // Delegated whole, because this is the one branch that writes to the BOARD before it writes the
    // row — and the two can disagree (see {@link settleNeedsHuman}).
    return settleNeedsHuman(run, e, raw);
  } else if (e instanceof BlockedTailError) {
    settledAs = "parked";
    // Parked, not failed, for the same reason as a blocked review below: this run delivered the
    // tickets it could and is waiting on work outside it, so the row must stay open for the
    // resume to continue in (findOpenRunForEpic) rather than read as a crashed attempt.
    await updateRun(db, clock, runId, { status: "parked", error: e.message });
  } else if (e instanceof ReviewBlockedError) {
    settledAs = "parked";
    // Parked, not failed, and with no endedAt: the run is waiting on a human to resolve what the
    // gate refused on and resume it — the run history must not read like a crash. Resuming reuses
    // THIS row (findOpenRunForEpic), so the resumed attempt continues in the same worktree/branch.
    await updateRun(db, clock, runId, { status: "parked", error: e.message });
  } else {
    settledAs = "failed";
    await updateRun(db, clock, runId, {
      status: "failed",
      error: `${e instanceof Error ? e.message : String(e)}${orphanNotice}`,
      endedAt: clock.now(),
    });
  }
  // Hand back the worktree this attempt warmed (anton-hrun.1). Delivery is not the only outcome
  // that owes it: a failure, a kill and an abandon all leave the same checkout and the same
  // branch behind, and before this every one of them tore down nothing. A park keeps both — it
  // resumes in this very worktree — unless its bead was settled underneath it, which is exactly
  // what a kill or an abandon does, and `releaseRunResources` re-reads the bead to see it.
  // Best-effort: a cleanup must never mask the run's own error, and what it misses the scheduled
  // reaper reclaims.
  return { thrown, settledAs, awaitsHumanGate };
}

/**
 * The ask becomes board state before the row settles (anton-287p): a `human` gate on the run target,
 * which a person resolves to release the run through the existing gate-resume pass.
 */
async function settleNeedsHuman(
  run: EpicRun,
  e: NeedsHumanError,
  raw: unknown,
): Promise<RunSettlement> {
  const { db, clock, ctx, repo, runId, targetId: epicBeadId } = run;
  let settledAs: "parked" | "failed";
  let thrown: unknown = e;
  let awaitsHumanGate = false;
  // The ask becomes board state before the row settles (anton-287p): a `human` gate on the run
  // target, which a person resolves to release the run through the existing gate-resume pass.
  // Parked with no endedAt, like a review park — this run is waiting on someone, not dead, and
  // the resume reuses THIS row (findOpenRunForEpic) so its worktree/branch continue.
  //
  // No gate, no park (anton-287p.4): a parked run whose ask reached no gate is a wait no
  // `bd gate resolve` can end, and it would sit in the waiting-on-a-person surface forever. It
  // settles FAILED instead — the ask still reaches the operator, through a run state that
  // reads as needing attention rather than as patience.
  //
  // The arm gets the LIVE signal, not the sampled verdict above: it awaits the board (a strict
  // read, then any supersede) before it writes, so a force-kill arriving in that window would
  // otherwise still land a gate — the very state askSettleError exists to prevent. It refuses
  // the write in that case, and the ask settles in its cancelled form here.
  let gate: ArmedHumanGate | undefined;
  let gateError: string | undefined;
  // The one cancelled arm that DID leave board state behind: the kill landed inside `gate
  // create` and the undo failed too, so a gate blocks the target that this run will never come
  // back for. It cannot settle as "nothing was written" — the id has to reach the operator.
  let stranded: StrandedHumanGateError | undefined;
  try {
    gate = await armHumanGate(repo, epicBeadId, e, ctx.signal);
  } catch (failure) {
    if (failure instanceof StrandedHumanGateError) stranded = failure;
    gateError = failure instanceof Error ? failure.message : String(failure);
    console.error(
      `[execute-epic] could not arm ${epicBeadId}'s human gate — the ask reaches the operator ` +
        `only through this run's error (${gateError})`,
    );
  }
  if (!gate && !stranded && ctx.signal.aborted) {
    // Killed mid-arm — not a gate failure. Nothing was written, so this settles exactly like a
    // kill that beat the ask to the catch: no gate, no park, the ask carried in the error.
    settledAs = "failed";
    thrown = askSettleError(raw, ctx.signal);
    await updateRun(db, clock, runId, {
      status: "failed",
      error: thrown instanceof Error ? thrown.message : String(thrown),
      endedAt: clock.now(),
    });
  } else if (gate) {
    // The gate is live, so the row is the only half left that can disagree with the board —
    // and settling it is the last thing that can go wrong (anton-287p). Written through a
    // reporter, never a raw throw: a rejected write must not swallow the ask this branch
    // exists to deliver.
    const settlement = await settleArmedAsk({
      targetId: epicBeadId,
      ask: e,
      raw,
      gate,
      signal: ctx.signal,
      now: () => clock.now(),
      settle: run.reportSettle,
    });
    thrown = settlement.thrown;
    // A wait still standing is not finished with: the cleanup below has to run, and a kill
    // inside it leaves this gate blocking a target nothing returns to (anton-287p).
    run.armedPark = liveArmedAsk({ gate, ask: e, raw }, settlement);
    // The worktree follows the WAIT, not the row: a settle that failed still leaves the gate
    // standing, and the person who resolves it resumes this attempt here. Only a cancelled
    // unwind — which takes the gate back — leaves nothing coming for the checkout.
    settledAs = settlement.parked ? "parked" : "failed";
    awaitsHumanGate = settlement.awaitsHumanGate;
  } else {
    // The run FAILED, so the error the runner sees has to say so (PR #205 review). The ask's
    // own message promises a park "until someone answers it" — with no gate there is nothing
    // to answer on, and carrying it out unchanged would poison-park the job claiming a wait
    // that no `bd gate resolve` can end. Thrown as the same sentence the row records, so the
    // job outcome and the run row tell one story.
    settledAs = "failed";
    const reason = stranded
      ? strandedAskMessage(e, stranded)
      : ungatedAskMessage(e, gateError);
    thrown = new PoisonEpic(reason);
    await updateRun(db, clock, runId, {
      status: "failed",
      error: reason,
      endedAt: clock.now(),
    });
  }
  return { thrown, settledAs, awaitsHumanGate };
}

/** Hand back the worktree this attempt warmed (anton-hrun.1) — every terminal outcome owes it. */
async function teardownStoppedRun(run: EpicRun, settlement: RunSettlement): Promise<void> {
  const { db, clock, ctx, projectId, repo, runId, targetId: epicBeadId } = run;
  const { settledAs, awaitsHumanGate, thrown: e } = settlement;
  const stoppedWorktree = run.worktree;
  if (stoppedWorktree) {
    // Ahead of the release for the same reason as the delivered path: this run's own claim would
    // refuse the removal it is asking for. A park that keeps the checkout drops the claim in
    // {@link concludeRunAttempt} instead — it stops executing either way.
    await run.releaseWorktreeHold();
    const teardown = {
      db,
      clock,
      ctx,
      projectId,
      runId,
      repoPath: repo,
      worktree: stoppedWorktree,
      beadId: epicBeadId,
      // Only a CONFIRMED foreign owner keeps this machine's hands off the checkout — the same
      // rule the gate's orphan reconcile applies. A lease this run merely couldn't keep
      // (`unproven`) proves nothing about who else is running, and reading it as foreign skips
      // the teardown of a worktree nobody else owns.
      foreign: isForeignRunOwner(e),
      // A halt over unrollbackable partial work keeps its checkout: that tree is the only copy
      // of the work, and the run's own note tells an operator to clear THIS path before
      // resuming — a `--force` release here would delete what that instruction points at.
      holdsPartialWork: e instanceof WorktreeDirtyError,
    };
    let kept = false;
    await safe(async () => {
      const entry = await releaseRunResources({
        ...teardown,
        status: settledAs,
        // A wait whose gate is live keeps its checkout even when the row settled as failed: the
        // resume reuses this run, and the tree carries the edits the ask stopped in the middle
        // of (PR #205 review).
        awaitsHumanGate,
      });
      kept = entry.outcome === "kept";
    });
    // A checkout kept for a park the cleanup's kill window can still unseat is one this run may
    // owe back after all (PR #205 review): the reconcile below turns that park into a FAILED run
    // nothing resumes, and no other pass reclaims the tree — the scheduled reaper keeps every
    // checkout whose bead is still open, and this target's is. Armed only when the teardown
    // really kept something, so no other keep (foreign, partial work) is torn down behind it.
    if (kept && awaitsHumanGate) {
      run.releaseGateKeptWorktree = async () => {
        await safe(() =>
          releaseRunResources({ ...teardown, status: "failed", awaitsHumanGate: false }),
        );
      };
    }
  }
}

/**
 * The cleanup every attempt runs, delivered or not — the handler's `finally`. Everything before it
 * is an uninterruptible await and the sync is seconds of network, so this is the last — and widest —
 * window a force-kill can land in (anton-287p): a wait armed by the settle would otherwise be left
 * blocking a target no resume is coming for.
 *
 * Answers a replacement settlement when that reconcile unseated the park, else `undefined`.
 */
export async function concludeRunAttempt(run: EpicRun): Promise<{ thrown: unknown } | undefined> {
  const { db, clock, ctx, projectId, repo, targetId: epicBeadId, lease } = run;
  // Whatever else happened, this attempt is no longer executing in the checkout, so it may not
  // keep claiming it — a claim outliving its run would make the worktree and branch unreapable
  // by every later pass, on this machine and every other, until anton restarts. A no-op on the
  // paths that already released during the settle.
  await run.releaseWorktreeHold();
  // Stop refreshing and drop the run-liveness lease now that this attempt has stopped executing
  // (anton-jz1). Clearing on EVERY settle path — done, parked, failed — is what lets a Force run
  // re-trigger a stopped run immediately instead of waiting out the lease TTL; a hard crash that
  // skips this still self-heals when the (un-refreshed) lease expires. The sync below pushes the
  // removal to the remote.
  await lease.settle();

  // Every bd write above (claims, closes, stage labels, PR ref, lease clear) must reach the
  // remote even when the run failed mid-way. Logged, not thrown: a push failure must not mask
  // the run's own error or fail a run whose real work (branch + PR) already landed.
  await beads
    .sync(repo)
    .catch((e) => console.error(`[execute-epic] beads dolt sync failed for ${epicBeadId}`, e));

  // Everything above is an uninterruptible await and the sync is seconds of network, so this is
  // the last — and widest — window a force-kill can land in (anton-287p). By then the ask is a
  // live gate on the board and nothing else re-reads the signal: without this the stopped run
  // would leave its wait blocking a target no resume is coming for.
  const park = run.armedPark;
  if (park) {
    const concluded = await concludeCancelledArmedPark({
      gateId: park.gate.gateId,
      reconcile: () =>
        reconcileCancelledArmedPark({
          targetId: epicBeadId,
          ...park,
          signal: ctx.signal,
          now: () => clock.now(),
          settle: run.reportSettle,
        }),
      releaseKeptWorktree: run.releaseGateKeptWorktree,
      // Taking the arm back is a LOCAL bd write and the sync that would have carried it has
      // already run, so without this push the gate still reads as OPEN on every other machine —
      // the very state the reconcile just cleared here.
      push: () =>
        beads
          .sync(repo)
          .then(() => true)
          .catch((e) => {
            console.error(`[execute-epic] beads dolt sync failed for ${epicBeadId}`, e);
            return false;
          }),
      queuePush: () => {
        try {
          enqueueSyncPushDeduped(db, clock, projectId);
        } catch (e) {
          console.error(`[execute-epic] enqueue sync-push failed for ${projectId}`, e);
        }
      },
    });
    if (concluded) return concluded;
  }
  return undefined;
}
