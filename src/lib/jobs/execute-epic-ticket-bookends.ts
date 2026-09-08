/**
 * What brackets ONE ticket's walk (anton-owlx — extracted from execute-epic-ticket.ts): the claim it
 * must hold before any work, the session and step context its steps run in, the wall clock they run
 * under, and the single board write its committed work earns.
 *
 * Everything here is bookkeeping the walk needs done but does not itself decide. What happens when a
 * ticket stops short is the settlement's (execute-epic-ticket-settle.ts).
 */
import { beads, labelValueOf, LABELS, unclaimableStatus, type Bead } from "../beads/bd";
import { formatSatisfiedNote, shortSha } from "../beads/satisfied-note";
import { readWorktreeState, type WorktreeState } from "../git/ops";
import { updateRun } from "../runs";
import { appendSessionLog, endSession, startJobSession, type JobSession } from "../sessions";
import { PoisonEpic } from "./errors";
import { mustPersist, safe } from "./execute-epic-persist";
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
  // earned; and — like the marker above — a run that cannot clear it parks before it can open that PR.
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
  const staleSurvivor = beads.supersedesTarget(claimed);
  if (staleSurvivor) {
    if (!(await mustPersist(() => beads.unlink(repo, ticket.id, staleSurvivor)))) {
      await unclaimAndPark(repo, ticket.id);
      throw new PoisonEpic(
        `${ticket.id} carries a stale \`supersedes\` edge to ${staleSurvivor} from a previous ` +
          `retirement but bd would not remove it — running this ticket and opening a pull request ` +
          `would make its own honest close read as superseded again, and a cross-machine resume ` +
          `drop the rerun's work from the PR. Check the beads DB, then resume the run`,
      );
    }
  }
  void beads
    .sync(repo)
    .catch((e) => console.error(`[execute-epic] claim sync failed for ${ticket.id}`, e));
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
  const { db, clock, ctx, projectId, runId, worktreePath } = run;
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
  // dispatch overwrites the last, so the handle always names the job's CURRENT session.
  ctx.report({ sessionId, cwd: worktreePath });
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
