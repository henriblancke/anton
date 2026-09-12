/**
 * What brackets ONE ticket's walk (anton-owlx — extracted from execute-epic-ticket.ts): the claim it
 * must hold before any work, the session and step context its steps run in, the wall clock they run
 * under, and the single board write its committed work earns.
 *
 * Everything here is bookkeeping the walk needs done but does not itself decide. What happens when a
 * ticket stops short is the settlement's (execute-epic-ticket-settle.ts).
 */
import { beads, labelValueOf, LABELS, ownerOf, unclaimableStatus, type Bead } from "../beads/bd";
import { withBeadWriteLock } from "../beads/claim-lock";
import { claudeRouting } from "../claude/driver-routing";
import { formatSatisfiedNote, shortSha } from "../beads/satisfied-note";
import type { SatisfiedBy } from "../beads/satisfied-note";
import {
  commitMarker,
  readWorktreeState,
  satisfiedMarkerSubject,
  type WorktreeState,
} from "../git/ops";
import { updateRun } from "../runs";
import { appendSessionLog, endSession, startJobSession, type JobSession } from "../sessions";
import { PoisonEpic } from "./errors";
import { errorText, sleepMs } from "../retry-helpers";
import { mustPersist, PERSIST_RETRY_MS, safe } from "./execute-epic-persist";
import type { TicketSettlement } from "./execute-epic-ticket-settle";
import type { JobContext } from "./runner";
import type { StepContext } from "./step-registry";

/** This ticket's own wall clock (anton-t1mo) — the deadline, and the abort the two of them share. */
export interface TicketBudget {
  /**
   * A DERIVED signal — the job's abort still propagates through it — so every child process a step
   * spawns dies on either. The job-level signal is left untouched: it means "the whole run is over",
   * and the failure paths read THAT one (not this) to tell an operator's kill from a long ticket.
   */
  signal: AbortSignal;
  /** Whether the DEADLINE fired, as opposed to the job's own abort. */
  ranOutOfTime(): boolean;
  /** Stop the clock and stop listening to the job's, so a long run accumulates neither per ticket. */
  stop(): void;
}

/**
 * Undo the claim before a gate parks the run: hand the status back to `open` and drop the assignee
 * and the stage label the claim wrote. The claim moved the ticket to `in_progress`, and the
 * epic-level cleanup hands the assignee back but NOT the status — leaving `in_progress` with no
 * owner, which `bd update --claim` refuses outright, so the resume the park tells the operator to
 * run would never get past its own claim gate. Best-effort throughout: this runs on the way to a
 * throw, and a write that also fails changes nothing the operator cannot fix by hand.
 */
async function unclaimAndPark(repo: string, ticketId: string): Promise<void> {
  await safe(() => beads.setStatus(repo, ticketId, "open"));
  await safe(() => beads.unassign(repo, ticketId));
  await safe(() => beads.untag(repo, ticketId, [LABELS.stage("implementing")]));
}

/**
 * Claim the ticket for the operator as a HARD GATE before doing any work, and clear any verdict a
 * previous run left on it.
 */
export async function claimTicket(
  run: Omit<StepContext, "tickets">,
  ticket: Bead,
  operator: string | undefined,
): Promise<void> {
  const repo = run.repoPath;
  // Claim the ticket for the operator as a HARD GATE before doing any work. On a shared board
  // the claim is the cross-operator coordination primitive (anton-live-sync R6): a failure here
  // means the ticket was already claimed by another operator (e.g. after a heartbeat pull) or the
  // local Dolt DB is locked. In either case we must NOT run Claude on a ticket this process does
  // not own — and must NOT fall through to the failure path below, which would clear the real
  // owner's claim. Claiming is idempotent for the same actor, so a resume re-claims cleanly. A
  // conflict aborts the run before any session/worktree work; the job retries and either skips the
  // now-closed ticket (already-closed check in the caller) or reclaims one whose owner released it.
  // What a refusal actually means — and whether any retry can change it — is classified by
  // {@link ticketClaimFailure}.
  try {
    await beads.claim(repo, ticket.id, operator);
  } catch (e) {
    throw ticketClaimFailure(ticket.id, operator, e);
  }
  // Announce the stage + nudge a sync so the claim reaches teammates within a heartbeat
  // (fire-and-forget; the end-of-run sync is the backstop).
  await safe(() => beads.tag(repo, ticket.id, [LABELS.stage("implementing")]));
  // A previous run marked this ticket as undelivered (timed out, or skipped behind one that did).
  // It is being run now, so that verdict is stale — and clearing it is as load-bearing as writing
  // it was (anton-67xj). The failure is the mirror image: a marker that survives its own successful
  // run makes merge finalization read delivered work as undelivered, hold this ticket out of the
  // close, and file a follow-up epic for work the merged diff already contains. So it is retried,
  // and a run that cannot clear it parks before it can open that PR.
  if (beads.isNotDelivered(ticket)) {
    if (!(await mustPersist(() => beads.untag(repo, ticket.id, [LABELS.notDelivered])))) {
      // Put the ticket back the way the claim above found it before halting. The claim already
      // moved it to `in_progress`, and the epic-level cleanup hands the assignee back but not the
      // status — leaving `in_progress` with no owner, which `bd update --claim` refuses outright.
      // The resume this park tells the operator to run would then never get past its claim gate.
      // Same restore the retryable-failure path performs, for the same reason.
      await unclaimAndPark(repo, ticket.id);
      throw new PoisonEpic(
        `${ticket.id} carries \`${LABELS.notDelivered}\` from a previous run but bd would not ` +
          `clear it — running this ticket and opening a pull request would make merge ` +
          `finalization treat delivered work as undelivered. Check the beads DB, then resume the run`,
      );
    }
  }
  // A ticket an earlier attempt RETIRED (`bd supersede`) and an operator then reopened to re-run
  // still carries the stale `supersedes` edge that close wrote — reopen leaves it (anton-5bpd,
  // PR #238 review). We are about to run the ticket, so that edge is a lie: left in place, this
  // run's honest close reads as superseded again ({@link beads.supersededBy}), and a cross-machine
  // resume between that close and its push drops the ticket as a pre-existing retirement
  // (execute-epic-dispatch `partitionTickets`) instead of regenerating its commit — the PR then
  // omits the rerun's work. So the edge is cleared here, on the authoritative read the claim just
  // earned; and — like the marker above — a run that cannot clear it parks before it can open that
  // PR. Only an edge that PREDATES the claim is cleared: the same read sees a retirement another
  // process landed in the window, and that one is settled work (see {@link retirementSettledSinceClaim}).
  const claimed = await beads.show(repo, ticket.id).catch(() => undefined);
  // The read is authoritative or nothing: a transient failure here tells us NOTHING about the
  // edge, and treating an unreadable bead as edge-free would run the ticket and let a surviving
  // `supersedes` reach the same close/resume that omits the rerun's work. So fail closed — park
  // and restore the claim exactly as the unlink-refusal path below does — rather than proceed on
  // an unverified read.
  if (!claimed) {
    await unclaimAndPark(repo, ticket.id);
    throw new PoisonEpic(
      `${ticket.id} could not be re-read after claiming, so a stale \`supersedes\` edge from a ` +
        `previous retirement cannot be ruled out — running this ticket and opening a pull request ` +
        `would risk its own honest close reading as superseded again, and a cross-machine resume ` +
        `dropping the rerun's work from the PR. Check the beads DB, then resume the run`,
    );
  }
  const survivor = beads.supersedesTarget(claimed);
  if (survivor) {
    // …but only an edge this run's own claim proves is STALE (PR #238 review). A supersede another
    // process wrote in the window between the claim above and this read is a valid retirement, and
    // removing it would run the ticket that hand just settled and record its close as an ordinary
    // delivery. What tells the two apart is the claim itself ({@link retirementSettledSinceClaim}).
    const settled = retirementSettledSinceClaim(claimed, operator);
    if (settled) {
      // RETRYABLE, not a park: the next attempt re-reads the board, and dispatch drops a ticket
      // closed as superseded with no commit under its own id exactly as it drops any retirement it
      // finds (execute-epic-dispatch `partitionTickets`) — recording it on the run's retired ledger
      // so the pull request says what it does not carry. Nothing is written here and the claim is
      // NOT handed back: the bead belongs to whoever settled it, and `unclaimAndPark` would reopen
      // a closed retirement.
      throw new Error(
        `refusing to execute ${ticket.id}: it was retired as superseded by ${survivor} after this ` +
          `run claimed it (${settled}) — retrying so the next attempt re-reads the board and drops ` +
          `the ticket as the settled retirement it is, rather than re-running work another hand ` +
          `has already closed`,
      );
    }
    if (!(await mustPersist(() => beads.unlink(repo, ticket.id, survivor)))) {
      await unclaimAndPark(repo, ticket.id);
      throw new PoisonEpic(
        `${ticket.id} carries a stale \`supersedes\` edge to ${survivor} from a previous ` +
          `retirement but bd would not remove it — running this ticket and opening a pull request ` +
          `would make its own honest close read as superseded again, and a cross-machine resume ` +
          `drop the rerun's work from the PR. Check the beads DB, then resume the run`,
      );
    }
    await assertUnlinkedOurStaleEdge(repo, ticket.id, survivor, operator);
  }
  void beads
    .sync(repo)
    .catch((e) => console.error(`[execute-epic] claim sync failed for ${ticket.id}`, e));
}

/**
 * The fence after the stale-edge unlink: prove the edge it removed was the STALE one the pre-unlink
 * read saw, and not a retirement another process landed in between (PR #238 review).
 *
 * The bead lock orders this process only. On a shared-server board another hand can `bd supersede`
 * the ticket against the SAME survivor between {@link retirementSettledSinceClaim}'s read and the
 * unlink — and because the survivor matches, the unlink strips the NEW retirement's edge rather than
 * the reopened one's. Nothing downstream can tell: `claimTicket` returns, the agent runs a ticket
 * that hand has already closed, and the run's own close records it as an ordinary delivery, losing
 * the survivor the other process recorded. `mustPersist`'s retries widen the same window — each
 * attempt is a fresh write against a board that may have moved since the last.
 *
 * So the same questions are asked once more with the unlink ON the board, exactly as the retirement
 * fences do (execute-epic-dispatch `retireFound`, gardener/repair-already-shipped.ts
 * `retirementHeld`): only a read taken after the write can have seen such a writer. The claim is
 * still what separates the two cases, so the check is `retirementSettledSinceClaim` again — a ticket
 * still `in_progress` under this run's own claim is one nothing has settled, and the edge that just
 * came off can only have been the stale one.
 *
 * A detected race PUTS THE EDGE BACK before it retries (PR #238 review). The unlink has already
 * happened, so the settlement this fence just found is on the board as a close with NO survivor —
 * and that is not a state the next attempt drops. Dispatch reads a closed ticket with no
 * `supersedes` edge and no commit under its own id on this branch as a cross-machine resume, reopens
 * it and re-runs work the other hand settled (execute-epic-dispatch `reopenForRegeneration`), which
 * is the very outcome the retry was supposed to avoid. So the edge the unlink removed is written
 * again — through `bd supersede`, the only door that writes that type, idempotent on a bead already
 * closed against the same survivor — restoring exactly the state the pre-unlink read observed.
 *
 * Only when the ticket reads CLOSED. That is the shape a retirement leaves, and it is the shape the
 * regeneration path misreads. A race that shows up as a MOVED CLAIM on a ticket still open or
 * in_progress is the other case: nothing was superseded, the edge this run removed was the stale one
 * it came for, and re-closing the bead as superseded would destroy a live claim another hand holds.
 * An ABANDONED bead needs no restore either — dispatch drops it as abandoned with or without the
 * edge.
 *
 * The restore re-proves the retirement on its OWN read before each write (PR #238 review): this
 * fence's `after` is history by then, and another hand can reopen or re-settle the ticket in
 * between — see {@link restoreRetirementEdge}.
 *
 * A restore anton cannot land PARKS instead of retrying, because the retry is the dangerous path:
 * the run cannot leave a settled retirement stripped of its survivor and then hand the next attempt a
 * ticket it will reopen and re-run. The claim is NOT handed back on either exit — the bead belongs
 * to whoever settled it, and `unclaimAndPark` would reopen a closed retirement.
 *
 * An unreadable bead fails closed for the reason the pre-unlink read does: "could not check" is not
 * "nothing landed", and proceeding would run the ticket on exactly the race this fence exists to
 * catch.
 */
async function assertUnlinkedOurStaleEdge(
  repo: string,
  ticketId: string,
  survivor: string,
  operator: string | undefined,
): Promise<void> {
  const after = await beads.show(repo, ticketId).catch(() => undefined);
  if (!after) {
    throw new Error(
      `refusing to execute ${ticketId}: anton removed the \`supersedes\` edge to ${survivor} that ` +
        `a previous retirement left on it, but bd would not read the ticket back, so anton cannot ` +
        `tell whether the edge it removed was that stale one or a retirement another process wrote ` +
        `while it was removing it — retrying so the next attempt decides on a board it can read`,
    );
  }
  const settled = retirementSettledSinceClaim(after, operator);
  if (settled) {
    await restoreRetirementEdge(repo, ticketId, survivor, after.closed_at);
    throw new Error(
      `refusing to execute ${ticketId}: it was retired as superseded by ${survivor} while anton ` +
        `was removing the stale \`supersedes\` edge a previous retirement left on it (${settled}) — ` +
        `the edge anton removed was that new retirement's, so retrying lets the next attempt ` +
        `re-read the board and drop the ticket as the settled retirement it is, rather than ` +
        `running work another hand has already closed`,
    );
  }
}

/**
 * Write back the `supersedes` edge {@link claimTicket}'s unlink removed from a retirement another
 * process landed in the window — see {@link assertUnlinkedOurStaleEdge} for why the retry needs it
 * there and why only a CLOSED ticket gets it.
 *
 * `bd supersede` is the only seam that writes the type (beads/link-types.ts refuses it through
 * `link`), and it is idempotent against the same survivor on an already-closed bead: it re-draws the
 * edge and leaves the close standing.
 *
 * Every attempt re-reads the ticket and re-proves the retirement immediately before it writes
 * (PR #238 review). The fence's own read is already history by the time the restore runs, and on a
 * shared-server board the same hands that raced the unlink can reopen, reclaim, abandon or
 * re-supersede the ticket again in between — a retry loop widens that window rather than narrowing
 * it. Written unconditionally off the stale read, the restore would close a bead a reopen had just
 * made live again and stamp the old survivor over a newer decision: the exact overwrite this whole
 * path exists to prevent, in the other direction. So the precondition is asked of a read taken
 * inside the same attempt as the write, under the ticket's write lock so no writer in THIS process
 * can land between the two, and anything the read no longer recognises as the retirement anton
 * unlinked is left alone.
 */
async function restoreRetirementEdge(
  repo: string,
  ticketId: string,
  survivor: string,
  closedAt: string | undefined,
): Promise<void> {
  const failure = await withBeadWriteLock(repo, ticketId, () =>
    persistRetirementEdge(repo, ticketId, survivor, closedAt),
  );
  if (!failure) return;
  throw new PoisonEpic(
    `${ticketId} was retired as superseded by ${survivor} while anton was removing the stale ` +
      `\`supersedes\` edge a previous retirement left on it, and anton could not write that ` +
      `retirement's edge back (${failure}) — the ticket is now closed with no survivor recorded, ` +
      `which the next attempt would read as a cross-machine resume and re-run. The run stopped ` +
      `rather than regenerate work another hand has already settled. Re-run ` +
      `\`bd supersede ${ticketId} --with ${survivor}\`, then resume the run`,
  );
}

/** How many read-then-write attempts {@link restoreRetirementEdge} gets — `mustPersist`'s budget. */
const RESTORE_ATTEMPTS = 3;

/**
 * One read-and-conditionally-write pass per attempt, answering why the edge is still off the board
 * — or `undefined` once it is back, or once the ticket is no longer one this restore may touch.
 *
 * The read is what makes the write conditional, so it is taken fresh on every attempt rather than
 * hoisted: a retry decided on the first attempt's read is the unconditional write again, just later.
 */
async function persistRetirementEdge(
  repo: string,
  ticketId: string,
  survivor: string,
  closedAt: string | undefined,
): Promise<string | undefined> {
  let why = "bd would not read the ticket back";
  for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleepMs(PERSIST_RETRY_MS);
    const fresh = await beads.show(repo, ticketId).catch((e: unknown) => {
      console.error(`[execute-epic] bd read failed (attempt ${attempt}/${RESTORE_ATTEMPTS}):`, e);
      why = `bd would not read the ticket back: ${errorText(e)}`;
      return undefined;
    });
    if (!fresh) continue;
    if (!restorableRetirement(fresh, closedAt)) return undefined;
    try {
      await beads.supersede(repo, ticketId, survivor);
      return undefined;
    } catch (e) {
      console.error(`[execute-epic] bd write failed (attempt ${attempt}/${RESTORE_ATTEMPTS}):`, e);
      why = `bd refused the write: ${errorText(e)}`;
    }
  }
  return why;
}

/**
 * Whether this read is still the retirement {@link restoreRetirementEdge} unlinked, and therefore
 * one anton may re-draw the edge on.
 *
 * CLOSED and not abandoned is the shape {@link assertUnlinkedOurStaleEdge} explains: a bead back at
 * `open` or `in_progress` is a live claim the supersede would destroy, and an abandoned one is a
 * person's recorded won't-do that dispatch drops with or without the edge. The SURVIVOR half is what
 * the fresh read adds: an edge already naming this survivor means another hand restored it and the
 * write has nothing to add, and one naming a DIFFERENT survivor is a newer retirement decision that
 * re-superseding would overwrite. Either way the run still retries — the ticket is settled, which is
 * all the caller's error claims.
 */
function restorableRetirement(fresh: Bead, closedAt: string | undefined): boolean {
  if (fresh.status !== "closed" || beads.isAbandoned(fresh)) return false;
  // A close is not a durable identity: an intervening reopen followed by an ordinary close has the
  // same status and no edge, but belongs to another decision. Only redraw the edge on the precise
  // closure the post-unlink fence observed; otherwise leave the newer close untouched.
  return Boolean(closedAt) && fresh.closed_at === closedAt && beads.supersedesTarget(fresh) === undefined;
}

/**
 * Why the `supersedes` edge on the post-claim read is a retirement that landed AFTER this run took
 * the ticket — or undefined while it is the stale pointer a reopened retirement kept (PR #238
 * review).
 *
 * `bd reopen` returns a retired bead to `open` and leaves its `supersedes` edge behind, which is
 * the edge {@link claimTicket} exists to clear. But the read that finds it is taken after the claim,
 * so it also sees a supersede another process wrote in between — and that one is VALID: the ticket
 * is settled, and clearing the edge would run it anyway and record its close as ordinary delivery.
 *
 * The claim is what separates them, because `bd supersede` closes the bead as it writes the edge. A
 * ticket still `in_progress` under this run's own assignee is one nothing has settled since the
 * claim, so its edge can only predate it. Any other reading — closed, returned to `open`, blocked,
 * deferred, or held by another name — is a board decision made after the claim, and the edge goes
 * with it. The ASSIGNEE half is asked only when the run resolved an operator identity: without one
 * bd claims under its own actor resolution, and there is no name to hold the read to.
 */
export function retirementSettledSinceClaim(
  claimed: Bead,
  operator: string | undefined,
): string | undefined {
  if (claimed.status !== "in_progress") {
    return `the ticket reads ${claimed.status} now, not the in_progress this run's claim left it`;
  }
  const holder = ownerOf(claimed);
  if (operator && holder !== operator) {
    return `the ticket is ${holder ? `claimed by \`${holder}\`` : "unclaimed"} now, not held for \`${operator}\` as this run's claim left it`;
  }
  return undefined;
}

/** The statuses bd refuses a claim on that a LATER attempt can still find changed — see below. */
const RACED_CLAIM_STATUSES: ReadonlySet<string> = new Set(["in_progress", "closed"]);

/**
 * Why the ticket claim gate refused, as the error the caller throws (anton-fude) — the same split
 * `claimRunTarget` makes for the run target (execute-epic-claim.ts), one tier down.
 *
 * A STATUS bd will never accept (`issue not claimable: status blocked`) is a decision written to the
 * board, so the identical call repeats the identical error: poison, naming the status and the move
 * that clears it. Reporting it as the foreign-claim / locked-DB case sent the operator to debug
 * beads over a ticket anton itself had blocked for human review. Everything else keeps its retry —
 * an operator's live claim and a wedged Dolt DB are both states a later attempt can find changed.
 *
 * Two statuses are refusals bd words the same way but that are NOT decisions (PR #227 review), so
 * they keep the retry:
 *   • `in_progress` — bd says `not claimable: status in_progress` when the bead is held by SOMEBODY
 *     ELSE, and that clears the moment they finish: the same ownership conflict as `already claimed
 *     by`, which the retryable branch below is written for. Poisoning it would park a whole run
 *     permanently over a sibling run's live claim. (Our own claim never lands here at all —
 *     re-claiming as the same actor succeeds.)
 *   • `closed` — the run's board snapshot is stale, not held: another actor closed the ticket after
 *     the snapshot and before this claim. A retry re-reads the board and the loop's own
 *     closed-ticket handling takes it from there (execute-epic-dispatch `dispatchTicket`), skipping
 *     a commit already on the branch or reopening the bead to regenerate work this branch lacks.
 *     Parking would demand a person reopen a ticket anton reopens by itself.
 */
export function ticketClaimFailure(
  ticketId: string,
  operator: string | undefined,
  e: unknown,
): Error {
  const cause = e instanceof Error ? e.message : String(e);
  const status = unclaimableStatus(e);
  if (status && !RACED_CLAIM_STATUSES.has(status)) {
    return new PoisonEpic(
      `refusing to execute ${ticketId}: bd will not claim it while its status is "${status}", and ` +
        `no retry can change that — the run must not dispatch an agent on a ticket it does not own. ` +
        `Move ${ticketId} back to a claimable status (\`bd update ${ticketId} --status open\`) or ` +
        `abandon it, then resume the run. (${cause})`,
    );
  }
  // A ticket CLOSED under the run's snapshot gets its own words — blaming a rival operator or a
  // locked DB for a ticket somebody simply finished is the same misdirection as the park above.
  // `in_progress` keeps the ownership wording below, which is exactly what bd means by it.
  if (status === "closed") {
    return new Error(
      `refusing to execute ${ticketId}: it was closed after this run read the board — retrying so ` +
        `the next attempt re-reads it and either skips the ticket or reopens it to regenerate the ` +
        `work this branch is missing (${cause})`,
    );
  }
  return new Error(
    `refusing to execute ${ticketId}: could not claim it for ${operator ?? "this operator"} ` +
      `— already claimed by another operator, or the beads DB is locked (${cause})`,
  );
}

/** Open this ticket's session and make it the job's live handle. */
export async function openTicketSession(
  run: Omit<StepContext, "tickets">,
  ticket: Bead,
): Promise<JobSession> {
  const { db, clock, ctx, projectId, runId, worktreePath, settings } = run;
  const agentTag = labelValueOf(ticket.labels, "agent");
  const session = await startJobSession(db, clock, {
    projectId,
    runId,
    kind: "execute",
    beadId: ticket.id,
  });
  const { sessionId } = session;
  await updateRun(db, clock, runId, { ticketBeadId: ticket.id, agentTag: agentTag ?? null });
  // Live handle (anton-susu): expose this ticket's session + worktree while it runs; each ticket's
  // dispatch overwrites the last, so the handle always names the job's CURRENT session. The run's
  // captured routing rides along (anton-7poz) so an investigate terminal opened against this job hits
  // the SAME endpoint the run drives — from its pinned snapshot, not settings that drifted since.
  ctx.report({ sessionId, cwd: worktreePath, routing: claudeRouting(settings) });
  return session;
}

/**
 * Snapshot the tree BEFORE any step runs, so the timeout path can put back exactly what this ticket
 * found. Everything committed at this point belongs to earlier tickets; the delta a timeout leaves
 * behind is this ticket's alone — which is what makes rolling it back safe, and what stops
 * half-finished work from being swept into the NEXT ticket's commit.
 *
 * Read unconditionally, because two steps of the ticket need it and only one of them is the timeout:
 * `step:commit` compares HEAD against this baseline to tell an agent that changed nothing from one
 * that committed its own work (anton-8t1f), and that question is asked on every ticket, not just the
 * ones running under a deadline.
 *
 * Best-effort either way: an unreadable baseline costs the rollback, not the timeout — the ticket is
 * still stopped and blocked, and the run reports that its partial work had to be left in place.
 * `step:commit` likewise falls back to reading the index alone.
 */
export function readTicketBaseline(worktreePath: string): Promise<WorktreeState | null> {
  return readWorktreeState(worktreePath).catch(() => null);
}

/**
 * How much of a ticket's budget is spent before the run says so (anton-d967). Late enough that a
 * healthy ticket never trips it, early enough that an operator watching still has a fifth of the
 * clock to raise the budget or stop the run themselves.
 */
const BUDGET_WARNING_FRACTION = 0.8;

/**
 * Arm this ticket's deadline, derived from the job's own signal — and the warning that precedes it.
 *
 * `onWarning` fires once at {@link BUDGET_WARNING_FRACTION} of the budget, while the ticket is still
 * running: the deadline itself arrives as a kill and leaves no notice of its own, so this is the
 * only account of the clock running down. Never armed for an unbounded budget, which has no
 * fraction to be at.
 */
export function startTicketBudget(
  ctx: Pick<JobContext, "signal">,
  timeoutMs: number,
  onWarning?: (remainingMs: number) => void,
): TicketBudget {
  // This ticket's wall clock (anton-t1mo). A DERIVED signal — the job's abort still propagates
  // through it — so every child process a step spawns dies on either. The job-level signal is left
  // untouched: it means "the whole run is over", and the failure paths read it (not this one) to tell
  // an operator's kill from a ticket that merely ran long.
  const ticketAbort = new AbortController();
  const abortTicket = () => ticketAbort.abort();
  ctx.signal.addEventListener("abort", abortTicket, { once: true });
  if (ctx.signal.aborted) ticketAbort.abort();
  let ranOutOfTime = false;
  const bounded = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const deadline = bounded
    ? setTimeout(() => {
        ranOutOfTime = true;
        ticketAbort.abort();
      }, timeoutMs)
    : null;
  if (deadline && typeof deadline.unref === "function") deadline.unref();
  const warnAt = timeoutMs * BUDGET_WARNING_FRACTION;
  const warning = bounded && onWarning ? setTimeout(() => onWarning(timeoutMs - warnAt), warnAt) : null;
  if (warning && typeof warning.unref === "function") warning.unref();
  return {
    signal: ticketAbort.signal,
    ranOutOfTime: () => ranOutOfTime,
    stop: () => {
      if (deadline) clearTimeout(deadline);
      if (warning) clearTimeout(warning);
      ctx.signal.removeEventListener("abort", abortTicket);
    },
  };
}

/**
 * The OPERATOR-facing record that precedes the deadline (anton-d967). It goes to the session log an
 * operator tails and to the run's own record; the running agent cannot read either — the driver
 * delivers its prompt on stdin and closes it (`writePrompt`), so there is no channel back into a
 * live session and this is no instruction to it. What actually saves finished work is the timeout's
 * own preserve, after the deadline. This is what lets a person see the clock running down in time to
 * raise the budget or stop the run, instead of meeting the kill in the log.
 */
export function warnBudgetRunningOut(
  logPath: string,
  ticket: Bead,
  timeoutMs: number,
  remainingMs: number,
): void {
  const line =
    `${ticket.id} has used ${Math.round(BUDGET_WARNING_FRACTION * 100)}% of its ` +
    `${humanDuration(timeoutMs)} budget — about ${humanDuration(remainingMs)} left. ` +
    `Work still uncommitted when the deadline lands is kept only if this project's verify gates ` +
    `pass on it, and only when this ticket IS the whole run target.`;
  console.warn(`[execute-epic] ${line}`);
  void appendSessionLog(logPath, `[ticket-budget] ${line}\n`).catch(() => {});
}

/** A duration an operator reads at a glance — minutes once there is a minute to speak of. */
function humanDuration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;
}

/**
 * This ticket's step context: the run's, narrowed to this ticket. The session is opened by the
 * caller and handed in, so one session still covers the whole ticket — dispatch, gates and commit.
 * The claude driver is built per step by the walk, so a resumed session is told which step it is
 * continuing.
 */
export function narrowToTicket(
  run: Omit<StepContext, "tickets">,
  ticket: Bead,
  session: JobSession,
  budget: TicketBudget,
  baseline: WorktreeState | null,
): StepContext {
  return {
    ...run,
    ctx: { ...run.ctx, signal: budget.signal },
    tickets: [ticket],
    session,
    ...(baseline ? { ticketStartHead: baseline.head } : {}),
  };
}

/**
 * Persist this ticket's "code done" state the moment it commits — or, for a SATISFIED step, the
 * moment the gate accepted the earlier commit that did its work.
 *
 * Answers whether the bead actually CLOSED (PR #253 review): the close is best-effort, so a bd that
 * refuses the write leaves the ticket open, and the run's ledger has to carry that fact rather than
 * infer a close from the run's shape. A standalone target is never closed here, so it answers false.
 */
export async function finishTicket(
  run: Omit<StepContext, "tickets">,
  ticket: Bead,
  sessionId: string,
  closeOnDone: boolean,
  settlement: TicketSettlement = { how: "committed" },
): Promise<{ closed: boolean }> {
  const { db, clock } = run;
  const repo = run.repoPath;
  // A satisfied step closes exactly as a committed one does, so the bead has to say which it was
  // (anton-8h4b): without the record, a reader later sees a closed ticket with no commit under its
  // name on the branch and cannot tell "an earlier commit covered it" from "the close was a lie".
  // Written before the close, and the close WAITS on it (PR #253 review): the run's ledger is the
  // only other copy, and a later park loses it before any pull request cites it. A note bd refuses
  // therefore refuses the close too — the bead is left open for the resume to settle again, and the
  // run halts on the same "check the beads DB" park every unrecordable board fact takes.
  if (settlement.how === "satisfied") {
    const recorded = await mustPersist(() =>
      beads.note(
        repo,
        ticket.id,
        formatSatisfiedNote({ by: settlement.by, sessionId, branch: run.branch }),
      ),
    );
    if (!recorded) {
      throw new PoisonEpic(
        `${ticket.id} is satisfied by an earlier commit of this run ` +
          `(${shortSha(settlement.by.commit)}), but bd would not record that on the bead — closing ` +
          `it anyway would leave a closed ticket with no commit under its name and no account of ` +
          `why, so it was left open instead. Check the beads DB, then resume the run`,
      );
    }
    // …and the BRANCH has to speak for it too, before the board says it is done (PR #258 review).
    // The note above is what a reader of the bead needs; only this trailer is what a RESUME reads.
    // Without it, a run that closes this ticket and then parks before its pull request opens hands
    // the next attempt a ticket closed on the board and claimed by nothing on the branch — the
    // cross-machine shape — so it reopens the bead and dispatches an agent into the identical zero
    // diff this whole mechanism exists to prevent.
    //
    // After the note and before the close, so every failure converges rather than stranding the
    // ticket: a trailer anton could not write leaves the bead open, and the resume re-dispatches,
    // re-verifies the same claim and writes it then. Recorded once the gate has accepted the claim,
    // never on the agent's word alone — this is the same settlement the note cites.
    await recordSatisfiedOnBranch(run, ticket, settlement.by);
  }
  // Persist this ticket's "code done" state the moment it commits. An epic child closes (stage
  // → done). A standalone target isn't closed until its PR merges, so instead move it to
  // stage:in-review here (dropping implementing): that is both its board state and the persisted
  // resume marker, so a retry after a failed PR step skips it rather than re-running claude on
  // committed work. endSession still records the work done either way.
  let closed = false;
  if (closeOnDone) {
    closed = await safe(() => beads.close(repo, ticket.id));
  } else {
    await safe(() => beads.tag(repo, ticket.id, [LABELS.stage("in-review")]));
    await safe(() => beads.untag(repo, ticket.id, [LABELS.stage("implementing")]));
  }
  await endSession(db, clock, sessionId, "done");
  return { closed };
}

/**
 * Record on the BRANCH that `ticket` was satisfied by `by.commit` — an empty marker carrying the
 * `Anton-Satisfies` trailer the resume's skip rule reads (anton-ag76).
 *
 * The subject deliberately does NOT lead with a ticket id: `<id>:` is this project's delivery
 * attribution and `WIP <id>:` its preserved-and-incomplete one, both matched by prefix, and this
 * ticket delivered no commit of its own — claiming either would present it as a delivery in the pull
 * request body and lose the very distinction anton-8h4b drew. The trailer is invisible to both
 * matchers by construction, so it is the only place this attribution can live.
 *
 * A git failure here HALTS rather than degrading to a silent close: the alternative is a closed
 * ticket the next resume cannot account for, which is the false success every other gate here
 * refuses. The park is mechanical — a person clears whatever git refused and resumes.
 */
async function recordSatisfiedOnBranch(
  run: Omit<StepContext, "tickets">,
  ticket: Bead,
  by: SatisfiedBy,
): Promise<void> {
  const cited = by.subject ? `${shortSha(by.commit)} "${by.subject}"` : shortSha(by.commit);
  try {
    await commitMarker(
      run.worktreePath,
      // The satisfying commit is named in the SUBJECT by full sha, so a reviewer meeting this marker
      // in the pull request body reads which commit did the work without a second lookup — and so
      // the NEXT satisfied ticket, whose agent names this marker (it is the tip), is recorded
      // against the work rather than against this marker (see `satisfiedMarkerTarget`).
      `${satisfiedMarkerSubject(ticket.id, by.commit)}\n\n` +
        `${cited} already met this ticket's acceptance, so the ticket produced no commit of its ` +
        `own. This empty commit records the attribution no subject on this branch carries — it is ` +
        `what a later attempt reads to see the ticket as delivered instead of dispatching it into ` +
        `a zero diff.`,
      { satisfies: [ticket.id] },
    );
  } catch (e) {
    throw new PoisonEpic(
      `${ticket.id} is satisfied by ${shortSha(by.commit)}, but anton could not record that on ` +
        `${run.branch} (${e instanceof Error ? e.message : String(e)}) — nothing on the branch would ` +
        `then account for the ticket, so a later attempt would reopen it and run an agent against ` +
        `work that is already there. Left unclosed instead: clear whatever git refused in ` +
        `${run.worktreePath}, then resume the run`,
    );
  }
}
