/**
 * The stopping conditions an execute-epic run raises for itself (anton-1lix — extracted from
 * execute-epic.ts). Every one of them is read by name somewhere downstream — the run's settle picks
 * the row status off them, the ticket loop absorbs exactly one, the runner classifies the poison
 * ones — so they live together rather than beside the code that happens to throw them.
 */
import { blockedByPoison, parkedOnGateClause, PoisonEpic } from "./errors";

/**
 * The run ran every ticket it could and the rest are held by a prerequisite outside it (anton-1two).
 * Poison (`PoisonEpic`), so the runner parks the JOB for a human rather than burning retries on a
 * wait no retry shortens — and, like {@link ReviewBlockedError}, the RUN row is parked instead of
 * failed: its tickets' commits are on the branch, and the resume that follows the blocker landing
 * continues in this same row and worktree rather than reading as a crash.
 */
export class BlockedTailError extends PoisonEpic {}

/**
 * A timed-out ticket's partial work could NOT be rolled back, so the run halted rather than let the
 * next ticket commit the leftovers as its own (anton-t1mo). Poison (`PoisonEpic`) like the tail
 * above, but distinguishable at the teardown: the worktree named in this error is the only copy of
 * that work and the very path the operator is told to clear, so it must survive the run's release
 * (`holdsPartialWork`) instead of being force-removed with the rest of a failed run's residue.
 */
export class WorktreeDirtyError extends PoisonEpic {}

/**
 * The agent exited clean but delivered no code — a zero-diff commit (issue #46 root cause #1).
 * Poison-classified (`name = "PoisonError"`), so the runner parks the run for a human rather than
 * burning retries: re-running the agent on the same unchanged ticket would just reproduce the empty
 * result. A distinct subclass so runTicket's catch can tell "delivered nothing" apart from other
 * failures and block (never re-queue open) the ticket accordingly.
 */
export class NoDeliveryError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PoisonError"; // classified as poison by the runner
  }
}

/**
 * The agent committed changes but SELF-REPORTED `ANTON-RESULT: blocked` (anton-j5i8) — it declared
 * the ticket incomplete despite leaving a diff. Poison-classified (`name = "PoisonError"`) so the
 * runner parks for a human rather than retrying: the agent has said it can't finish, so re-running
 * would reproduce the same block. A distinct subclass so runTicket's catch can surface it (block +
 * agent-specific note) apart from a genuine post-commit failure.
 */
export class BlockedByAgentError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PoisonError"; // classified as poison by the runner
  }
}

/**
 * A block anton REPAIRED, so the run retries instead of parking (anton-fzas / R5.10).
 *
 * Thrown in place of the poison the block would otherwise have raised — {@link NoDeliveryError} or
 * {@link BlockedByAgentError} — and deliberately NOT poison itself. That single difference is the
 * whole mechanism: a plain error goes back through the runner's ordinary retry budget and backoff,
 * so the repaired bead re-enters the queue exactly like any other retried work, behind the same
 * brakes, with no special standing. There is no bypass to review because there is no bypass.
 *
 * "Retried ONCE" is not counted here and must not be: the repair stamp on the bead is what bounds it
 * (R5.6). A second block of the same class finds a bead anton has already repaired, the guard
 * (`gardener/repair.ts` `decideRepair`) escalates instead of repairing, and the run parks on the
 * poison it would have parked on the first time — so the retry happens at most once per bead per class no matter how many
 * attempts the runner's budget allows.
 */
export class RepairedBlockError extends Error {
  constructor(
    readonly ticketId: string,
    /** What the repair did, in the words the bead's own note carries. */
    readonly attempted: string,
    /** The block this repair answered — kept so the run's error still states what stopped it. */
    readonly block: unknown,
  ) {
    super(
      `${ticketId} blocked, and anton repaired it: ${attempted}. The run failed so the ticket goes ` +
        `back through the queue for one retry against the corrected bead; a second block of the ` +
        `same kind will park it for a human instead. It stopped with: ` +
        (block instanceof Error ? block.message : String(block)),
    );
    this.name = "RepairedBlockError";
  }
}

/**
 * The block anton answered by DRAWING THE EDGE it was missing (anton-qg4h / R5.4): the ticket needs
 * another bead to land first, so the ordering is recorded and the run parks behind it.
 *
 * A {@link BlockedTailError}, which is precisely what this now is — a run holding work that waits on
 * a prerequisite outside it — and that inheritance is the whole behaviour: the RUN row parks rather
 * than failing, so the resume continues in this same row and worktree once the blocker lands, and
 * the JOB parks rather than retrying. The contrast with {@link RepairedBlockError} is deliberate: a
 * rewritten pointer earns an immediate retry because the bead is now correct, while an ordering
 * earns a WAIT — retrying now would spend an attempt proving the edge anton just drew.
 *
 * Phrased through {@link blockedByPoison} so the blocker id is readable back out of the park message
 * by the run-health sweep, exactly as it is for a run that was already blocked when it started.
 */
export class ParkedOnPrereqError extends BlockedTailError {
  constructor(
    readonly ticketId: string,
    /** The prerequisite the new edge points at. */
    readonly blockerId: string,
    /** What the repair did, in the words the bead's own note carries. */
    readonly attempted: string,
    /** The block this repair answered — kept so the park still states what stopped the run. */
    readonly block: unknown,
  ) {
    super(
      `${blockedByPoison(ticketId, [blockerId]).message} — anton drew that edge itself after the ` +
        `agent reported \`dep-missing\`: ${attempted}. It stopped with: ` +
        (block instanceof Error ? block.message : String(block)),
    );
  }
}

/**
 * The agent reported `ANTON-RESULT: needs-human — <ask>` (anton-287p): it stopped because only a
 * person can take the next step, not because it hit a broken state. Distinct from
 * {@link BlockedByAgentError} in what it COSTS the operator — a block is a defect to diagnose, an ask
 * is a minute of their attention — and the run-level catch is what turns it into board state: a
 * `human` gate on the run target carrying {@link ask} verbatim.
 *
 * Poison-classified (`name = "PoisonError"`) so the runner parks rather than burning attempts. A
 * retry cannot answer an ask; only the person can, and resolving their gate is what releases the run.
 */
export class NeedsHumanError extends Error {
  constructor(
    readonly ticketId: string,
    /** The agent's ask, verbatim — the gate's reason. Undefined when it named none. */
    readonly ask: string | undefined,
    /** Overridden only by {@link ParkedAskError}, which names the gate the ask actually reached. */
    message = `${ticketId} needs a human: ${ask ?? "(the agent named no ask)"}. The run is parked ` +
      `until someone answers it.`,
  ) {
    super(message);
    this.name = "PoisonError"; // classified as poison by the runner
  }
}

/**
 * The ask once its gate is LIVE and the run row records the park (anton-287p) — thrown in the plain
 * ask's place so the runner's poison park NAMES that gate.
 *
 * The id is what keeps ONE wait from being escalated twice (PR #205 review). Every poison park is an
 * `exhausted-job` finding — "parked without retrying (permanent failure)" — while the run-health
 * sweep already reports this same pause as the gate's own `needs-human`, the half that says what a
 * person does about it. Carrying the id in the park message is how the sweep recognises the two as
 * one wait ({@link parkedAskGateId}) and keeps only the actionable half; without it the operator
 * gets a second escalation calling a wait on them a permanent failure.
 */
export class ParkedAskError extends NeedsHumanError {
  constructor(
    ask: NeedsHumanError,
    readonly gateId: string,
    /**
     * The target's OTHER open human gates, named in the park for the same reason (PR #205 review):
     * they outlive this ask, so a sweep that knew only {@link gateId} would call the still-waiting
     * job a permanent failure as soon as anton's own gate is answered.
     */
    readonly held: string[] = [],
  ) {
    super(
      ask.ticketId,
      ask.ask,
      `${ask.ticketId} needs a human: ${ask.ask ?? "(the agent named no ask)"}. ` +
        parkedOnGateClause(gateId, held),
    );
  }
}

/**
 * A {@link NeedsHumanError} that a cancellation overtook (anton-287p): the agent asked for a human,
 * and by the time the ask reached the run's catch the job had been force-killed or the ticket
 * abandoned. Thrown in the ask's place so NO gate is armed — a `human` gate is new board state that
 * blocks the target until a person resolves it by hand, and arming one on a run someone just stopped
 * (an abandoned target especially, which gate-check will never resume) leaves a wait nobody asked
 * for. The ask still reaches the operator, through this run's error.
 *
 * Poison-classified exactly like the error it replaces: a retry cannot answer an ask either.
 */
export class CancelledAskError extends Error {
  constructor(ticketId: string, why: "aborted" | "abandoned", ask: string | undefined) {
    super(
      `${ticketId} needed a human: ${ask ?? "(the agent named no ask)"}. The ticket was ${why} ` +
        `first, so the run stopped there and armed NO gate — nothing on the board carries the ask. ` +
        `Answer it and re-run the target if the work is still wanted.`,
    );
    this.name = "PoisonError"; // classified as poison by the runner
  }
}

/**
 * A cancelled arm that could not undo its own write (anton-287p): the kill landed while `gate create`
 * ran, so the gate exists — and the `gate resolve` that would have taken it back failed too. Nothing
 * automatic ever closes a human gate, so {@link gateId} keeps blocking {@link targetId} until a
 * person resolves it; the run settles FAILED naming it, because that id exists nowhere else.
 */
export class StrandedHumanGateError extends Error {
  /** Every human gate left open on the target — the wait this run armed first. */
  readonly gateIds: string[];
  constructor(
    readonly targetId: string,
    readonly gateId: string,
    detail: string,
    alsoOpen: string[] = [],
  ) {
    const ids = [gateId, ...alsoOpen];
    super(
      `${detail} — ${targetId} stays blocked until ` +
        `${ids.map((id) => `\`bd gate resolve ${id}\``).join(" and ")} runs`,
    );
    this.gateIds = ids;
  }
}

/**
 * What a run settles on when its ticket asked for a human — the ask itself, or the cancelled form
 * that arms no gate (anton-287p).
 *
 * Takes the LIVE signal, never a snapshot of `aborted`: the epic handler unwinds through several
 * awaited bd writes (releasing the children it reserved) before it settles, and a force-kill that
 * lands during them is still an operator stopping the run. Read too early, the ask would go on to
 * arm a `human` gate that blocks the target until someone clears it by hand, for a run nobody is
 * waiting on. So callers must pass the signal and call this at the settle, not at the catch.
 */
export function askSettleError(raw: unknown, signal: AbortSignal): unknown {
  return raw instanceof NeedsHumanError && signal.aborted
    ? new CancelledAskError(raw.ticketId, "aborted", raw.ask)
    : raw;
}

/**
 * One ticket outlived its wall-clock budget (anton-t1mo — `ticketTimeoutMinutes`).
 *
 * Deliberately NOT poison, and deliberately not fatal to the run: the ticket loop catches this one
 * error and moves to the next ticket, so a feature is never ended by a single ticket that couldn't
 * converge. runTicket has already blocked the bead and rolled its partial work back by the time this
 * is thrown, so nothing downstream needs to settle it — the loop only records which ticket it was.
 *
 * Carrying on is safe only because the worktree is provably clean of this ticket: a rollback that
 * could not prove that raises {@link PoisonEpic} instead, halting the run so no later ticket commits
 * the leftovers as its own.
 */
export class TicketTimeoutError extends Error {
  constructor(
    readonly ticketId: string,
    readonly budgetMs: number,
    /**
     * Whether this ticket's work made it into a commit before the clock ran out (the narrow case of
     * a deadline landing on the bookkeeping AFTER the commit step). Its diff is on the branch, so
     * the run still lists it as delivered — only its bead is left unfinished.
     */
    readonly committed: boolean,
  ) {
    super(
      `${ticketId} exceeded its ${Math.round(budgetMs / 60_000)}m ticket budget and was stopped. ` +
        (committed
          ? `Its work IS committed on the branch (only its bead was left unfinished)`
          : `Its partial work was rolled back`) +
        ` and the ticket is blocked for review; the rest of the run continued. ` +
        `Re-scope it (or raise ticketTimeoutMinutes), then resume.`,
    );
    this.name = "TicketTimeoutError";
  }
}

/**
 * The review gate refused to let this run open a PR (anton-omum): blocking findings it could not
 * converge, a reviewer that broke the report protocol, or poison the gate raised itself (a reviewer
 * commit it could not revert, a fixer that moved to a branch of its own).
 *
 * Poison-classified (`name = "PoisonError"`) like {@link NoDeliveryError}, so the runner parks the run
 * for the founder instead of retrying: the reviewer has already had its bounded rounds to converge,
 * and re-running the same gate on the same diff would reproduce the same verdict. Marks the run
 * PARKED rather than failed, so the resume the founder is instructed to do reuses this row.
 */
export class ReviewBlockedError extends Error {
  constructor(msg: string, options?: ErrorOptions) {
    super(msg, options);
    this.name = "PoisonError"; // classified as poison by the runner
  }
}
