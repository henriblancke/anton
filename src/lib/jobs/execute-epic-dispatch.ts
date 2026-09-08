/**
 * The ticket phase of a run (anton-1lix — extracted from execute-epic.ts): which of the target's
 * tickets this attempt dispatches, in what order, and what it does about the ones it cannot.
 *
 * Three sets come out of it and every one of them is load-bearing downstream: what was DELIVERED
 * (the PR body and the review contract speak for exactly that), what was HELD (a blocker outside
 * this run — the tail parks), and what was SKIPPED behind a rolled-back timeout (merge finalization
 * reads its marker, not this module's memory). A fourth — what anton RETIRED as already shipped
 * (anton-5bpd) — is recorded on the run rather than here: the ticket is settled on the board, so
 * nothing downstream has to decide anything about it beyond saying it is not in the PR.
 */
import { beads, LABELS, type Bead } from "../beads/bd";
import { claimGuard } from "../beads/claim";
import { withBeadWriteLock } from "../beads/claim-lock";
import { contractGaps, formatContractGaps } from "../beads/contract";
import { appendSessionLog } from "../sessions";
import { resumeSkipped } from "../ticket-view";
import { resolveForkPoint, worktreeHasCommitFor } from "../git/ops";
import { blockedTailReason, PoisonEpic } from "./errors";
import {
  deliveredTickets,
  inactiveAgentTickets,
  openHumanGateAsks,
  orderTickets,
  reorderForPrereq,
  reorderNote,
  skipNote,
  skippedDependents,
  type PrereqEdge,
  type RetiredTicketOutcome,
  type SkipCause,
  type TicketTimeoutOutcome,
} from "./execute-epic-board";
import {
  BlockedTailError,
  PrereqCycleError,
  ReorderedOnPrereqError,
  TicketRetiredError,
  TicketTimeoutError,
} from "./execute-epic-errors";
import { mustPersist, mustRead, safe } from "./execute-epic-persist";
import type { RunPreparation } from "./execute-epic-prepare";
import type { EpicRun } from "./execute-epic-run";
import { runTicket } from "./execute-epic-ticket";
import type { SatisfiedSettlement } from "./step-registry";

/** What the ticket phase leaves for the run phase to speak for. */
export interface DispatchOutcome {
  /** The tickets whose work is actually on the branch — the PR body and review contract's set. */
  delivered: Bead[];
  /**
   * The subset of {@link delivered} that settled on an EARLIER commit of this run rather than one of
   * its own (anton-8h4b), and the commit each was settled against. The PR body attributes these to
   * that commit instead of listing them as deliveries. A ledger of THIS attempt only, and that is
   * enough: a satisfied ticket has no commit under its own name, so a resume never skips it as
   * done-on-branch — it re-runs and settles again here.
   */
  satisfied: Map<string, SatisfiedSettlement>;
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
   *
   * A ticket anton RETIRED as already shipped (anton-5bpd) counts too, for that same reason read one
   * step out: its work is in the run's BASE rather than in a commit on this branch, so the tickets
   * written against it have their mechanism just as surely.
   */
  onBranch: Set<string>;
  /** Tickets that settled on an earlier commit of the run — see {@link DispatchOutcome.satisfied}. */
  satisfied: Map<string, SatisfiedSettlement>;
}

/** Dispatch every ticket this run may run, then answer what it delivered. */
export async function dispatchRunTickets(
  run: EpicRun,
  prep: Extract<RunPreparation, { done: false }>,
): Promise<DispatchOutcome> {
  // Read against the run's DELTA, not the branch's whole history (PR #238 review): the question is
  // whether THIS run committed the ticket — what its pull request will carry — and a scan that walks
  // into the base finds a commit an earlier merge landed under the same id, keeping a ticket the
  // board has since settled out of the retirement ledger and in the delivered set of a PR that
  // carries nothing of it.
  //
  // And read STRICTLY (PR #238 review): "no commit here" is what drops a superseded ticket from the
  // run, so a scan that failed — the base ref gone, git itself broken — must stop the run rather
  // than read as absence. Taken for absence, a ticket whose commit IS in this delta leaves the
  // delivered set and the PR body while its diff ships, or an all-retired run parks without opening
  // the pull request that carries it.
  // Pin the fork COMMIT before partitioning, never the mutable ref the run recorded (PR #238 review).
  // `prep.runStep.baseRef` is `origin/<base>` — a ref a sibling run's fetch can advance or rewind
  // mid-run — and the read below is `<base>..HEAD`: measured against the moving ref, a base rewound
  // behind the fork point widens the window into pre-fork history, where an old `<ticketId>:` commit
  // reads as this run's delivery and keeps a superseded ticket live for a PR that carries nothing of
  // it. The merge-base commit is immutable once resolved, so every ticket is partitioned against the
  // same fork the checkout was actually cut from — as the already-shipped verifier does. The STRICT
  // resolver: a base rewritten to an unrelated history has no fork point, and reading the branch tip
  // instead would count work only that history holds; a fork point git cannot compute stops the run.
  let forkPoint: string;
  try {
    forkPoint = await resolveForkPoint(prep.worktree.path, prep.runStep.baseRef);
  } catch (e) {
    throw new PoisonEpic(
      `anton could not resolve the commit \`${prep.worktree.branch}\` forked from ` +
        `${prep.runStep.baseRef} in ${prep.worktree.path} ` +
        `(${e instanceof Error ? e.message : String(e)}) — refusing to partition the run's tickets ` +
        `against a moving base, which could read work this checkout never forked from as its own ` +
        `delivery. Repair the worktree, then resume the run`,
    );
  }
  const { live, held, dispatchable } = await partitionTickets(run, prep.gated, async (id) => {
    try {
      return await worktreeHasCommitFor(prep.worktree.path, id, { base: forkPoint, strict: true });
    } catch (e) {
      throw new PoisonEpic(
        `${id} is superseded on the board, and anton could not read the commits ` +
          `\`${prep.worktree.branch}\` carries beyond ${prep.runStep.baseRef} in ${prep.worktree.path} ` +
          `to tell whether this branch holds its work (${e instanceof Error ? e.message : String(e)}). ` +
          `Refusing to retire it on an unreadable branch — if its commit IS here, the pull request ` +
          `would ship it unlisted. Repair the worktree, then resume the run`,
      );
    }
  });
  const ledger: DispatchLedger = {
    skipCause: new Map(),
    skipped: new Map(),
    // Seeded with the retirements the board already held when the run read it (PR #238 review):
    // their work is in the run's base, so a timeout cascade stops at one exactly as it stops at a
    // ticket this attempt retires. Left out, a rolled-back timeout would walk THROUGH a settled
    // ticket and skip valid work behind it.
    onBranch: new Set(run.retired.map((r) => r.id)),
    satisfied: new Map(),
  };
  const recordSkipped = makeSkipRecorder(run, ledger);

  // A QUEUE rather than a `for…of`, because the run may re-order what it has left mid-flight
  // (anton-0gm2): a ticket that blocks on a prerequisite the run holds itself is a scheduling
  // correction, and the corrected order is what the rest of this loop dispatches.
  const queue = [...dispatchable];
  // Every ordering the run has drawn for itself so far, carried forward: each re-order must honour
  // the ones before it, or the second forgets the first and dispatches a ticket ahead of the
  // prerequisite anton already recorded for it.
  const drawn: PrereqEdge[] = [];
  while (queue.length > 0) {
    const ticket = queue.shift()!;
    try {
      await dispatchTicket(run, prep, ticket, dispatchable, ledger, recordSkipped);
    } catch (e) {
      if (!(e instanceof ReorderedOnPrereqError)) throw e;
      queue.splice(0, queue.length, ...(await reorderAroundPrereq(run, ticket, queue, e, drawn)));
    }
  }

  // A ticket its budget stopped BEFORE its commit step is not part of what this run delivered
  // (anton-t1mo) — whether its work was rolled back or preserved on the branch as an explicitly
  // incomplete commit (anton-d967), nobody finished it. Read by the tail's park and by the delivery
  // verdict below.
  const stoppedShort = stoppedShortIds(run.timedOut);
  await settleHeldTail(run, prep, { held, dispatchable, ledger, stoppedShort, recordSkipped });
  return {
    delivered: await deliveredOrPark(run, prep, live, ledger, stoppedShort),
    satisfied: ledger.satisfied,
    skipped: ledger.skipped,
  };
}

/**
 * The run correcting its OWN dispatch order (anton-0gm2) — the answer to a `dep-missing` block whose
 * prerequisite is one of this run's tickets.
 *
 * Nothing here is a failure and nothing is recorded as one: the ticket's bead is already back at
 * `open` and unassigned (the repair's `parked` outcome keeps it claimable), the run carries on, and
 * the consecutive-failure breaker never sees this case at all. What it costs is one dispatch — the
 * ticket runs again after its prerequisite, and the repair's own one-per-bead-per-class guard is
 * what stops a second block of the same class from re-ordering forever.
 *
 * A CYCLE stops the run instead. It is the one shape no order satisfies, and the fallback it would
 * otherwise land in — {@link orderTickets}'s input order — would dispatch the blocked ticket first
 * all over again.
 */
async function reorderAroundPrereq(
  run: EpicRun,
  ticket: Bead,
  remaining: Bead[],
  blocked: ReorderedOnPrereqError,
  /** The run's own orderings so far — read by this re-order, and extended by it. */
  drawn: PrereqEdge[],
): Promise<Bead[]> {
  const { repo, targetId: epicBeadId, all } = run;
  const { blockerId } = blocked;
  const reorder = reorderForPrereq({ ticket, remaining, blockerId, drawn, all });
  if (!reorder.ok) throw new PrereqCycleError(ticket.id, blockerId, reorder.cycle);
  drawn.push({ blockerId, ticketId: ticket.id });
  const account = reorderNote({ ticketId: ticket.id, blockerId, reorder });
  await appendSessionLog(blocked.logPath, `[reorder] ${account}\n`).catch(() => {});
  await safe(() => beads.note(repo, ticket.id, account));
  console.warn(`[execute-epic] ${epicBeadId}: ${account}`);
  return reorder.order;
}

/** How retired tickets read in an operator-facing park: each id, and the bead the board points it at. */
const retirements = (rs: readonly RetiredTicketOutcome[]) =>
  rs.map((r) => `${r.id} → superseded by ${r.replacedBy}`).join(", ");

/**
 * A run's retirements split the only way an operator-facing sentence may speak of them
 * (PR #238 review): `this-run` is a claim anton checked against git and the board itself,
 * `pre-existing` is one it merely FOUND on the board — a human's rescope, a gardener dedup, an
 * earlier attempt's retirement. Both read as "closed as superseded" on the bead, so only the
 * recorded source tells them apart, and wording a found supersede as shipped would ask the operator
 * to settle work on a verification nobody performed.
 */
const byProvenance = (rs: readonly RetiredTicketOutcome[]) => ({
  verified: rs.filter((r) => r.source === "this-run"),
  found: rs.filter((r) => r.source === "pre-existing"),
});

/**
 * The retirement ledger as a park may say it: one clause per provenance, each naming its tickets,
 * and only the `this-run` clause claiming a verification. Every park that mentions retirements
 * speaks through this so none of them can word a found supersede as one anton checked.
 */
function retirementClauses(rs: readonly RetiredTicketOutcome[]): string[] {
  const { verified, found } = byProvenance(rs);
  return [
    verified.length
      ? `already shipped, verified and closed as superseded (${retirements(verified)})`
      : null,
    found.length
      ? `already settled as superseded on the board, which this run did not verify ` +
        `(${retirements(found)})`
      : null,
  ].filter((clause): clause is string => clause !== null);
}

/** The run's tickets, split into what it may dispatch now and what a blocker outside it holds. */
async function partitionTickets(
  run: EpicRun,
  gated: Set<string>,
  /** Whether THIS branch carries a commit under the ticket's id — the branch's own evidence. */
  hasCommitFor: (ticketId: string) => Promise<boolean>,
): Promise<{ live: Bead[]; held: Bead[]; dispatchable: Bead[] }> {
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
  // A ticket the board records as SUPERSEDED is dropped in the same breath and for the same reason
  // (anton-5bpd): it too is closed with no commit under its own id on this branch, because the work
  // shipped under the survivor's. Every resume of a run that retired one — a usage-limit park, a
  // review-gate refusal, a held tail, a crash retry — would otherwise read it as a cross-machine
  // resume, reopen it, and dispatch an agent that can only report `already-shipped` again, into the
  // repair's own loop guard: the bead ends up open-then-blocked and the feature parks, the exact
  // false stall the retirement exists to end. The `supersedes` edge is the durable signal (the one
  // `bd supersede` writes beside the close), so a retirement an EARLIER attempt made reads the same
  // as one this attempt is about to. Recorded on the run's retired ledger rather than dropped
  // silently, so the pull request this attempt opens still says what it does not contain.
  //
  // UNLESS this branch carries a commit under the ticket's own id (PR #238 review). A child that
  // committed and closed on an earlier attempt, and was superseded by hand between that attempt's
  // failure and this resume, is closed with its work IN THIS DIFF: the branch is the evidence, and
  // "no commit under its own id" — the premise of dropping it — is false. Dropped here, it never
  // reaches the loop, so the delivered set and the pull request's body omit a commit the reviewer
  // will read, and the retirement notice claims the PR does not carry it. Kept live instead: the
  // loop's done-on-board check finds the commit, skips the ticket exactly as any closed child whose
  // work is already here, and counts it delivered.
  //
  // And only on a read taken NOW, under the ticket's write lock ({@link retireFound}): `tickets` is
  // the run's snapshot, and a supersede an operator has since reopened is live work again.
  const live: Bead[] = [];
  let abandoned = 0;
  for (const ticket of orderTickets(tickets, all)) {
    if (beads.isAbandoned(ticket)) {
      abandoned += 1;
      continue;
    }
    const retirement =
      beads.supersededBy(ticket) && !(await hasCommitFor(ticket.id))
        ? await retireFound(run, ticket)
        : undefined;
    if (retirement) run.retired.push(retirement);
    else live.push(ticket);
  }
  if (live.length === 0) {
    // Every ticket settled but the epic left open — a contradiction only a human can settle
    // (settle the epic too, or add work to it). Park rather than open an empty PR or mark the
    // run done, either of which would read as a delivery that never happened.
    // Said by PROVENANCE, never as one thing (PR #238 review): every retirement here is one the run
    // FOUND on the board — the dispatch loop has not run yet — so this run verified no delivery, and
    // "already shipped" would hand the operator a premise anton never checked when settling the epic.
    // And "abandoned" only when a ticket WAS (PR #238 review): an abandon is a recorded won't-do, a
    // different decision from a supersede, and naming one that never happened misreads the board.
    const outcomes = [...(abandoned > 0 ? ["been abandoned"] : []), ...retirementClauses(run.retired)];
    throw new PoisonEpic(
      (outcomes.length > 0
        ? `every ticket under ${epicBeadId} has ${outcomes.join(", or ")}`
        : `${epicBeadId} has no tickets`) +
        ` — nothing left to run; settle the epic itself or give it work, then resume the run`,
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
 * Retire a ticket the run's SNAPSHOT holds as superseded — or answer that it is live work after all
 * — on a read taken under the ticket's write lock (PR #238 review).
 *
 * The snapshot was taken at the board refresh, and an operator can reopen a superseded ticket
 * between that read and this partition: the reopen is a person saying the work is NOT done, and a
 * run that trusts the snapshot drops the ticket from dispatch anyway, on a supersede the board no
 * longer holds. So the retirement is decided on the bead as it reads now, and a bead no longer
 * closed as superseded stays live: it is dispatched like any other, or — closed with its commit
 * elsewhere — regenerated by the loop's cross-machine path. A board that cannot answer stops the
 * run rather than settle the ticket either way: retired on an unreadable bead, a reopen is silently
 * reversed; kept live, a retirement an earlier attempt verified is re-run.
 *
 * What it retires it MARKS ({@link markRetired}), under the same lock, so the merge that lands the
 * rest of the run can still tell the ticket apart if it is reopened after this read.
 *
 * The lock orders only THIS process's writers (beads/claim-lock), so the marker is fenced a second
 * time after it lands (PR #238 review), the way the repair fences its own supersede
 * (repair-already-shipped.ts `retirementHeld`): on a shared-server board another process can reopen
 * the ticket, re-home it and claim it between the read above and the tag, and a run that snapshotted
 * the reopened bead BEFORE the tag landed never sees the marker at its claim gate, so the marker
 * outlives that run's delivery and its merge reads the work as undelivered. Re-read once the tag is
 * on the board — the only read that can have seen such a writer — the bead is either still closed
 * as superseded AND still carrying the marker, and the retirement stands, or it has moved, and the
 * marker is WITHDRAWN before the ticket is handed back as live. A bead superseded on the reread but
 * with the marker stripped out from under it is the same race the other way, and stops the run: the
 * retirement is accepted only against a marker the reread proves is still on the board. What the
 * fence cannot close is a reopen that lands after this
 * second read: that one is seen by every snapshot taken after it, and the claim gate clears the
 * marker (execute-epic-ticket-bookends `claimTicket`); the cross-process rest is anton-od4.
 */
async function retireFound(run: EpicRun, ticket: Bead): Promise<RetiredTicketOutcome | undefined> {
  const { repo } = run;
  return withBeadWriteLock(repo, ticket.id, async () => {
    const live = await mustRead(repo, ticket.id);
    if (!live) {
      throw new PoisonEpic(
        `${ticket.id} is superseded on the board this run read, but bd would not read the ticket ` +
          `back, so anton cannot tell whether it still is — the run stopped rather than retire a ` +
          `ticket an operator may have reopened, or re-run one the board has settled. Check the ` +
          `beads DB, then resume the run`,
      );
    }
    if (!beads.supersededBy(live)) {
      // No longer superseded — reopened since the snapshot, so it is live work again. Normally that
      // hands it back to the loop to dispatch or regenerate against THIS run's target. But a reopen
      // on a shared-server board can also REHOME it onto another run's target between the snapshot
      // and this read, and returning undefined feeds the loop the stale snapshot `ticket`:
      // reopenForRegeneration sees an already-open bead and no-ops, and runTicket claims it by id and
      // runs work that now belongs to that other target. So the retirement stands down only when the
      // bead is still parented where this run left it; a bead rehomed since stops the run rather than
      // execute another target's ticket.
      if (beads.parentOf(live) !== beads.parentOf(ticket)) {
        throw new PoisonEpic(
          `${ticket.id} was superseded on the board this run read but has since been reopened and ` +
            `reparented onto ${beads.parentOf(live) ?? "another target"} — the run stopped rather ` +
            `than dispatch a ticket that now belongs to a different run target. Check the beads DB, ` +
            `then resume the run`,
        );
      }
      return undefined;
    }
    await markRetired(run, ticket.id);
    const marked = await mustRead(repo, ticket.id);
    if (!marked) {
      throw new PoisonEpic(
        `${ticket.id} is retired as already shipped and now carries \`${LABELS.notDelivered}\`, but ` +
          `bd would not read the ticket back, so anton cannot tell whether the marker landed on a ` +
          `ticket that is still superseded or on one another process has since reopened and claimed ` +
          `— the run stopped rather than open a pull request on either guess. Check the beads DB, ` +
          `then resume the run`,
      );
    }
    const replacedBy = beads.supersededBy(marked);
    if (replacedBy) {
      // The reread proves the bead is still superseded, but the retirement is only safe if THIS
      // run's marker is still on it: another process can strip `not-delivered` between markRetired
      // and this read, and a bead superseded-but-unmarked reads to merge finalization as work no
      // run reserved — reopened during review, the merge that carries none of it closes it as
      // shipped. So the marker is asserted, not just the supersede, and its absence stops the run
      // rather than open a PR whose merge would silently reverse that reopen.
      if (!beads.isNotDelivered(marked)) {
        throw new PoisonEpic(
          `${ticket.id} is superseded on the reread that fenced its retirement, but the ` +
            `\`${LABELS.notDelivered}\` marker anton just wrote is gone — another process cleared it ` +
            `between the tag and this read, so the merge that lands the rest of the run would read ` +
            `the ticket as work no run reserved and close it as shipped if it were reopened ` +
            `meanwhile. The run stopped rather than open a pull request on that race. Check the ` +
            `beads DB, then resume the run`,
        );
      }
      return { id: ticket.id, replacedBy, source: "pre-existing" };
    }
    await withdrawRetiredMarker(run, ticket.id);
    return undefined;
  });
}

/**
 * Take back a {@link markRetired} marker whose ticket moved between the read it was decided on and
 * the read after it landed: the bead is live work again, and a marker left on it would be read by
 * the merge of whichever run delivers it as work that run did not do. Guarded like the write it
 * undoes, and like the claim gate's own clear of the same marker: a run that cannot take it back
 * must not go on to open a pull request over it.
 */
async function withdrawRetiredMarker(run: EpicRun, ticketId: string): Promise<void> {
  if (!(await mustPersist(() => beads.untag(run.repo, ticketId, [LABELS.notDelivered])))) {
    throw new PoisonEpic(
      `${ticketId} was reopened while anton was retiring it as already shipped, and bd would not ` +
        `clear the \`${LABELS.notDelivered}\` marker that retirement left on it — the run stopped ` +
        `rather than leave live work marked as undelivered for the merge that will carry it. ` +
        `Check the beads DB, then resume the run`,
    );
  }
}

/**
 * Mark a retirement the run FOUND on the board as work this run does NOT deliver — the same
 * `not-delivered` marker a skipped ticket carries, for the same reader (PR #238 review). A
 * retirement this run makes itself is marked by the settlement that writes it, under the ticket's
 * lock and before its claim is released (repair-already-shipped.ts); this covers the ones an
 * earlier attempt, a person or the gardener settled. A retirement is a closed bead whose
 * work is in the run's BASE, not in its diff; reopened by an operator while the run's pull request
 * sits in review, it is an open child with nothing of its own in that PR, and merge finalization
 * only preserves what is `blocked` or marked — an unmarked reopen is closed as shipped by the very
 * merge that carries none of it, silently reversing the operator's decision. Marked, it is
 * preserved and rehomed for a rerun instead, and the marker is cleared the moment a run dispatches
 * it (see the ticket's claim bookend). While the bead stays closed the marker is inert: the merge
 * closes nothing that is already closed.
 *
 * Not best-effort, for the reason the skip path's marker is not: finalization has no other way to
 * see this, so a run that cannot record it must not go on to open the PR.
 */
async function markRetired(run: EpicRun, ticketId: string): Promise<void> {
  if (!(await mustPersist(() => beads.tag(run.repo, ticketId, [LABELS.notDelivered])))) {
    throw new PoisonEpic(
      `${ticketId} is retired as already shipped, but bd would not record \`${LABELS.notDelivered}\` ` +
        `on it — the run stopped rather than open a pull request whose merge would close this ` +
        `ticket as shipped if it were reopened meanwhile. Check the beads DB, then resume the run`,
    );
  }
}

/**
 * Reopen a closed child whose commit this branch lacks, decided on a read taken under the bead's
 * write lock (PR #238 review). The already-shipped repair retires a ticket against a SURVIVOR it
 * re-reads as closed under that survivor's lock, then supersedes; a resumed run whose old branch
 * lacks the survivor's now-landed commit reaches this reopen for that very bead. Unlocked, the
 * reopen could land between the repair's reread and its supersede, and the target would be retired
 * against a survivor that is live work again. Queued on the survivor's lock, the two can only order:
 * the reopen lands first and the repair's reread refuses it, or the supersede lands first and this
 * reopen follows a retirement that was checked against a closed bead.
 *
 * `ticket.status` came from the run's snapshot, so a bead somebody has reopened since is left
 * alone: a reopen on a bead that already reads open is a write for nothing. A read that comes back
 * abandoned or superseded STOPS the run instead (PR #238 review): those are still `closed`, so a
 * status-only check would treat the retirement as the old close and regenerate it, undoing an
 * abandon or a supersede that landed since. A bead bd will not read back stops it too, for the
 * same reason under uncertainty — the snapshot's `closed` says nothing about what the board holds
 * now, and anton cannot tell a plain close from a retirement it can no longer see. The reopen
 * itself stays best-effort, as before — runTicket's claim is what fails loudly on a bead still
 * closed.
 */
async function reopenForRegeneration(repo: string, ticket: Bead): Promise<void> {
  await withBeadWriteLock(repo, ticket.id, async () => {
    const live = await mustRead(repo, ticket.id);
    if (!live) {
      throw new PoisonEpic(
        `${ticket.id} is closed on the board this run read but its commit is on no branch here, ` +
          `and bd would not read the ticket back, so anton cannot tell whether it is still closed ` +
          `— the run stopped rather than reopen a ticket the board may since have abandoned or ` +
          `superseded. Check the beads DB, then resume the run`,
      );
    }
    if (live.status !== "closed") return;
    // A read that comes back abandoned or superseded is the !live branch's danger made visible
    // (PR #238 review): the snapshot's plain `closed` reached here as work to regenerate, but the
    // board has retired it SINCE. It is still `closed`, so the status check above lets it fall
    // through — and reopening it would undo the newer settlement and re-run work a person killed
    // or that shipped elsewhere. Stop; the resume re-snapshots and routes it through retirement
    // or the nothing-live park instead.
    const supersededBy = beads.supersededBy(live);
    if (beads.isAbandoned(live) || supersededBy) {
      throw new PoisonEpic(
        `${ticket.id} is closed on the board this run read and its commit is on no branch here, ` +
          `but a fresh read under its lock shows it was ${
            beads.isAbandoned(live) ? "abandoned" : `superseded by ${supersededBy}`
          } since — the run stopped rather than reopen it and regenerate work the board has ` +
          `retired. Check the beads DB, then resume the run`,
      );
    }
    await safe(() => beads.reopen(repo, ticket.id));
  });
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

/**
 * The tickets this run can still dispatch and LAND — what a `dep-missing` prerequisite is tested
 * against (`prereqSite`), and deliberately narrower than the run's whole ticket set (PR review).
 *
 * A prerequisite this run is HOLDING behind a blocker outside it, has SKIPPED behind a rolled-back
 * timeout, or was itself STOPPED SHORT when its own budget ran out, is one this attempt will never
 * land: the wait it names is genuine, so it must take the outside-park path, whose message the
 * run-health sweep reads the blocker id back out of. Calling it a sibling would re-order the run
 * around a ticket that cannot move, re-dispatch the blocked ticket into the identical failure, and
 * park on generic no-delivery poison instead. A stopped ticket whose partial work was PRESERVED on
 * the branch (anton-d967) is no different here: an explicitly incomplete commit is not the
 * mechanism the blocked ticket is waiting for.
 *
 * A prerequisite the loop has already PASSED stays in, because it landed: that ordering is satisfied,
 * and the blocked ticket has earned the one retry the re-order gives it. So does a timeout that
 * delivered before the deadline hit — its work is on the branch, finished.
 */
export function landableTicketIds(
  dispatchable: Bead[],
  ledger: DispatchLedger,
  /** Live, not a snapshot: the loop pushes to it as tickets run out of time. */
  timedOut: readonly TicketTimeoutOutcome[],
): string[] {
  const stoppedShort = stoppedShortIds(timedOut);
  return dispatchable
    .filter((t) => !ledger.skipCause.has(t.id) && !stoppedShort.has(t.id))
    .map((t) => t.id);
}

/**
 * The tickets whose deadline hit before their commit step — rolled back, or preserved on the branch
 * as an explicitly incomplete commit (anton-d967). Either way nobody finished them, so nothing of
 * theirs counts as landed.
 */
function stoppedShortIds(timedOut: readonly TicketTimeoutOutcome[]): Set<string> {
  return new Set(timedOut.filter((t) => !t.delivered).map((t) => t.id));
}

/** One ticket's turn: skip what is already here, hold what lost its mechanism, run the rest. */
async function dispatchTicket(
  run: EpicRun,
  prep: Extract<RunPreparation, { done: false }>,
  ticket: Bead,
  /** Every ticket this attempt may dispatch — membership, not order (the queue re-orders). */
  dispatchable: Bead[],
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
    await reopenForRegeneration(repo, ticket);
  }
  try {
    const settlement = await runTicket({
      run: runStep,
      steps: ticketSteps,
      ticket,
      runTicketIds: landableTicketIds(dispatchable, ledger, timedOut),
      operator,
      closeOnDone: !standaloneRun,
      standalone: standaloneRun,
      timeoutMs: ticketTimeoutMs,
    });
    // Its mechanism is on the branch either way — its own commit, or the earlier one it settled on
    // — so nothing behind it is missing anything. Which it was is what the PR body has to say.
    onBranch.add(ticket.id);
    // `closed` is what the bookend reports, not what the run's shape implies (PR #253 review): a
    // standalone target is never closed here, and a bd that refused the close left the bead open.
    if (settlement.how === "satisfied") {
      ledger.satisfied.set(ticket.id, { ...settlement.by, closed: settlement.closed });
    }
  } catch (e) {
    // A ticket anton RETIRED as already shipped is absorbed too (anton-5bpd). The repair verified
    // against git and the board that its work is already in the tree and closed the bead as
    // superseded by whatever landed it, so there is nothing left for this run — or any retry — to
    // do. Halting here would park the whole feature on a ticket that is finished, which is exactly
    // the false stall the class exists to end. Nothing cascades: the work it was waiting for is in
    // the run's BASE, so every ticket written against it still has its mechanism.
    //
    // Recorded, then the cancellation is asked (PR #238 review). The settlement lets a retirement
    // that landed before the job's kill stand — the abort cannot take a supersede back — and so it
    // does not rethrow on the kill the way every other stop does, which leaves THIS catch as the
    // one place the kill can be heard. `ctx.heartbeat()` does not read the signal (runner.ts only
    // renews the lease), so returning normally here would have the queue claim and tag the next
    // ticket under a job that is already cancelled. The retirement stays on the ledger — it is
    // done, and a resume finds it on the board either way — and the loop stops here.
    //
    // Nothing is written to the board here: the `not-delivered` marker a retirement owes merge
    // finalization is part of the settlement itself, written beside the supersede under the
    // ticket's lock and before its claim is released (PR #238 review) — a marker written from this
    // catch would land after the release, on a ticket another run may already have snapshotted.
    if (e instanceof TicketRetiredError) {
      run.retired.push({ id: e.ticketId, replacedBy: e.replacementId, source: "this-run" });
      onBranch.add(e.ticketId);
      console.warn(`[execute-epic] ${epicBeadId}: ${e.message}`);
      ctx.signal.throwIfAborted();
      await ctx.heartbeat();
      return;
    }
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
    // …and for a satisfied step, the bookkeeping it hit was the very record the ledger needs
    // (PR #253 review): the PR body would otherwise list it as a delivery of its own. The close
    // is what the deadline stopped — the bead is blocked, and the body must not say otherwise.
    if (e.satisfiedBy) ledger.satisfied.set(e.ticketId, { ...e.satisfiedBy, closed: false });
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
  //     A ticket RETIRED as already shipped (anton-5bpd) is out on the same rule: its work is in
  //     this run's BASE, under the survivor's id, so no commit here carries it. One retired on an
  //     EARLIER attempt never reached `live` at all (partitionTickets drops it — unless this branch
  //     carries its commit, in which case it is delivered like any other closed child whose work
  //     is here); this covers the one this attempt retired mid-loop, whose board snapshot still
  //     predates the supersede.
  const retired = new Set(run.retired.map((r) => r.id));
  const delivered = await deliveredTickets(
    live.filter((t) => !skipped.has(t.id) && !retired.has(t.id)),
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

  // Nothing timed out, and what is left to show was RETIRED rather than run (anton-5bpd): every
  // ticket anton could dispatch turned out to have already shipped, so each is closed as superseded
  // and no commit is on this branch. Carrying on would review nothing and hand `gh pr create` a
  // branch with no diff. Park instead, naming the retirements — the epic itself is the thing left to
  // settle, and only a person decides whether it is now empty or still wants work.
  //
  // EVERY live one, not merely one of them (PR #238 review): `run.retired.length > 0` is also true
  // of a run that retired one ticket and had a person finish another outside the branch, and this
  // message would then claim the whole feature had shipped while never naming the human ticket at
  // all. That mix belongs to the `agent:human` park below, which names both halves.
  //
  // And by PROVENANCE, like every other park that names the ledger (PR #238 review): the ledger
  // holds what partitionTickets FOUND already superseded on the board beside what this attempt
  // verified and retired itself, and "anton verified that" is only true of the second half.
  const notRetired = live.filter((t) => !retired.has(t.id));
  if (delivered.length === 0 && run.retired.length > 0 && notRetired.length === 0) {
    const { verified, found } = byProvenance(run.retired);
    throw new PoisonEpic(
      run.standaloneRun && found.length === 0
        ? `${epicBeadId} had ALREADY SHIPPED (${retirements(verified)}) — anton verified that ` +
          `against the repository and the board and closed it as superseded, with the evidence on ` +
          `the bead. Nothing was committed here, so there is no pull request to open and nothing ` +
          `is left to run; read the bead if you want to check what anton checked`
        : `every ticket under ${epicBeadId} that this run could dispatch was retired rather than ` +
          `run: ${retirementClauses(run.retired).join("; ")} — each is closed on the board, ` +
          `pointing at what it is superseded by, and nothing was committed here, so there is no ` +
          `pull request to open. Close ${epicBeadId} by hand to settle it, or give it work that ` +
          `has not landed yet and resume the run`,
    );
  }

  // Nothing timed out and still nothing is left to show: every live ticket anton could dispatch is
  // human work a person did outside this branch (anton-mv70) — the resume that closed the last
  // answered gate lands here with an empty set. The run phase speaks for a diff, so carrying on
  // would review nothing and hand `gh pr create` a branch with no commits between it and the base.
  // Park instead, naming the one thing left to do: this target ships no code, so a person settles
  // it. Any retirements are named alongside rather than folded in, so the operator sees which
  // tickets a person finished and which were already in the tree — and split by PROVENANCE for the
  // reason the retirement notice is (PR #238 review): a supersede this run only FOUND on the board
  // is somebody else's decision, so saying it "had already shipped" would put anton's verification
  // behind a delivery it never checked.
  if (delivered.length === 0) {
    const { verified, found } = byProvenance(run.retired);
    const alsoRetired = [
      verified.length
        ? `, and ${verified.length} more had already shipped, closed as superseded ` +
          `(${retirements(verified)})`
        : null,
      found.length
        ? `, and ${found.length} more were already settled as superseded on the board ` +
          `(${retirements(found)})`
        : null,
    ]
      .filter(Boolean)
      .join("");
    throw new PoisonEpic(
      `every ticket under ${epicBeadId} that is left to run is work a person does, not an agent ` +
        `(${notRetired.map((t) => t.id).join(", ")})${alsoRetired} — they are done and nothing ` +
        `was committed on this branch, so there is no pull request to open. Close ${epicBeadId} ` +
        `by hand to settle it, or give it a ticket an agent can deliver and resume the run`,
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
 *
 * A ticket the run RETIRED as already shipped (anton-5bpd) is named too, by provenance (PR #238
 * review): with one ticket timing out and another retired, nothing is delivered and this is the
 * park that fires — and "every ticket ran out of time … re-scope them" would tell the operator to
 * re-scope work the board has already settled, while never saying it was.
 */
export function outOfTimeParkMessage(run: EpicRun, skippedIds: string[]): string {
  const { targetId, timedOut, branch, standaloneRun, ticketTimeoutMs, retired } = run;
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
  const retiredClause =
    retired.length > 0
      ? ` — the rest were retired rather than run: ${retirementClauses(retired).join("; ")}`
      : "";
  return (
    `every ticket under ${targetId}${retired.length > 0 ? " left to run" : ""} ran out of time ` +
    `(${timedOut.map((t) => t.id).join(", ")})` +
    (skippedIds.length > 0 ? ` or was skipped behind one that did (${skippedIds.join(", ")})` : "") +
    `${retiredClause} — nothing was delivered. ${fate} Re-scope ` +
    `${retired.length > 0 ? "the ones that ran out of time" : "them"} into smaller tickets, or ` +
    `raise this project's ticketTimeoutMinutes, then resume the run`
  );
}
