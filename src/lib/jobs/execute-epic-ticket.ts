/**
 * ONE ticket of a run (anton-1lix — extracted from execute-epic.ts).
 *
 * The ticket phase of the formula walk: the steps this ticket runs, in formula order, and the
 * delivery-evidence gate that decides whether it is done. The run-level walk owns which tickets run
 * and in what order; this owns what happens inside one.
 *
 * What brackets the walk lives beside it (anton-owlx): the claim, session, clock and close in
 * execute-epic-ticket-bookends.ts, every way a ticket stops short in execute-epic-ticket-settle.ts
 * — with the judgement on a timed-out ticket's work in execute-epic-ticket-preserve.ts — and the
 * resilient claude driver its dispatching steps inherit in execute-epic-ticket-claude.ts.
 */
import type { Bead } from "../beads/bd";
import { formatAntonResult, type AntonOutcome } from "../claude/anton-result";
import { BlockedByAgentError, NeedsHumanError, NoDeliveryError } from "./execute-epic-errors";
import {
  claimTicket,
  finishTicket,
  narrowToTicket,
  openTicketSession,
  readTicketBaseline,
  startTicketBudget,
  warnBudgetRunningOut,
} from "./execute-epic-ticket-bookends";
import { resilientClaude } from "./execute-epic-ticket-claude";
import {
  selfReportSuffix,
  settleFailedTicket,
  type TicketProgress,
} from "./execute-epic-ticket-settle";
import type { ResolvedStep } from "./run-formula";
import type { StepContext, StepFacts } from "./step-registry";

/** One ticket: session → the formula's ticket phase (…→ commit) → close. */
export async function runTicket(args: {
  /** The run-level step context every ticket shares; this ticket's own is derived from it. */
  run: Omit<StepContext, "tickets">;
  /** The formula's ticket phase, in execution order — dispatched once per ticket (anton-lnkt). */
  steps: ResolvedStep[];
  ticket: Bead;
  operator?: string;
  /** Close the bead in beads once its work is committed. False for a standalone (epic-of-one)
   * target, which is never closed by execute-epic: it stays open + stage:in-review + PR ref until
   * its PR merges (review-fix's merge-finalize path closes it). On commit, a false value instead
   * moves the bead to stage:in-review — the resume marker + board state. Defaults to true (an
   * epic's children close as their work lands). */
  closeOnDone?: boolean;
  /**
   * Whether this ticket IS the whole run target (a childless run target — `beads.groupsChildren`
   * reads it as its own single ticket). Only the timeout path reads it, and only to decide whether
   * work it had to stop can be kept on the branch (anton-d967): with no sibling ticket, a timeout
   * here delivers nothing and the run parks, so there is no pull request the kept work could ride
   * into. Defaults to false — the conservative answer, which is the rollback.
   */
  standalone?: boolean;
  /** This ticket's wall-clock budget (anton-t1mo); `Infinity` leaves it unbounded. */
  timeoutMs: number;
}): Promise<void> {
  const { run, ticket, operator, timeoutMs } = args;
  const standalone = args.standalone ?? false;
  const { ctx, worktreePath } = run;
  const closeOnDone = args.closeOnDone ?? true;

  await claimTicket(run, ticket, operator);
  const session = await openTicketSession(run, ticket);
  const budget = startTicketBudget(ctx, timeoutMs, (remainingMs) =>
    warnBudgetRunningOut(session.logPath, ticket, timeoutMs, remainingMs),
  );
  const baseline = await readTicketBaseline(worktreePath);
  const ticketCtx = narrowToTicket(run, ticket, session, budget, baseline);
  const progress: TicketProgress = { committed: false, delivered: false, selfReport: null };

  try {
    await walkTicketSteps({ run, steps: args.steps, ticket, ticketCtx, session, progress });
    await finishTicket(run, ticket, session.sessionId, closeOnDone);
  } catch (e) {
    await settleFailedTicket({
      run,
      ticket,
      session,
      ranOutOfTime: budget.ranOutOfTime(),
      baseline,
      progress,
      timeoutMs,
      standalone,
      e,
    });
  } finally {
    budget.stop();
  }
}

/**
 * The ticket phase of the walk (anton-lnkt): the formula's steps up to and including its commit, in
 * formula order, each dispatched through the registry against THIS ticket. The walk replaces the
 * order these ran in, never the guards around them — the delivery-evidence gate below is still what
 * decides whether the ticket is done.
 */
async function walkTicketSteps(args: {
  run: Omit<StepContext, "tickets">;
  steps: ResolvedStep[];
  ticket: Bead;
  ticketCtx: StepContext;
  session: { sessionId: string; logPath: string };
  progress: TicketProgress;
}): Promise<void> {
  const { run, ticket, ticketCtx, session, progress } = args;
  const { db } = run;
  const { sessionId, logPath } = session;
  for (const { step: cooked, definition } of args.steps) {
    // Every step boundary is a lease checkpoint, exactly as every ticket boundary is.
    run.assertLeaseHeld?.();
    const result = await definition.handler({
      ...ticketCtx,
      step: cooked,
      // In-session resume for a transient mid-stream death (anton-juar) — the dispatch machinery
      // the step inherits from the run rather than a second driver of its own. On the TICKET's
      // context, so a resume is refused once this ticket's budget is spent, exactly as it is on a
      // job-level abort (resuming into a signal that is already aborted only burns the budget).
      deps: {
        runClaude: resilientClaude({
          db,
          ctx: ticketCtx.ctx,
          sessionId,
          logPath,
          ticket,
          stepId: cooked.id,
        }),
      },
    });
    // A `blocked` or `needs-human` self-report is STICKY across a phase with several dispatching
    // steps, by SEVERITY (see {@link selfReportRank}). A later agent — a `step:claude` the project
    // added after `implement` — reports on its own work only, so letting its `delivered` overwrite
    // an earlier block would close a ticket the implementer declared incomplete on the partial
    // changes it left behind. An ask still outranks an earlier block, because it names the exact
    // move a person owes; sticking on the block instead would drop it silently and settle the run
    // behind no gate at all (PR #205 review). A missing/unparseable line (null) keeps whatever the
    // phase reported before it, as it always has.
    const reported = result.facts?.selfReport;
    if (reported && selfReportRank(reported.outcome) >= selfReportRank(progress.selfReport?.outcome)) {
      progress.selfReport = reported;
    }

    // The agent asked for a HUMAN (anton-287p): the next step belongs to a person — a credential,
    // a dashboard click, a judgement call — not to another attempt. Judged HERE, at the step that
    // raised the ask, rather than at the ticket's exits: what a person owes is usually the very
    // thing the NEXT step needs, so a `verify` allowed to run would throw on the missing
    // credential/account and MASK the ask — the run would take the generic failure path and park
    // behind no gate at all. Judged before the delivery-evidence gate too, because an ask is
    // legitimate with or without a diff: the common shape is an agent that got as far as it could
    // and stopped, which that gate would file as a zero-diff false stall a human then has to
    // decode. Whatever partial work it left stays in the parked run's worktree, which the resume
    // continues in — uncommitted, since only a dispatching step can raise an ask and every one of
    // them precedes the ticket's commit. The run parks on a human gate carrying this ask instead
    // (see the run-level catch).
    if (progress.selfReport?.outcome === "needs-human") {
      throw new NeedsHumanError(ticket.id, progress.selfReport.reason);
    }

    if (definition.name !== "commit") {
      // A step that RAN and did not achieve its work halts the ticket (and, through it, the epic).
      // Verify gates and any other throwing step propagate untouched, so the runner's own
      // classification — quota → backoff, poison → park — still applies unchanged.
      if (!result.ok) {
        throw new Error(
          result.detail ?? `formula step "${cooked.id}" (step:${definition.name}) failed for ${ticket.id}`,
        );
      }
      continue;
    }
    assertDelivered(ticket, result.facts ?? {}, progress);
  }
}

/**
 * The commit is the ticket's evidence of record — honor the step's verdict on whether there is one,
 * and on whose work it is.
 *
 * A clean agent exit that leaves NO diff delivered nothing: the exact false-success in issue #46
 * (root cause #1). Do NOT close/advance the ticket on empty delivery. {@link NoDeliveryError} is
 * poison, so the runner parks the run for a human instead of retrying claude to the same empty
 * result forever, and the ticket's own catch BLOCKS the bead rather than re-queueing it open.
 */
export function assertDelivered(ticket: Bead, facts: StepFacts, progress: TicketProgress): void {
  const committed = facts.committed === true;
  // The TREE fact is recorded first and unconditionally — the timeout path reads it to know there
  // is a commit it must not reset off the branch, and that is true of a refused commit too. The
  // DELIVERY verdict is recorded at the bottom, once every gate below has accepted it (PR #228
  // review): a deadline that fires while this is refusing takes over the settlement, and it decides
  // what the board and the pull request are told from `delivered`, never from `committed`.
  progress.committed = committed;
  progress.delivered = false;
  const { selfReport } = progress;
  if (!committed) {
    // Empty tree: the delivery-evidence gate blocks + halts. Cross-check the self-report and
    // fold it into the reason (anton-j5i8): a `delivered` claim on an empty tree is the exact
    // false success the gate exists to catch; a `blocked` self-report corroborates the block and
    // carries the agent's own reason forward. A missing line just reads as the plain gate message.
    throw new NoDeliveryError(
      `${ticket.id} produced no delivery: claude exited cleanly and passed the verify gates but ` +
        `left no changes to commit (zero diff). Blocking the ticket for operator review and ` +
        `halting the epic — nothing landed, so closing it would be a false success.` +
        selfReportSuffix(selfReport),
    );
  }
  // Commit evidence exists, but the agent SELF-REPORTED blocked (anton-j5i8): it is telling us
  // the ticket is not actually done. Honor that honest signal — block the ticket for a human
  // rather than closing it on a partial change. This is NOT a self-report-alone failure (out of
  // scope): there IS commit evidence; we surface the contradiction (work committed + agent-declared
  // block) so the partial work isn't lost and a human decides. A `delivered`/missing self-report
  // with a real commit is the normal path and proceeds to close/in-review below.
  if (selfReport?.outcome === "blocked") {
    throw new BlockedByAgentError(
      `${ticket.id} was self-reported blocked by the agent (${formatAntonResult(selfReport)}) even ` +
        `though it committed changes. Blocking the ticket for operator review and halting the epic — ` +
        `the agent declared the work incomplete, so closing it would be a false success.`,
    );
  }
  // The evidence is a PREVIOUS attempt's preserved `WIP` commit and this run's agent never said the
  // ticket was finished (PR #228 review). That commit is explicitly incomplete — it was kept only
  // so a timed-out attempt's work would survive — so a zero diff plus a missing or unparseable
  // `ANTON-RESULT` is not delivery: nobody has claimed the work is done, and adopting it here ships
  // it under a PR that lists the ticket as delivered. The same zero-diff agent outcome blocks any
  // other ticket, and the presence of work someone else preserved is no reason to treat it as more
  // finished than it says it is.
  if (facts.preservedAdoption && selfReport?.outcome !== "delivered") {
    throw new NoDeliveryError(
      `${ticket.id} produced no delivery: claude left no changes to commit (zero diff) and no ` +
        `\`ANTON-RESULT\` from this run says the ticket is finished, so the only work on the branch ` +
        `is the explicitly incomplete commit a previous attempt PRESERVED when it ran out of time. ` +
        `Blocking the ticket for operator ` +
        `review and halting the epic — nothing this run did says that work is finished, so ` +
        `adopting it as the delivery would be a false success. Finish it by hand or resume the run ` +
        `with a raised ticketTimeoutMinutes.`,
    );
  }
  progress.delivered = true;
}

/**
 * How much a self-report OUTRANKS the one a phase already carries. A phase of several dispatching
 * steps keeps the most severe report any of them made, and severity is how actionable it is: an ask
 * names the one move a person owes, a block names a defect to diagnose, and `delivered` is a claim
 * a later step cannot make on an earlier step's behalf. An absent report (null) ranks below all
 * three, so the first step to say anything sets the phase's report.
 */
function selfReportRank(outcome: AntonOutcome | undefined): number {
  switch (outcome) {
    case "needs-human":
      return 2;
    case "blocked":
      return 1;
    case "delivered":
      return 0;
    default:
      return -1;
  }
}
