/**
 * The ticket phase of a run (anton-1lix — extracted from execute-epic.ts): which of the target's
 * tickets this attempt dispatches, in what order, and what it does about the ones it cannot.
 *
 * Three sets come out of it and every one of them is load-bearing downstream: what was DELIVERED
 * (the PR body and the review contract speak for exactly that), what was HELD (a blocker outside
 * this run — the tail parks), and what was SKIPPED behind a rolled-back timeout (merge finalization
 * reads its marker, not this module's memory).
 */
import { beads, LABELS, type Bead } from "../beads/bd";
import { claimGuard } from "../beads/claim";
import { contractGaps, formatContractGaps } from "../beads/contract";
import { resumeSkipped } from "../ticket-view";
import { worktreeHasCommitFor } from "../git/ops";
import { blockedTailReason, PoisonEpic } from "./errors";
import {
  deliveredTickets,
  inactiveAgentTickets,
  openHumanGateAsks,
  orderTickets,
  skipNote,
  skippedDependents,
  type SkipCause,
} from "./execute-epic-board";
import { BlockedTailError, TicketTimeoutError } from "./execute-epic-errors";
import { mustPersist, mustRead, safe } from "./execute-epic-persist";
import type { RunPreparation } from "./execute-epic-prepare";
import type { EpicRun } from "./execute-epic-run";
import { runTicket } from "./execute-epic-ticket";

/** What the ticket phase leaves for the run phase to speak for. */
export interface DispatchOutcome {
  /** The tickets whose work is actually on the branch — the PR body and review contract's set. */
  delivered: Bead[];
  /** Tickets this run never dispatched, and the timeout each is waiting behind. */
  skipped: Map<string, SkipCause>;
}

/** What the loop learns as it goes, and what the tail and the delivery verdict then read. */
interface DispatchLedger {
  /**
   * The graph verdict — every ticket transitively behind a rolled-back one — recomputed as each
   * timeout lands. Distinct from {@link skipped}, which is what the loop ACTUALLY passed over: a
   * dependent whose commit was already on the branch still counts as delivered.
   */
  skipCause: Map<string, SkipCause>;
  skipped: Map<string, SkipCause>;
  /**
   * Tickets whose commit is on THIS branch — where a timeout cascade stops (PR #199 review). A
   * ticket closed on another machine whose commit this worktree already carries is delivered, so the
   * tickets written against IT still have their mechanism and must still run, whatever rolled back
   * further up the chain. Same rule merge finalization applies; recorded as the loop goes, since
   * only the loop knows what actually landed here.
   */
  onBranch: Set<string>;
}

/** Dispatch every ticket this run may run, then answer what it delivered. */
export async function dispatchRunTickets(
  run: EpicRun,
  prep: Extract<RunPreparation, { done: false }>,
): Promise<DispatchOutcome> {
  const { live, held, dispatchable } = partitionTickets(run, prep.gated);
  const ledger: DispatchLedger = {
    skipCause: new Map(),
    skipped: new Map(),
    onBranch: new Set(),
  };
  const recordSkipped = makeSkipRecorder(run, ledger);

  for (const ticket of dispatchable) {
    await dispatchTicket(run, prep, ticket, ledger, recordSkipped);
  }

  // A ticket its budget stopped BEFORE its commit step is not part of what this run delivered
  // (anton-t1mo) — whether its work was rolled back or preserved on the branch as an explicitly
  // incomplete commit (anton-d967), nobody finished it. Read by the tail's park and by the delivery
  // verdict below.
  const stoppedShort = new Set(run.timedOut.filter((t) => !t.delivered).map((t) => t.id));
  await settleHeldTail(run, prep, { held, dispatchable, ledger, stoppedShort, recordSkipped });
  return {
    delivered: await deliveredOrPark(run, prep, live, ledger, stoppedShort),
    skipped: ledger.skipped,
  };
}

/** The run's tickets, split into what it may dispatch now and what a blocker outside it holds. */
function partitionTickets(
  run: EpicRun,
  gated: Set<string>,
): { live: Bead[]; held: Bead[]; dispatchable: Bead[] } {
  const { targetId: epicBeadId, tickets, all } = run;
  // 4. Per ticket: the formula's ticket phase (its steps up to and including the commit) →
  //    (close | in-review). Skip work that already
  //    landed on a prior attempt. A closed ticket is done — an epic's children close as they
  //    commit, and any resumed run skips them. A standalone target is NEVER closed here (its
  //    close is a merge-time concern, below): the moment its single ticket commits, runTicket
  //    moves it to stage:in-review instead — that label is both the board's "in review" state
  //    and the persisted resume marker, so a retry after a failed PR step skips straight to
  //    the PR step here rather than re-running claude/tests/commit on already-committed work.
  // Abandoned tickets are dropped from the run entirely (anton-6xj0). Filtered out HERE, ahead
  // of the done-on-board logic below: an abandoned bead IS closed, but its work was never
  // committed, so that logic would read "closed with no commit on this branch" as a
  // cross-machine resume, reopen it, and re-run the agent on work a human explicitly killed.
  const live = orderTickets(tickets, all).filter((t) => !beads.isAbandoned(t));
  if (live.length === 0) {
    // Every ticket abandoned but the epic left open — a contradiction only a human can settle
    // (abandon the epic too, or add work to it). Park rather than open an empty PR or mark the
    // run done, either of which would read as a delivery that never happened.
    throw new PoisonEpic(
      `every ticket under ${epicBeadId} has been abandoned — nothing left to run; abandon the ` +
        `epic itself or give it work, then resume the run`,
    );
  }
  // A ticket a bead OUTSIDE this run still blocks is HELD, not run (anton-1two): its work depends
  // on code that hasn't landed, so dispatching it would hand the agent a premise that doesn't
  // exist yet — the false-success shape issue #46 is about. Its runnable siblings are independent
  // work, so they run now (the readiness verdict above already refused a run with none of them),
  // and the held tail parks the run after the loop rather than riding into the PR unrun.
  const held = live.filter((t) => gated.has(t.id));
  const dispatchable = live.filter((t) => !gated.has(t.id));
  return { live, held, dispatchable };
}

/**
 * Hand a ticket this run will NOT dispatch back to the board, and say so on it. Shared by the
 * dispatch loop and by the held tail, which reaches the same verdict for a ticket a cross-run
 * blocker also holds — one writer, so the two paths can never leave a skipped ticket in different
 * states. `doneOnBoard` is the caller's answer to "closed elsewhere, commit absent here"; only that
 * case needs the reopen.
 */
function makeSkipRecorder(
  run: EpicRun,
  ledger: DispatchLedger,
): (ticket: Bead, skipping: SkipCause, doneOnBoard: boolean) => Promise<void> {
  const { repo, targetId: epicBeadId } = run;
  const { skipped } = ledger;
  return async (ticket, skipping, doneOnBoard) => {
    const reservedFor = run.childCascade?.actor;
    skipped.set(ticket.id, skipping);
    // Every board write below is decided on a read taken under this ticket's write lock
    // (PR #199 review). `tickets` is the run's snapshot, and project concurrency lets the SAME
    // operator own a second run: that run can reparent this ticket onto a target of its own
    // and claim it there under the very actor string this run reserved it under, which an
    // actor-only CAS matches. Marking a ticket that has left this run `not-delivered` sends
    // the OTHER run's merge finalization off preserving work that shipped, and releasing it
    // clears a live reservation. What tells the two runs apart is the rest of the bead — its
    // parent and its status — so the writes land only while a fresh read still finds the
    // ticket exactly where and as this run left it. The lock orders every claim write made in
    // THIS process; the cross-process half stays open on bd's current primitives (anton-od4).
    //
    // A new ASSIGNEE is deliberately not one of those signals (PR #199 review). A reservation
    // says who will run the ticket next, not that it left this run: it is still this target's
    // child, still open, and still in no diff this PR carries — and the merge closes what it
    // finds open, so withholding the marker there is the silent loss the marker exists to
    // prevent. The reservation itself is what the CAS below protects.

    const moved = await claimGuard.withClaimLock(repo, ticket.id, async (swap) => {
      // The guarded read is the evidence BOTH writes below are decided on, so it is retried
      // like the writes are, and a run that still cannot take it stops (PR #199 review).
      // Tagging on an unreadable bead is not the safe half of the trade: a second run that has
      // already reparented and claimed this ticket would deliver it with `not-delivered` still
      // attached — runTicket only clears the label off its OWN snapshot, taken before this late
      // write — and merge finalization then preserves and rehomes work that shipped. Withholding
      // the marker is not safe either; it is the silent loss the marker exists to prevent. So
      // neither write is made on an unverified ticket: the run parks with the board named, and
      // the resume re-reads it.
      const live = await mustRead(repo, ticket.id);
      if (!live) {
        throw new PoisonEpic(
          `${ticket.id} was skipped because ${skipping.stopped} ran out of time, but bd would ` +
            `not read the ticket back, so anton cannot tell whether it is still this run's to ` +
            `mark — the run stopped rather than write \`${LABELS.notDelivered}\` onto a ticket ` +
            `another run may already own. Check the beads DB, then resume the run`,
        );
      }
      if (
        beads.parentOf(live) !== beads.parentOf(ticket) ||
        live.status !== ticket.status
      )
        return true;
      // Closed on another machine but its commit never reached this branch, and now it will
      // never be regenerated here — reopen it, or the board advertises work no PR contains.
      // Required, not best-effort: merge finalization only preserves and rehomes children that
      // are still OPEN, so a ticket left closed here is recorded as shipped by the very merge
      // that proves it never was — the `not-delivered` marker below cannot rescue it.
      if (doneOnBoard && ticket.status === "closed") {
        if (!(await mustPersist(() => beads.reopen(repo, ticket.id)))) {
          throw new PoisonEpic(
            `${ticket.id} is closed on the board but its commit is on no branch here, and it ` +
              `was skipped because ${skipping.stopped} ran out of time — bd would not reopen ` +
              `it, so the merge of this run's pull request would file work no diff contains ` +
              `as shipped. Check the beads DB, then resume the run`,
          );
        }
      }
      // Mark it as work this run did NOT deliver, which is what stops merge finalization from
      // closing it as shipped when the PR for the rest of the feature lands (anton-67xj). That
      // marker is finalization's only input, so it is not best-effort: a run that cannot record
      // it must not go on to open a PR whose merge would then file this ticket as shipped.
      // Retry, then park for a human rather than proceed on an unwritten fact.
      //
      // Written BEFORE the reservation goes back (PR #199). The release is what makes this
      // ticket claimable again on a shared board, and a second run that takes it in the gap
      // would snapshot it without the marker — runTicket clears the label off its own snapshot,
      // so it would never clear this one, and the ticket could deliver with `not-delivered`
      // still attached, which sends merge finalization off preserving and rehoming work that
      // actually shipped. While the reservation stands, `bd ready --unassigned` keeps the ticket
      // out of every other worker's claimable set, so there is no such snapshot to take.
      if (!(await mustPersist(() => beads.tag(repo, ticket.id, [LABELS.notDelivered])))) {
        throw new PoisonEpic(
          `${ticket.id} was skipped because ${skipping.stopped} ran out of time, but bd would ` +
            `not record \`${LABELS.notDelivered}\` on it — the run stopped rather than open a ` +
            `pull request whose merge would close this undelivered ticket as shipped. Check ` +
            `the beads DB, then resume the run`,
        );
      }
      // …then hand it back: the run's claim cascade reserved it, and a ticket left assigned to a
      // run that never dispatched it is invisible to `bd ready --unassigned` on every machine.
      //
      // ONLY this run's own reservation, under the cascade's compare-and-swap (anton-67xj) —
      // an operator who took this ticket over between the cascade and this skip is doing live
      // work, and an unconditional unassign would advertise their ticket as claimable and
      // invite a second run of it. `live` was read under this lock, so it IS the swap's own
      // re-read: handed in rather than paid for twice.
      if (reservedFor) await safe(() => swap(reservedFor, undefined, live));
      return false;
    });
    await safe(() => beads.note(repo, ticket.id, skipNote(skipping, moved)));
    console.warn(
      `[execute-epic] ${epicBeadId}: skipped ${ticket.id} — it depends on ` +
        `${skipping.waitingOn}, whose work was rolled back when ${skipping.stopped} ran out ` +
        `of time` +
        (moved
          ? ` (the board has since moved it on, so anton left its labels and reservation alone)`
          : ""),
    );
  };
}

/** One ticket's turn: skip what is already here, hold what lost its mechanism, run the rest. */
async function dispatchTicket(
  run: EpicRun,
  prep: Extract<RunPreparation, { done: false }>,
  ticket: Bead,
  ledger: DispatchLedger,
  recordSkipped: (t: Bead, c: SkipCause, doneOnBoard: boolean) => Promise<void>,
): Promise<void> {
  const { repo, targetId: epicBeadId, ctx, standaloneRun, lease, settings, target } = run;
  const { tickets, all, timedOut, userAgentIds, operator, ticketTimeoutMs } = run;
  const { isResumeSkipped, worktree, runStep, ticketSteps } = prep;
  const { onBranch } = ledger;
  lease.assertHeld(); // yield before starting a ticket if the shared lease has lapsed
  // Human work never reaches an agent, whatever the readiness verdict said (anton-mv70). A
  // FINISHED one is skipped here rather than below, because a person's work leaves no commit:
  // the resume check below reads "closed with nothing on this branch" as a cross-machine
  // resume and would reopen it and regenerate it under the default agent — the exact failure
  // the label exists to prevent. An OPEN one is a broken state: 0b-pre armed its gate and the
  // graph holds it, so reaching here means the board disagrees with the gate it carries. Park
  // loudly instead of improvising; the gate is on the board either way, and answering it is
  // what moves this run on.
  if (beads.isHumanWork(ticket)) {
    if (isResumeSkipped(ticket)) return;
    throw new PoisonEpic(
      `${ticket.id} is labelled ${LABELS.agentHuman} — a person executes it, so no agent can ` +
        `run it. It should be held by a human gate for this run: do the work, resolve that ` +
        `gate, and the resumed run closes ${ticket.id} and carries on without it`,
    );
  }
  // A ticket marked done on the board — a closed epic child, or a standalone target moved to
  // stage:in-review — is only safe to SKIP if its commit is actually present on THIS
  // worktree's branch (anton-jz1). Board state propagates cross-machine via `bd sync`, but the
  // branch is pushed only at the PR step: a ticket another machine closed then parked/crashed
  // on (before openPullRequest) has its commit solely in that machine's local, never-pushed
  // worktree. This machine's fresh worktree branches off origin/<base> and lacks it, so
  // skipping on board state alone would open the epic's single PR missing that work while the
  // board still marks it done. Re-run it here so its commit lands on this branch. On a
  // same-machine resume the worktree is reused and the commit is present, so this skips as
  // before — no redundant re-run.
  const doneOnBoard = resumeSkipped(ticket, standaloneRun);
  if (doneOnBoard && (await worktreeHasCommitFor(worktree.path, ticket.id))) {
    if (standaloneRun) {
      // Resume after a failed PR step: this standalone ticket committed and moved to in-review
      // on a prior attempt. Step 2 above re-tagged the target stage:implementing (it can't
      // tell a fresh run from a resume), and runTicket — the only standalone path that clears
      // implementing — is being skipped here. Clear it now so the ticket doesn't carry BOTH
      // stage labels into merge-finalize, which strips only in-review and would otherwise
      // leave a stale implementing label (making a reopened bead derive as in-progress).
      await safe(() => beads.untag(repo, ticket.id, [LABELS.stage("implementing")]));
    }
    onBranch.add(ticket.id);
    // Rebuild the cascade around it (PR #199 review). `skipCause` was computed at the
    // timeout, before the loop knew this ticket's commit was already here: for a→b→c it
    // still names both b and c, and c would be skipped over a mechanism that IS on the
    // branch. Only matters when this ticket was itself in the cascade — otherwise the walk
    // never reached it and the verdict is unchanged.
    if (ledger.skipCause.has(ticket.id)) {
      ledger.skipCause = skippedDependents(timedOut, tickets, all, onBranch);
    }
    return;
  }
  // A ticket whose prerequisite ran out of time is SKIPPED, not dispatched (anton-67xj). The
  // rollback took the mechanism it was written against off the branch, so its agent can only
  // report the absence and exit with a zero diff — which the no-delivery gate then reads as a
  // failed run, poisoning the tickets that DID deliver. Checked after the done-on-board skip
  // above (work already on this branch is delivered, whatever timed out later) and before the
  // re-gates below, which must not park a run over a ticket that is no longer going to run.
  const skipping = ledger.skipCause.get(ticket.id);
  if (skipping) {
    await recordSkipped(ticket, skipping, doneOnBoard);
    return;
  }
  // Done on the board but the commit is missing from this branch (cross-machine resume): the
  // work must be regenerated here, which re-runs the ticket's agent. Step 0b's allowlist gate
  // SKIPPED this ticket — isResumeSkipped treats any done-on-board bead as "won't run", which
  // is only true when its commit is present. Now that we know it WILL re-run, re-gate it here
  // (anton-jz1): a ticket whose `agent:` label was disabled since it first closed must
  // poison-park, exactly as step 0b does, rather than silently regenerate under the default
  // agent. Checked before the reopen/runTicket so the re-run never starts.
  if (doneOnBoard) {
    const disabled = inactiveAgentTickets([ticket], settings.agents, userAgentIds);
    if (disabled.length > 0) {
      throw new PoisonEpic(
        `epic ${epicBeadId} needs agents enabled in this project's settings: ` +
          disabled.map((x) => `${x.id} → agent:${x.agent}`).join(", ") +
          ` — enable them in Settings → Agents (or relabel the tickets), then resume the run`,
      );
    }
    // Same re-gate for the bead contract (anton-j9zs): step 0c skipped this ticket as
    // resume-skipped, which only holds while it isn't re-run. Regenerating its work under a
    // spec with no definition of done is the state that gate exists to refuse. The grouped
    // TARGET is re-checked alongside the ticket: its criteria are the rubric self-review
    // scores the regenerated work against, and a run whose children all arrived closed was
    // gated on nothing at 0c — this is the first time that target's spec is read.
    const regressed = contractGaps(
      ticket.id === target.id ? [ticket] : [target, ticket],
      "blocking",
    );
    if (regressed.length > 0) {
      throw new PoisonEpic(
        `epic ${epicBeadId} has beads that don't meet the bead contract: ` +
          formatContractGaps(regressed) +
          ` — write the missing section(s), then resume the run`,
      );
    }
  }
  // Done on the board but the commit is missing from this branch (cross-machine resume): the
  // work must be regenerated here. Reopen a closed child first so runTicket's claim + close
  // operate on a live bead (a standalone target is never closed, so it needs no reopen).
  if (doneOnBoard && ticket.status === "closed") {
    await safe(() => beads.reopen(repo, ticket.id));
  }
  try {
    await runTicket({
      run: runStep,
      steps: ticketSteps,
      ticket,
      operator,
      closeOnDone: !standaloneRun,
      standalone: standaloneRun,
      timeoutMs: ticketTimeoutMs,
    });
    onBranch.add(ticket.id); // it committed, so nothing behind it is missing its mechanism
  } catch (e) {
    // A ticket that ran out of time is the ONE failure this loop absorbs (anton-t1mo). It has
    // already blocked its own bead and settled its partial work — preserved in a commit of its
    // own or rolled back (anton-d967) — so the feature can carry on: the tickets behind it are
    // independent work, and ending the run here would deliver none of them — the exact failure
    // this budget exists to prevent. Every other failure still halts the run, unchanged.
    if (!(e instanceof TicketTimeoutError)) throw e;
    timedOut.push({
      id: e.ticketId,
      delivered: e.delivered,
      ...(e.preservedOn ? { preserved: true } : {}),
      ...(e.preservedUnknown ? { preservedUnknown: true } : {}),
    });
    if (e.delivered) onBranch.add(e.ticketId); // the deadline hit the bookkeeping, not the code
    console.warn(`[execute-epic] ${epicBeadId}: ${e.message}`);
    // Recomputed over the whole ledger, which decides for itself what cascades: a timeout
    // that landed AFTER its commit takes nothing down with it (anton-67xj). Walked over
    // `tickets` rather than `live`: an abandoned ticket still sits on the `blocks` edges of
    // the chain around it, so dropping it from the graph would cut the walk short and
    // dispatch the tickets BEHIND it against work the rollback took off the branch.
    ledger.skipCause = skippedDependents(timedOut, tickets, all, onBranch);
  }
  // A finished ticket is progress — reported here so the runner's no-progress timeout
  // measures a wedge rather than a long-but-healthy feature (anton-t1mo).
  await ctx.heartbeat();
}

/**
 * 4a. The held tail stops the run HERE (anton-1two) — after every runnable ticket has committed and
 * before anything speaks for the run as a whole. A run target ships ONE pull request for its whole
 * self, so opening it now would advertise a feature that is missing the tickets a cross-run blocker
 * held; closing them to make the set look whole would be the same false success one ticket down. So
 * park: the committed work stays on the branch, the held tickets stay open and unrun, and the resume
 * that follows the blocker landing walks this same branch — skipping what already committed — and
 * opens the single PR then.
 *
 * A held ticket that ALSO sits behind a rolled-back timeout is the one exception (anton-67xj): the
 * blocker is no longer the reason it can't run — the mechanism it was written against was rolled off
 * the branch, and the ticket that owned it is `blocked`, which bd refuses to claim. So the resume
 * this park promises could not dispatch it either, and parking would strand the commits the run's
 * independent tickets already made behind a wait that decides nothing. Only tickets held for a
 * reason a resume can clear hold the run.
 */
async function settleHeldTail(
  run: EpicRun,
  prep: Extract<RunPreparation, { done: false }>,
  args: {
    held: Bead[];
    dispatchable: Bead[];
    ledger: DispatchLedger;
    /** Tickets the budget stopped before their commit — rolled back or preserved, never delivered. */
    stoppedShort: Set<string>;
    recordSkipped: (t: Bead, c: SkipCause, doneOnBoard: boolean) => Promise<void>;
  },
): Promise<void> {
  const { targetId: epicBeadId, all } = run;
  const { held, dispatchable, ledger, stoppedShort, recordSkipped } = args;
  const { skipCause, skipped } = ledger;
  const freshReadiness = prep.readiness;
  const stillHeld = held.filter((t) => !skipCause.has(t.id));
  if (stillHeld.length > 0) {
    // A human gate among the blockers is an ASK, not work in flight — the same reason
    // blockedRunPoison names them (anton-mv70). A run held at a human ticket's boundary parks
    // here rather than there, so without this its only record reads "blocked by g-…" and
    // nothing in it says a person is what it is waiting for.
    const asks = openHumanGateAsks(all, freshReadiness.blockers);
    const tail = blockedTailReason(epicBeadId, {
      blockers: freshReadiness.blockers,
      // Every held ticket, including the timeout-skipped ones: the run parks either way, and
      // the operator reading the park is owed the whole tail rather than half of it.
      held: held.map((t) => t.id),
      ran: dispatchable
        .filter((t) => !stoppedShort.has(t.id) && !skipped.has(t.id))
        .map((t) => t.id),
    });
    throw new BlockedTailError(asks.length > 0 ? `${tail}. ${asks.join(" ")}` : tail);
  }
  // The run proceeds, so the held tail is now work this run did not deliver and must say so on
  // its own beads — otherwise the merge of the PR the run phase opens closes it as shipped. Recorded
  // only once the park above is ruled out, so a run that still parks leaves the board untouched.
  // `doneOnBoard: false` — the epic graph puts closed children in neither the ready nor the held
  // set, so a held ticket is open by construction and has no cross-machine close to undo.
  // Every held ticket has a cause here: `stillHeld` is exactly the ones without one, and the
  // park above throws whenever that set is non-empty.
  for (const ticket of held) {
    await recordSkipped(ticket, skipCause.get(ticket.id)!, false);
  }
}

/** What this run delivered — or the park it owes when nothing survived to show. */
async function deliveredOrPark(
  run: EpicRun,
  prep: Extract<RunPreparation, { done: false }>,
  live: Bead[],
  ledger: DispatchLedger,
  stoppedShort: Set<string>,
): Promise<Bead[]> {
  const { targetId: epicBeadId, timedOut } = run;
  const { skipped } = ledger;
  const { worktree } = prep;
  // What the RUN phase then speaks for (anton-lnkt): its steps read this run's whole diff and put
  //     these ids in the PR body, so the set has to be the work actually on the branch.
  //     `live`, not `tickets`: an abandoned ticket contributed no commit, so listing it would
  //     advertise work this run doesn't contain (anton-6xj0). A ticket its budget STOPPED before
  //     its commit step is dropped for the same reason (anton-t1mo) — leaving it in would put it
  //     in the PR body as delivered and hand the reviewer a contract nobody finished. That holds
  //     whether its work was rolled back or PRESERVED on the branch (anton-d967): the preserved
  //     commit is in the diff, but it is explicitly incomplete and its bead stays blocked, so
  //     claiming it as delivered is the false success the delivery gate exists to refuse. One
  //     stopped AFTER its commit stays: its code is in the diff and its ticket did finish, so
  //     dropping it would hide work the reviewer must read.
  //     A ticket SKIPPED behind a rolled-back one (anton-67xj) never ran at all, so it is out
  //     for the same reason — the PR body must not claim work that has no diff, so it never
  //     reaches the branch question below.
  //     A HUMAN ticket goes for the same reason (anton-mv70): a person did it outside this
  //     branch — 0b-pre closed it on the way back in — so no commit here carries it. Leaving it
  //     would advertise a signature or a purchase in the PR body as delivered by a diff that
  //     cannot contain it, and hand the review gate a contract no code in the diff can satisfy,
  //     parking the run at review after the person already did their part. The BRANCH decides
  //     that, not the label (PR #213 review): a ticket an agent committed on an earlier attempt
  //     and someone relabelled `agent:human` afterwards is still in this diff, and dropping it
  //     would hide work the reviewer must read — and, when it is the only ticket, make the
  //     no-delivery park below claim an empty branch that has commits on it.
  const delivered = await deliveredTickets(
    live.filter((t) => !skipped.has(t.id)),
    stoppedShort,
    (id) => worktreeHasCommitFor(worktree.path, id),
  );

  // Nothing survived, so this run has nothing to show (anton-t1mo). Absorbing the timeouts is
  // only correct while SOMETHING landed — carrying on here would run the review gate over an
  // empty diff and open a PR that delivers nothing, the same false success the no-delivery gate
  // refuses. Park instead: a whole feature timing out is a budget or a scoping problem, and a
  // human has to pick which.
  if (timedOut.length > 0 && delivered.length === 0) {
    throw new PoisonEpic(outOfTimeParkMessage(run, [...skipped.keys()]));
  }

  // Nothing timed out and still nothing is left to show: every live ticket is human work a
  // person did outside this branch (anton-mv70) — the resume that closed the last answered gate
  // lands here with an empty set. The run phase speaks for a diff, so carrying on would review
  // nothing and hand `gh pr create` a branch with no commits between it and the base. Park
  // instead, naming the one thing left to do: this target ships no code, so a person settles it.
  if (delivered.length === 0) {
    throw new PoisonEpic(
      `every ticket under ${epicBeadId} is work a person does, not an agent ` +
        `(${live.map((t) => t.id).join(", ")}) — they are done and nothing was committed on ` +
        `this branch, so there is no pull request to open. Close ${epicBeadId} by hand to ` +
        `settle it, or give it a ticket an agent can deliver and resume the run`,
    );
  }
  return delivered;
}

/**
 * The park a run owes when its budget took everything (anton-t1mo), worded for the run it actually
 * was (anton-d967).
 *
 * Two things were wrong with saying one thing here. A CHILDLESS run target IS its own single ticket
 * (`beads.groupsChildren` reads it that way), so "every ticket under X ran out of time — re-scope
 * them into smaller tickets" named a set of one and told the operator to do the impossible: there
 * are no sibling tickets to redistribute the work across. What that operator can actually do is
 * raise the budget or SPLIT the bead into children, so that is what it says.
 *
 * And a park has to say what became of the work, because the answer decides what a resume IS: work
 * preserved on the branch means the resume continues from it, while a rollback means it starts over.
 * When the preserve could not READ the branch it rolled back onto, that answer is unknown (PR #228
 * review) — and an unknown fate is spoken as one here rather than folded into the rollback, which
 * would tell the operator to expect a fresh start on a branch that may still carry the work.
 */
export function outOfTimeParkMessage(run: EpicRun, skippedIds: string[]): string {
  const { targetId, timedOut, branch, standaloneRun, ticketTimeoutMs } = run;
  const budget = Number.isFinite(ticketTimeoutMs)
    ? `${Math.round(ticketTimeoutMs / 60_000)}m`
    : "unbounded";
  const preserved = timedOut.filter((t) => t.preserved).map((t) => t.id);
  const stopped = timedOut.filter((t) => !t.preserved && !t.delivered);
  const unknown = stopped.filter((t) => t.preservedUnknown).map((t) => t.id);
  const rolledBack = stopped.filter((t) => !t.preservedUnknown).map((t) => t.id);
  const fate = [
    preserved.length > 0
      ? `The work of ${preserved.join(", ")} is PRESERVED on branch \`${branch}\` as an ` +
        `explicitly incomplete commit — it passed this project's verify gates — so resuming ON ` +
        `THIS MACHINE continues from it rather than redoing it. A run branch is pushed only when ` +
        `its pull request is opened, so a resume elsewhere starts the ticket over instead.`
      : null,
    unknown.length > 0
      ? `What ${unknown.join(", ")} added was rolled back, but anton could not read \`${branch}\`'s ` +
        `history, so whether an earlier attempt's preserved commit is still on it is UNKNOWN — the ` +
        `rollback restores a baseline such a commit would be part of. Check \`${branch}\` before ` +
        `resuming: a resume continues from that commit if it is there and starts the ticket over ` +
        `if it is not.`
      : null,
    rolledBack.length > 0
      ? `The work of ${rolledBack.join(", ")} was rolled back, so resuming starts it over.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  if (standaloneRun) {
    // Splitting is only free when nothing was kept. A preserved commit belongs to the TARGET, and no
    // child ticket will ever deliver it — so the split has to take it off the branch first, or the
    // children's pull request carries its unfinished diff into the trunk. The resumed run refuses to
    // start while it is there (execute-epic-prepare), and this is where the operator hears why.
    const split =
      preserved.length > 0
        ? `, or split ${targetId} into child tickets that each fit the budget — taking the ` +
          `preserved commit off \`${branch}\` first, since no child delivers it and a resumed ` +
          `multi-ticket run refuses to start while it could ride into their pull request`
        : // Same instruction, held to what anton actually knows: an unreadable history cannot rule
          // a preserved commit out, and a split that leaves one behind hits the same refusal.
          unknown.length > 0
          ? `, or split ${targetId} into child tickets that each fit the budget — checking ` +
            `\`${branch}\` for a preserved commit first and taking any off, since no child ` +
            `delivers one and a resumed multi-ticket run refuses to start while it could ride ` +
            `into their pull request`
          : `, or split ${targetId} into child tickets that each fit the budget`;
    return (
      `${targetId} ran out of time (its ${budget} ticket budget) and nothing was delivered — it ` +
      `IS this run's whole target, so there is no sibling ticket to re-scope the work into. ` +
      `${fate} Raise this project's ticketTimeoutMinutes${split}, then resume the run`
    );
  }
  return (
    `every ticket under ${targetId} ran out of time ` +
    `(${timedOut.map((t) => t.id).join(", ")})` +
    (skippedIds.length > 0 ? ` or was skipped behind one that did (${skippedIds.join(", ")})` : "") +
    ` — nothing was delivered. ${fate} Re-scope them into smaller tickets, or raise this ` +
    `project's ticketTimeoutMinutes, then resume the run`
  );
}
