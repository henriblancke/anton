/**
 * Every way ONE ticket stops short, and what each owes the board (anton-owlx — extracted from
 * execute-epic-ticket.ts).
 *
 * The walk decides when a ticket is done; this decides what a ticket that ISN'T owes — the rollback
 * that keeps the NEXT ticket's commit honest, the marker merge finalization reads, the claim handed
 * back, and the note an operator settles it from. Four distinct stops share the path and their ORDER
 * is the whole design: the budget first (it aborts the same signal a kill does), then the abort
 * (whose author writes nothing to a board a human is deciding on), then the factual repair, then the
 * release.
 */
import { beads, LABELS, type Bead } from "../beads/bd";
import { formatAntonResult, type AntonResult } from "../claude/anton-result";
import {
  readWorktreeState,
  restoreWorktreeState,
  sameWorktreeState,
  type WorktreeState,
} from "../git/ops";
import { appendSessionLog, endSession, type JobSession } from "../sessions";
import { isUsageLimitError, PoisonEpic } from "./errors";
import {
  BlockedByAgentError,
  CancelledAskError,
  NeedsHumanError,
  NoDeliveryError,
  ParkedOnPrereqError,
  RepairedBlockError,
  TicketTimeoutError,
  WorktreeDirtyError,
} from "./execute-epic-errors";
import { mustPersist, safe } from "./execute-epic-persist";
import { repairBlockedTicket, type TicketRepair } from "./execute-epic-ticket-repair";
import type { StepContext } from "./step-registry";

/** What the step walk learned — read by the close, and by every path that stops the ticket. */
export interface TicketProgress {
  /** Whether the commit step reported real evidence on the branch. */
  committed: boolean;
  /**
   * The agent's machine-readable self-report (anton-j5i8) — `delivered`, `blocked — <reason>` or an
   * ask — already recorded on the session log by the dispatching step. It CORROBORATES the
   * delivery-evidence gate, never replaces it; a missing/unparseable line (null) falls through to it.
   */
  selfReport: AntonResult | null;
}

/**
 * What each failure means for the BEAD — a no-delivery or agent-declared block is a human-review
 * state, an ask is the RUN's wait, and a usage-limit park is not a failure at all.
 */
interface TicketFailureKinds {
  noDelivery: boolean;
  agentBlocked: boolean;
  /**
   * The ask is the RUN's wait, never the ticket's state (anton-287p.3). The run parks behind a human
   * gate and resumes THIS row once a person resolves it — and a `blocked` ticket is not claimable,
   * so blocking it would make that resume impossible: the resumed run dies on `bd update --claim`
   * and the park becomes permanent. Left open and unassigned instead, which is what the resumed run
   * re-claims. What a human owes is on the gate, not on this bead.
   */
  needsHuman: boolean;
}

/** Every way a ticket stops short, and what each owes the board. Always throws. */
export async function settleFailedTicket(args: {
  run: Omit<StepContext, "tickets">;
  ticket: Bead;
  session: JobSession;
  /** Whether this ticket's own DEADLINE fired, as opposed to the job's abort. */
  ranOutOfTime: boolean;
  baseline: WorktreeState | null;
  progress: TicketProgress;
  timeoutMs: number;
  e: unknown;
}): Promise<never> {
  const { run, ticket, session, ranOutOfTime, baseline, progress, timeoutMs, e } = args;
  const { db, clock } = run;
  const { sessionId, logPath } = session;
  await endSession(db, clock, sessionId, "failed");
  // Record the no-delivery / agent-blocked reason in the session log too, so it's visible when
  // tailing/replaying the session — not just in the run row's error. Best-effort; never mask the
  // run's own error.
  const kinds: TicketFailureKinds = {
    noDelivery: e instanceof NoDeliveryError,
    agentBlocked: e instanceof BlockedByAgentError,
    needsHuman: e instanceof NeedsHumanError,
  };
  if (kinds.noDelivery) {
    await appendSessionLog(logPath, `[no-delivery] ${(e as Error).message}\n`).catch(() => {});
  } else if (kinds.agentBlocked) {
    await appendSessionLog(logPath, `[agent-blocked] ${(e as Error).message}\n`).catch(() => {});
  }
  await settleTicketTimeout({ run, ticket, session, baseline, progress, timeoutMs, ranOutOfTime });
  await settleAbortedTicket({ run, ticket, session, e });
  // Attempted only AFTER the abort path has had its say: a ticket someone killed or abandoned is
  // settled by whoever stopped it, and repairing its bead would write to a board a human is deciding
  // on. Before the release, because what the repair answers decides whether this bead is left
  // `blocked` for a person or `open` for the retry it just earned.
  const repair = repairableBlock(e, kinds)
    ? await repairBlockedTicket({ run, ticket, logPath, selfReport: progress.selfReport, e })
    : undefined;
  await releaseFailedTicket({ run, ticket, session, progress, e, kinds, repair });
  // The repaired bead goes back through the ordinary queue (R5.10): a non-poison error spends one of
  // the runner's own attempts, behind its own backoff and the picker's brakes. The block it replaces
  // would have parked the run outright.
  if (repair?.action === "repaired") throw new RepairedBlockError(ticket.id, repair.attempted, e);
  // An ordering recorded is a WAIT, not a correction: the ticket cannot start until the blocker
  // lands, so the run parks behind the edge anton just drew instead of spending an attempt on it.
  if (repair?.action === "parked") {
    throw new ParkedOnPrereqError(ticket.id, repair.blockerId, repair.attempted, e);
  }
  throw e;
}

/**
 * Whether this failure is one a FACTUAL repair may run on at all (anton-fzas, anton-qg4h / R5.4).
 *
 * Only the two block kinds that mean "the agent could not do the work": a zero-diff run
 * ({@link NoDeliveryError}), and one the agent itself declared incomplete
 * ({@link BlockedByAgentError}). No other failure qualifies — not an ask (that is a person's to
 * answer), not a usage-limit park (not a failure at all), and not any step failure that is neither of
 * those two: a run that fell over in review, commit or PR stopped on something the bead's pointers
 * and edges cannot explain.
 *
 * COMMITTED WORK IS NOT EXCLUDED, and that is deliberate (PR #223 review). `BlockedByAgentError` is
 * raised precisely when the tree DID commit and the agent still reported `blocked` — a partial
 * change plus an honest "this is not done". The block is the agent's own report, so what the repairs
 * answer is unchanged by the diff: a `dep-missing` report naming a prerequisite still means the rest
 * of the work cannot start until it lands, and a cited path that has moved is still stale whether or
 * not something was committed against the old one. What the commit changes is the ticket's fate, and
 * that is settled below — the bead is blocked for a human either way.
 */
function repairableBlock(e: unknown, kinds: TicketFailureKinds): boolean {
  if (isUsageLimitError(e) || kinds.needsHuman) return false;
  return kinds.noDelivery || kinds.agentBlocked;
}

/**
 * OUT OF TIME (anton-t1mo) — settled FIRST, because this ticket's signal is aborted on this path too
 * and every later check would read it as an operator's kill. This abort has a known author (anton)
 * and a known remedy, so unlike a kill it settles the ticket here: roll the partial work back, block
 * the bead with the reason, and let the caller carry on with the next ticket.
 *
 * The rollback is the half that keeps the REST of the run honest. A ticket stopped mid-edit leaves a
 * dirty tree, and the next ticket's commit step would sweep those changes up as its own — the
 * feature's history then attributes work to a ticket that never did it, and unreviewed half-work
 * rides into the PR under someone else's name.
 *
 * Returns only when the budget was NOT what stopped this ticket; otherwise it always throws.
 */
async function settleTicketTimeout(args: {
  run: Omit<StepContext, "tickets">;
  ticket: Bead;
  session: JobSession;
  baseline: WorktreeState | null;
  progress: TicketProgress;
  timeoutMs: number;
  ranOutOfTime: boolean;
}): Promise<void> {
  const { run, ticket, session, baseline, timeoutMs, ranOutOfTime } = args;
  const { ctx, worktreePath } = run;
  const repo = run.repoPath;
  const { logPath } = session;
  const { committed } = args.progress;
  // `!ctx.signal.aborted` breaks the tie when both fired: an operator's kill outranks the budget,
  // and the abort path is the one that writes nothing to a board a human is deciding on.
  if (!ranOutOfTime || ctx.signal.aborted) return;
  await appendSessionLog(
    logPath,
    `[ticket-timeout] ${ticket.id} exceeded its ${Math.round(timeoutMs / 60_000)}m budget\n`,
  ).catch(() => {});
  const leftovers = await rollbackTimedOutTicket(worktreePath, baseline, committed);
  const marked = await blockTimedOutTicket({
    repo,
    ticket,
    worktreePath,
    timeoutMs,
    committed,
    leftovers,
  });
  // The rollback is what keeps the REST of the run honest, so its failure cannot be absorbed
  // the way the timeout itself is: the next ticket captures its baseline from this same tree
  // and would commit these leftovers under its own name. The bead note can't prevent that —
  // nothing pauses the run, so the wrong commit lands long before an operator reads it. Halt
  // instead (poison → park) and let a human clear the tree before anything else commits.
  if (leftovers) {
    throw new WorktreeDirtyError(
      `${ticket.id} exceeded its ${Math.round(timeoutMs / 60_000)}m ticket budget and its ` +
        `partial work could NOT be rolled back — the run's worktree (${worktreePath}) still ` +
        `carries changes that the next ticket would commit as its own, so the run stopped ` +
        `here. Clear the worktree by hand, then resume the run`,
    );
  }
  // Same reasoning one step further out: this ticket's work is on no branch, and without the
  // marker the merge of the PR carrying the REST of the feature closes it as shipped. The bead
  // note can't prevent that — finalization reads labels, not prose — so halt instead of
  // absorbing this timeout and walking on toward a PR that would swallow the ticket.
  if (!marked) {
    throw new PoisonEpic(
      `${ticket.id} exceeded its ${Math.round(timeoutMs / 60_000)}m ticket budget and its ` +
        `partial work was rolled back, but bd would not record \`${LABELS.notDelivered}\` on ` +
        `it — the run stopped rather than carry on to a pull request whose merge would close ` +
        `this undelivered ticket as shipped. Check the beads DB, then resume the run`,
    );
  }
  throw new TicketTimeoutError(ticket.id, timeoutMs, committed);
}

/**
 * Undo what a timed-out ticket left in the tree, and report whether any of it is STILL there — the
 * only condition under which the NEXT ticket's commit would sweep it up as its own.
 */
async function rollbackTimedOutTicket(
  worktreePath: string,
  baseline: WorktreeState | null,
  committed: boolean,
): Promise<boolean> {
  // NEVER roll back a ticket that already committed. The baseline is the commit this ticket
  // STARTED from, so a reset onto it would delete that commit — and a ticket whose commit landed
  // has delivered real, gate-passed work; only its bookkeeping was cut short. The rollback exists
  // for the uncommitted case, which is the only one that can leak into the next ticket's commit.
  const rolledBack =
    !committed && baseline ? await safe(() => restoreWorktreeState(worktreePath, baseline)) : false;
  // A rollback that failed — or was impossible, because the baseline itself was unreadable — may
  // have left this ticket's files in the worktree the NEXT ticket commits from. Re-read the tree
  // rather than assume: only changes actually left behind are dangerous, and a tree that can't be
  // read at all counts as dangerous.
  return !committed && !rolledBack && (await leftChangesBehind(worktreePath, baseline));
}

/**
 * Write a timed-out ticket's board state: blocked and released, with the operator's account of what
 * happened to its work. Returns whether the undelivered marker landed — the one write here the run
 * cannot proceed without.
 */
async function blockTimedOutTicket(args: {
  repo: string;
  ticket: Bead;
  worktreePath: string;
  timeoutMs: number;
  committed: boolean;
  leftovers: boolean;
}): Promise<boolean> {
  const { repo, ticket, worktreePath, timeoutMs, committed, leftovers } = args;
  await safe(() => beads.setStatus(repo, ticket.id, "blocked"));
  await safe(() => beads.unassign(repo, ticket.id));
  await safe(() => beads.untag(repo, ticket.id, [LABELS.stage("implementing")]));
  // Rolled back ⇒ nothing from this ticket is on the branch, so it is in no PR: mark it, or merge
  // finalization closes it as shipped when the rest of the feature lands (anton-67xj). A ticket
  // stopped AFTER its commit is NOT marked — its work is in the diff a human merges. The marker is
  // finalization's only input, so it is retried rather than best-effort; a run that still cannot
  // record it must not reach its PR (the caller escalates, once the note below is on the bead — the
  // operator needs the timeout's own account either way).
  const marked =
    committed || (await mustPersist(() => beads.tag(repo, ticket.id, [LABELS.notDelivered])));
  await safe(() =>
    beads.note(
      repo,
      ticket.id,
      `anton: stopped after ${Math.round(timeoutMs / 60_000)}m — the ticket outlived its ` +
        `budget, so the run blocked it and carried on with the rest of the feature. ` +
        (committed
          ? `Its work IS committed on the branch (it was stopped after the commit) — review it ` +
            `and close the ticket by hand if it is complete. `
          : leftovers
            ? `Its partial work could NOT be rolled back and is STILL in the run's worktree ` +
              `(${worktreePath}), so the run stopped rather than let another ticket commit it — ` +
              `clear the worktree by hand before resuming. `
            : `Its partial work was rolled back (nothing from it is on the branch). `) +
        `Re-scope it into smaller tickets, or raise ticketTimeoutMinutes, then resume the run`,
    ),
  );
  // Either halt the caller makes PARKS the run and tells the operator to resume it, so this ticket
  // has to stay claimable (anton-67xj). The block above left it `blocked` — or `in_progress` and
  // unowned, if that best-effort status write failed — and runTicket's hard claim gate refuses
  // both, so the advertised resume would die on its own first step. Put it back at `open`, the same
  // restore the stale-marker path performs; the note above is what carries the timeout's account to
  // the operator, not the status. A timeout the run ABSORBS keeps `blocked` here: it carries on to
  // a PR, and the block is the human's cue — and if that run later stops instead, its own stopping
  // path reopens what it absorbed, for exactly the reason above.
  if (leftovers || !marked) await safe(() => beads.setStatus(repo, ticket.id, "open"));
  return marked;
}

/**
 * An ABORTED ticket writes nothing to the board (anton-6xj0) — returns only when this ticket was
 * neither aborted nor settled elsewhere; otherwise it always throws.
 */
async function settleAbortedTicket(args: {
  run: Omit<StepContext, "tickets">;
  ticket: Bead;
  session: JobSession;
  e: unknown;
}): Promise<void> {
  const { run, ticket, session, e } = args;
  const { ctx } = run;
  const repo = run.repoPath;
  const { logPath } = session;
  // An ABORTED ticket writes nothing to the board (anton-6xj0). The abort's author decides this
  // ticket's fate, not this unwinding handler: an abandon settles it (closed + `abandoned`, the
  // stage label cleared — beads.abandon does all three), a force-kill or a lost lease leaves it
  // claimed for the resume that follows. Writing here would race the abandon's own writes — the
  // handler unwinds in milliseconds while `bd close` takes far longer, so whichever landed last
  // would win — and reopening a ticket a human just killed re-queues it into the ready pool,
  // while blocking it would file the operator's own decision as a failure needing attention.
  // The error still propagates: the run stops, and the cancelled job means no park.
  // The same holds for a ticket abandoned WITHOUT this job being killed — an abandon on another
  // machine, arriving by sync, while this ticket happened to fail here. Its outcome is settled;
  // don't rewrite it. Checked second because it costs a bd read, and only on the failure path.
  const settledElsewhere =
    !ctx.signal.aborted &&
    (await beads
      .show(repo, ticket.id)
      .then((b) => beads.isAbandoned(b))
      .catch(() => false));
  if (ctx.signal.aborted || settledElsewhere) {
    const why = ctx.signal.aborted ? "aborted" : "abandoned";
    await appendSessionLog(logPath, `[${why}] ${ticket.id} was ${why} mid-run\n`).catch(() => {});
    // "Writes nothing to the board" covers the RUN's writes too, and the ask is one of them: the
    // run-level catch turns a NeedsHumanError into a `human` gate blocking the target. That gate
    // outlives the cancellation — a person must clear it by hand, and on an abandoned target
    // gate-check never resumes anything that would. Cancellation wins; the ask travels as a plain
    // stop instead, carrying what was asked so it still reaches the operator through the run row.
    if (e instanceof NeedsHumanError) throw new CancelledAskError(ticket.id, why, e.ask);
    throw e;
  }
}

/**
 * Release the claim so the board never shows a dead session's ticket as in-flight
 * (anton-live-sync R10). A usage-limit park is NOT dead — the run resumes with the claim intact.
 * Two states must NOT silently re-queue the ticket open: work already landed on the branch
 * (commits exist), OR the agent delivered nothing at all (zero diff). Both are human-review
 * states — block with an operator-facing note. Resetting a no-delivery ticket to open would
 * silently re-queue it into the ready pool and hide the false-success. A `needs-human` ask is
 * the exception to that rule, excused by `settleAbortedTicket` before this runs. All
 * best-effort: never mask the run's error; the epic-level finally sync pushes the release.
 */
async function releaseFailedTicket(args: {
  run: Omit<StepContext, "tickets">;
  ticket: Bead;
  session: JobSession;
  progress: TicketProgress;
  e: unknown;
  kinds: TicketFailureKinds;
  /** What the factual repair pass answered, when it ran — see {@link repairBlockedTicket}. */
  repair?: TicketRepair;
}): Promise<void> {
  const { run, ticket, session, e } = args;
  const repo = run.repoPath;
  const { committed, selfReport } = args.progress;
  const { noDelivery, agentBlocked, needsHuman } = args.kinds;
  if (isUsageLimitError(e)) return;
  // A REPAIRED bead is not a human-review state, it is work with one retry coming (R5.10) — and
  // `blocked` is a status bd refuses to claim, so blocking it here would kill that retry on its own
  // first step. Left `open` like every other re-queued ticket; the repair's own note and stamp are
  // what carry the account, not the status.
  //
  // A bead PARKED behind a new prerequisite (anton-qg4h) is left the same way, for the same reason
  // one step further out: what holds it back is the `blocks` edge, and that edge already keeps it
  // out of every ready query. Blocking the status on top would add nothing and would make the
  // resume that follows the blocker landing impossible — `bd update --claim` refuses a `blocked`
  // bead, so the wait would become permanent.
  const staysClaimable = args.repair?.action === "repaired" || args.repair?.action === "parked";
  if ((committed || noDelivery || agentBlocked) && !needsHuman && !staysClaimable) {
    await blockFailedTicket({
      run,
      ticket,
      sessionId: session.sessionId,
      kind: noDelivery ? "no-delivery" : agentBlocked ? "agent-blocked" : "post-commit",
      committed,
      selfReport,
      error: e,
    });
  } else {
    await safe(() => beads.setStatus(repo, ticket.id, "open"));
  }
  await safe(() => beads.unassign(repo, ticket.id));
  await safe(() => beads.untag(repo, ticket.id, [LABELS.stage("implementing")]));
}

/** Block the bead for a human, with the note that says which failure this was and where its evidence is. */
async function blockFailedTicket(args: {
  run: Omit<StepContext, "tickets">;
  ticket: Bead;
  sessionId: string;
  kind: TicketBlockKind;
  committed: boolean;
  selfReport: AntonResult | null;
  error: unknown;
}): Promise<void> {
  const { run, ticket, sessionId, kind, committed, selfReport, error } = args;
  const repo = run.repoPath;
  await safe(() => beads.setStatus(repo, ticket.id, "blocked"));
  // The tip this ticket's work landed on — the operator's route from the note straight to the
  // diff. Best-effort and only when something was committed: an unreadable worktree costs the
  // sha, never the note.
  const head = committed
    ? await readWorktreeState(run.worktreePath)
        .then((s) => s.head)
        .catch(() => undefined)
    : undefined;
  await safe(() =>
    beads.note(
      repo,
      ticket.id,
      ticketBlockNote({ kind, selfReport, error, sessionId, branch: run.branch, head }),
    ),
  );
}

/** Fold the parsed self-report into a zero-diff block reason, when one was emitted (anton-j5i8). */
export function selfReportSuffix(selfReport: AntonResult | null): string {
  if (!selfReport) return "";
  return selfReport.outcome === "delivered"
    ? ` The agent self-reported ANTON-RESULT: delivered — a false success on an unchanged tree.`
    : ` The agent self-reported ${formatAntonResult(selfReport)}, corroborating the block.`;
}

/**
 * How much of an agent's reason (or a failure's error text) one block note may carry. The note is a
 * board-level summary, not a transcript: enough to decide from, and bounded so a runaway message
 * can't bloat the bead's append-only notes blob. The session log still holds the full text.
 */
const BLOCK_NOTE_DETAIL_CHARS = 400;

/**
 * Flatten to a SINGLE line and cap. Machine notes live one-per-line in the notes blob
 * (beads/notes.ts), so an un-flattened multi-line reason would parse back as several notes — the
 * later lines attributed to anton with no context at all.
 */
function blockNoteDetail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > BLOCK_NOTE_DETAIL_CHARS
    ? `${flat.slice(0, BLOCK_NOTE_DETAIL_CHARS).trimEnd()}…`
    : flat;
}

export type TicketBlockKind = "no-delivery" | "agent-blocked" | "post-commit";

/**
 * The operator-facing note left on a ticket the run blocked (anton-vqql).
 *
 * Every category used to write one static string, so two tickets blocked for entirely different
 * causes got byte-identical notes and the only route to the difference was finding the run, finding
 * the session, and reading its log. The reason the agent already stated on its `ANTON-RESULT:
 * blocked` line — and the error behind a post-commit failure — belong on the bead, next to the
 * evidence that backs them: the session, and the branch + short sha when work was committed.
 *
 * Exactly one line by construction: the reason is flattened and capped, so `parseTicketNotes` reads
 * it back as one machine note. A missing or unparseable self-report degrades to the category text
 * alone — never an empty quote, never the string "undefined".
 */
export function ticketBlockNote(args: {
  kind: TicketBlockKind;
  /** The agent's parsed `ANTON-RESULT` line, when it emitted one. */
  selfReport: AntonResult | null;
  /** The error that halted the ticket — what a post-commit failure has to say for itself. */
  error?: unknown;
  sessionId: string;
  branch: string;
  /** The committed tip, full sha; absent when this ticket committed nothing. */
  head?: string;
}): string {
  const { kind, sessionId, branch, head } = args;
  const reason = blockNoteDetail(args.selfReport?.reason ?? "");
  // A reason that flattens to nothing is NO reason — drop it, so the rendering falls back to the
  // category text rather than trailing an empty quote or a dangling dash.
  const selfReport = args.selfReport && { ...args.selfReport, reason: reason || undefined };
  const failure = blockNoteDetail(errorText(args.error));

  const body =
    kind === "no-delivery"
      ? `run made no changes (clean agent exit, zero diff) — nothing was delivered; needs a human ` +
        `to implement it or fix the ticket, then resume the run.` +
        selfReportSuffix(selfReport)
      : kind === "agent-blocked"
        ? `the agent self-reported ANTON-RESULT: blocked and committed only partial work — it ` +
          `declared the ticket incomplete${reason ? `: "${reason}"` : ` (no reason given)`}; needs ` +
          `a human to finish or re-scope it, then resume the run.`
        : `run failed after committing work — needs review.` +
          (failure ? ` It failed with: ${failure}` : "");

  const evidence = head
    ? `session ${sessionId}, committed on ${branch} @ ${head.slice(0, 7)}`
    : `session ${sessionId}, nothing committed on ${branch}`;
  return blockNoteOneLine(`anton: ${body} [${evidence}]`);
}

/** The error's own words, or "" when there are none worth repeating. */
function errorText(error: unknown): string {
  if (error === undefined || error === null) return "";
  const text = error instanceof Error ? error.message : String(error);
  return text === "undefined" || text === "null" ? "" : text;
}

/** Last-resort flatten of the whole composed note — the blob is line-delimited, so this is a hard invariant. */
function blockNoteOneLine(note: string): string {
  return note.replace(/\s+/g, " ").trim();
}

/**
 * Whether a stopped ticket left changes behind in the shared worktree — the state that would ride
 * into the NEXT ticket's commit under the wrong name.
 *
 * Anything unreadable counts as left behind: a tree we cannot prove clean is exactly the one that
 * must not be waved through. With no baseline to compare against (its read failed), working-tree
 * dirt alone is the signal — that is what the commit step would pick up.
 */
async function leftChangesBehind(
  worktreePath: string,
  baseline: WorktreeState | null,
): Promise<boolean> {
  const now = await readWorktreeState(worktreePath).catch(() => null);
  if (!now) return true;
  return baseline ? !sameWorktreeState(now, baseline) : now.status !== "";
}
