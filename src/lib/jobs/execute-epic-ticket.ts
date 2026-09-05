/**
 * ONE ticket of a run (anton-1lix — extracted from execute-epic.ts).
 *
 * The ticket phase of the formula walk, plus everything that only a ticket has: its own wall-clock
 * budget and the rollback that keeps the NEXT ticket's commit honest, the in-session claude resume,
 * and the note a blocked ticket leaves for the operator. The run-level walk owns which tickets run
 * and in what order; this owns what happens inside one.
 */
import { beads, labelValueOf, LABELS, type Bead } from "../beads/bd";
import { formatAntonResult, type AntonOutcome, type AntonResult } from "../claude/anton-result";
import { runClaude, type ClaudeResult, type RunClaudeOptions } from "../claude/driver";
import { shadowNote } from "../gardener/repair";
import {
  refusalNote as depRefusalNote,
  repairDepMissing,
  type DepMissingOutcome,
} from "../gardener/repair-dep-missing";
import { refusalNote, repairRefStale, type RefStaleOutcome } from "../gardener/repair-ref-stale";
import {
  commitAll,
  commitMarker,
  isAncestor,
  preservedCommitPrefix,
  readWorktreeState,
  restoreWorktreeState,
  sameWorktreeState,
  worktreeHasPreservedCommitFor,
  type WorktreeState,
} from "../git/ops";
import { resolveRepairAutonomy, resolveVerifyGates } from "../projects";
import { updateRun } from "../runs";
import {
  appendSessionLog,
  endSession,
  setSessionClaudeId,
  startJobSession,
} from "../sessions";
import { isRecoverableClaudeError, isUsageLimitError, PoisonEpic } from "./errors";
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
import type { AntonDb } from "./queue";
import type { JobContext } from "./runner";
import type { ResolvedStep } from "./run-formula";
import { runVerifyGates } from "./shell";
import { truncateField, type StepContext, type StepFacts } from "./step-registry";

/** This ticket's own wall clock (anton-t1mo) — the deadline, and the abort the two of them share. */
interface TicketBudget {
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

/** What the step walk learned — read by the close, and by every path that stops the ticket. */
export interface TicketProgress {
  /**
   * Whether the commit step reported real evidence on the branch. This is a fact about the TREE,
   * not a verdict: it is what stops the timeout path from resetting a commit off the branch, so it
   * is recorded even when the delivery gate then refuses that commit.
   */
  committed: boolean;
  /**
   * Whether that evidence is THIS ticket's delivery (PR #228 review) — `committed` AND every
   * delivery gate in {@link assertDelivered} accepted it. The two part company exactly where the
   * gate refuses a commit that exists: a previous attempt's adopted `WIP` this run never affirmed,
   * or work the agent itself declared blocked. Settlement reads THIS one, because a refused commit
   * owes the board the `not-delivered` marker and belongs in no pull request's delivered list —
   * `committed` alone would let a deadline landing on the refusal ship it as finished.
   */
  delivered: boolean;
  /**
   * The agent's machine-readable self-report (anton-j5i8) — `delivered`, `blocked — <reason>` or an
   * ask — already recorded on the session log by the dispatching step. It CORROBORATES the
   * delivery-evidence gate, never replaces it; a missing/unparseable line (null) falls through to it.
   */
  selfReport: AntonResult | null;
}

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
  // Snapshot the tree BEFORE any step runs, so the timeout path can put back exactly what this
  // ticket found. Everything committed at this point belongs to earlier tickets; the delta a
  // timeout leaves behind is this ticket's alone — which is what makes rolling it back safe, and
  // what stops half-finished work from being swept into the NEXT ticket's commit.
  // Read unconditionally, because two steps of the ticket need it and only one of them is the
  // timeout: `step:commit` compares HEAD against this baseline to tell an agent that changed
  // nothing from one that committed its own work (anton-8t1f), and that question is asked on every
  // ticket, not just the ones running under a deadline.
  //
  // Best-effort either way: an unreadable baseline costs the rollback, not the timeout — the ticket
  // is still stopped and blocked, and the run reports that its partial work had to be left in
  // place. `step:commit` likewise falls back to reading the index alone.
  const baseline = await readWorktreeState(worktreePath).catch(() => null);
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
      budget,
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
 * Claim the ticket for the operator as a HARD GATE before doing any work, and clear any verdict a
 * previous run left on it.
 */
async function claimTicket(
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
  try {
    await beads.claim(repo, ticket.id, operator);
  } catch (e) {
    throw new Error(
      `refusing to execute ${ticket.id}: could not claim it for ${operator ?? "this operator"} ` +
        `— already claimed by another operator, or the beads DB is locked ` +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
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
      // Same restore the retryable-failure path below performs, for the same reason.
      await safe(() => beads.setStatus(repo, ticket.id, "open"));
      await safe(() => beads.unassign(repo, ticket.id));
      await safe(() => beads.untag(repo, ticket.id, [LABELS.stage("implementing")]));
      throw new PoisonEpic(
        `${ticket.id} carries \`${LABELS.notDelivered}\` from a previous run but bd would not ` +
          `clear it — running this ticket and opening a pull request would make merge ` +
          `finalization treat delivered work as undelivered. Check the beads DB, then resume the run`,
      );
    }
  }
  void beads
    .sync(repo)
    .catch((e) => console.error(`[execute-epic] claim sync failed for ${ticket.id}`, e));
}

/** Open this ticket's session and make it the job's live handle. */
async function openTicketSession(
  run: Omit<StepContext, "tickets">,
  ticket: Bead,
): Promise<Awaited<ReturnType<typeof startJobSession>>> {
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
function startTicketBudget(
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
  const warning =
    bounded && onWarning
      ? setTimeout(() => onWarning(timeoutMs - warnAt), warnAt)
      : null;
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
 * This ticket's step context: the run's, narrowed to this ticket. The session is opened by the
 * caller and handed in, so one session still covers the whole ticket — dispatch, gates and commit.
 * The claude driver is built per step by the walk, so a resumed session is told which step it is
 * continuing.
 */
function narrowToTicket(
  run: Omit<StepContext, "tickets">,
  ticket: Bead,
  session: Awaited<ReturnType<typeof startJobSession>>,
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
  session: Awaited<ReturnType<typeof startJobSession>>;
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

/** Persist this ticket's "code done" state the moment it commits. */
async function finishTicket(
  run: Omit<StepContext, "tickets">,
  ticket: Bead,
  sessionId: string,
  closeOnDone: boolean,
): Promise<void> {
  const { db, clock } = run;
  const repo = run.repoPath;
  // Persist this ticket's "code done" state the moment it commits. An epic child closes (stage
  // → done). A standalone target isn't closed until its PR merges, so instead move it to
  // stage:in-review here (dropping implementing): that is both its board state and the persisted
  // resume marker, so a retry after a failed PR step skips it rather than re-running claude on
  // committed work. endSession still records the work done either way.
  if (closeOnDone) {
    await safe(() => beads.close(repo, ticket.id));
  } else {
    await safe(() => beads.tag(repo, ticket.id, [LABELS.stage("in-review")]));
    await safe(() => beads.untag(repo, ticket.id, [LABELS.stage("implementing")]));
  }
  await endSession(db, clock, sessionId, "done");
}

/** Every way a ticket stops short, and what each owes the board. Always throws. */
async function settleFailedTicket(args: {
  run: Omit<StepContext, "tickets">;
  ticket: Bead;
  session: Awaited<ReturnType<typeof startJobSession>>;
  budget: TicketBudget;
  baseline: WorktreeState | null;
  progress: TicketProgress;
  timeoutMs: number;
  standalone: boolean;
  e: unknown;
}): Promise<never> {
  const { run, ticket, session, budget, baseline, progress, timeoutMs, standalone, e } = args;
  const { db, clock } = run;
  const { sessionId, logPath } = session;
  const ranOutOfTime = budget.ranOutOfTime();
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
  await settleTicketTimeout({
    run,
    ticket,
    session,
    baseline,
    progress,
    timeoutMs,
    standalone,
    ranOutOfTime,
  });
  await settleAbortedTicket({ run, ticket, session, e });
  // Attempted only AFTER the abort path has had its say: a ticket someone killed or abandoned is
  // settled by whoever stopped it, and repairing its bead would write to a board a human is deciding
  // on. Before the release, because what the repair answers decides whether this bead is left
  // `blocked` for a person or `open` for the retry it just earned.
  const repair = await repairBlockedTicket({ run, ticket, session, progress, e, kinds });
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

/** What the repair pass answers, whichever class it ran for. */
type TicketRepair = RefStaleOutcome | DepMissingOutcome;

/**
 * The FACTUAL repair pass on a blocked ticket (anton-fzas, anton-qg4h / R5.4) — the two repairs that
 * invent nothing: a pointer rewritten to what it already meant, and an ordering that already exists
 * in reality written down.
 *
 * Runs on the two block kinds that mean "the agent could not do the work": a zero-diff run
 * ({@link NoDeliveryError}), and one the agent itself declared incomplete
 * ({@link BlockedByAgentError}). It runs on no other failure — not on an ask (that is a person's to
 * answer), not on a usage-limit park (not a failure at all), and not on any step failure that is
 * neither of those two: a run that fell over in review, commit or PR stopped on something the
 * bead's pointers and edges cannot explain.
 *
 * COMMITTED WORK IS NOT EXCLUDED, and that is deliberate (PR #223 review). `BlockedByAgentError` is
 * raised precisely when the tree DID commit and the agent still reported `blocked` — a partial
 * change plus an honest "this is not done". The block is the agent's own report, so what the repairs
 * answer is unchanged by the diff: a `dep-missing` report naming a prerequisite still means the rest
 * of the work cannot start until it lands, and a cited path that has moved is still stale whether or
 * not something was committed against the old one. What the commit changes is the ticket's fate, and
 * that is settled elsewhere — the bead is blocked for a human either way.
 *
 * WHICH REPAIR RUNS is decided by the agent's classified report (anton-ie05 / R5.1), and only
 * `dep-missing` needs it: no fact about the bead can tell anton that other work has to land first,
 * so that class is the whole trigger — and being unable to check it is exactly why the repair writes
 * nothing it cannot resolve against the board.
 *
 * `ref-stale` keeps running on EVERY other block, class or none. Its trigger is evidence rather than
 * the agent's word — the bead's cited paths are checked against the worktree, so it fires only where
 * a pointer is provably stale and stays silent (`none`) everywhere else. That is strictly narrower
 * than trusting a self-reported class, so narrowing it to one would only lose repairs. The cost is
 * an audit trail that can read oddly (PR #223 review): a bead blocked on, say, `env` that ALSO
 * cites a moved path gets its pointer fixed and stamped `repair:ref-stale`, on a run whose block was
 * something else. The stamp is honest about what anton did — it rewrote a genuinely stale pointer —
 * and the loop guard still holds, because the next block finds that stamp and escalates rather than
 * repairing again.
 *
 * HOW FAR EITHER MAY GO is the project's call, not this function's (R5.3): each class carries its
 * own autonomy level, and the guard consults it before anything is written (`decideRepair`). Shipped
 * at `shadow`, so a project that has armed nothing gets the repair worked out and RECORDED — on the
 * bead and in the session log — while the block escalates to a human exactly as it did before this
 * feature existed. A shadowed repair is therefore not a repair: it leaves the ticket to the ordinary
 * failure path below, which blocks the bead.
 *
 * Best-effort by construction: a repair that throws must never mask the block the run is settling.
 * The block still stands; only the repair is lost.
 */
async function repairBlockedTicket(args: {
  run: Omit<StepContext, "tickets">;
  ticket: Bead;
  session: Awaited<ReturnType<typeof startJobSession>>;
  progress: TicketProgress;
  e: unknown;
  kinds: TicketFailureKinds;
}): Promise<TicketRepair | undefined> {
  const { run, ticket, session, e, kinds } = args;
  const { clock, worktreePath } = run;
  const repo = run.repoPath;
  if (isUsageLimitError(e) || kinds.needsHuman) return undefined;
  if (!kinds.noDelivery && !kinds.agentBlocked) return undefined;
  const selfReport = args.progress.selfReport;
  const klass = selfReport?.outcome === "blocked" ? selfReport.klass : undefined;
  const autonomy = resolveRepairAutonomy(run.settings);
  try {
    // One instant for whichever repair runs — the arms are mutually exclusive, and the stamp is
    // what the breaker orders a later failure against.
    const now = clock.now();
    // Read the bead fresh: the snapshot this run dispatched from predates the session, and the
    // repair rewrites the description — or the edges — it is holding.
    const fresh = await beads.show(repo, ticket.id);
    // The self-report's reason FIRST for both repairs, and it is load-bearing for `dep-missing`:
    // the prerequisite is named in the agent's own prose, and the run's error message names none.
    const block = {
      reason: selfReport?.reason ?? (e instanceof Error ? e.message : undefined),
    };
    if (klass === "dep-missing") {
      const outcome = await repairDepMissing({
        repoPath: repo,
        bead: fresh,
        block,
        now,
        autonomy: autonomy["dep-missing"],
      });
      if (outcome.action === "escalate") {
        await safe(() => beads.note(repo, ticket.id, depRefusalNote(outcome)));
      } else if (outcome.action === "shadow") {
        await safe(() => beads.note(repo, ticket.id, shadowNote("dep-missing", outcome.attempted)));
      }
      await appendSessionLog(
        session.logPath,
        `[repair:dep-missing] ${repairLogLine(outcome)}\n`,
      ).catch(() => {});
      return outcome;
    }
    const outcome = await repairRefStale({
      repoPath: repo,
      worktreePath,
      bead: fresh,
      block,
      now,
      autonomy: autonomy["ref-stale"],
    });
    if (outcome.action === "escalate") {
      await safe(() => beads.note(repo, ticket.id, refusalNote(outcome)));
    } else if (outcome.action === "shadow") {
      await safe(() => beads.note(repo, ticket.id, shadowNote("ref-stale", outcome.attempted)));
    }
    await appendSessionLog(session.logPath, `[repair:ref-stale] ${repairLogLine(outcome)}\n`).catch(
      () => {},
    );
    return outcome;
  } catch (failure) {
    // The MODULE that ran and the block CLASS it ran on are two different facts (PR #223 review).
    // Every non-`dep-missing` block falls through to `ref-stale`, so naming the class alone reads as
    // if an `env` repair existed and threw, rather than that `ref-stale` refused an `env` block.
    const repair = klass === "dep-missing" ? "dep-missing" : "ref-stale";
    console.error(
      `[execute-epic] ${repair} repair failed for ${ticket.id} (block class: ${klass ?? "unclassified"})`,
      failure,
    );
    return undefined;
  }
}

/** One line of the repair's own account, for the session log. */
function repairLogLine(outcome: TicketRepair): string {
  switch (outcome.action) {
    case "repaired":
      return `repaired — ${outcome.attempted}`;
    case "parked":
      return `parked — ${outcome.attempted}`;
    case "shadow":
      // The one line an operator reads a week of shadow off, so it says what the write WOULD have
      // been, not merely that one was withheld.
      return `shadow (not armed to write) — would have: ${outcome.attempted}`;
    case "escalate":
      return `escalated — ${[outcome.why, ...outcome.evidence].join(" ")}`;
    // Named rather than left to `default`, so a future outcome shape without a `why` is a type error
    // HERE instead of an `undefined` in the log line (PR #223 review).
    case "none":
      return `no repair — ${outcome.why}`;
  }
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

/**
 * OUT OF TIME (anton-t1mo) — settled FIRST, because this ticket's signal is aborted on this path too
 * and every later check would read it as an operator's kill. This abort has a known author (anton)
 * and a known remedy, so unlike a kill it settles the ticket here: get the ticket's work out of the
 * worktree one way or the other, block the bead with the reason, and let the caller carry on with
 * the next ticket.
 *
 * Emptying the tree is the half that keeps the REST of the run honest. A ticket stopped mid-edit
 * leaves a dirty tree, and the next ticket's commit step would sweep those changes up as its own —
 * the feature's history then attributes work to a ticket that never did it, and unreviewed half-work
 * rides into the PR under someone else's name.
 *
 * There are two ways to empty it (anton-d967). Where the ticket IS the whole run target and its
 * tree passes this project's verify gates, the work is committed to the run's branch under an
 * explicitly-incomplete subject and KEPT — a ticket cut off during its closing bookkeeping has
 * typically finished the change, and deleting it is the loss this exists to stop. Everything else
 * is rolled back, exactly as before. {@link preserveTimedOutWork} owns that judgement and the
 * reason it reports back is what the bead note tells the operator.
 *
 * Keeping is at least as safe as rolling back for the property that matters: either way the tree is
 * re-read afterwards and must come back clean, and the kept diff sits in a commit of its own rather
 * than in another ticket's. It is NOT a delivery — the bead stays blocked and marked
 * `not-delivered`, so no PR body lists it and no merge closes it.
 *
 * Returns when the budget was NOT what stopped this ticket — and when the JOB's own abort landed
 * while this was deciding, which outranks the timeout and leaves the ticket to the abort path
 * below; otherwise it always throws.
 */
export async function settleTicketTimeout(args: {
  run: Omit<StepContext, "tickets">;
  ticket: Bead;
  /** The ticket's open session — only its log is written here. */
  session: { logPath: string };
  baseline: WorktreeState | null;
  progress: TicketProgress;
  timeoutMs: number;
  standalone: boolean;
  ranOutOfTime: boolean;
}): Promise<void> {
  const { run, ticket, session, baseline, timeoutMs, standalone, ranOutOfTime } = args;
  const { ctx, worktreePath } = run;
  const repo = run.repoPath;
  const { logPath } = session;
  // Two different questions, and the deadline can land between their answers (PR #228 review).
  // `committed` protects the TREE — never reset a branch that carries a commit. `delivered` is the
  // VERDICT the board and the pull request are entitled to, and a commit the delivery gate refused
  // has none: read that way, a timeout arriving while `assertDelivered` refuses would mask the
  // refusal, skip the `not-delivered` marker and list explicitly unfinished work as shipped.
  const { committed, delivered } = args.progress;
  // `!ctx.signal.aborted` breaks the tie when both fired: an operator's kill outranks the budget,
  // and the abort path is the one that writes nothing to a board a human is deciding on.
  if (ranOutOfTime && !ctx.signal.aborted) {
    await appendSessionLog(
      logPath,
      `[ticket-timeout] ${ticket.id} exceeded its ${Math.round(timeoutMs / 60_000)}m budget\n`,
    ).catch(() => {});
    // Keep the work if it can be proven fit to keep; only what cannot be is rolled back.
    const kept = await preserveTimedOutWork({
      run,
      ticket,
      logPath,
      baseline,
      committed,
      timeoutMs,
      standalone,
    });
    // The job's abort landed while the preserve was deciding, and it outranks this timeout: nothing
    // was kept, nothing is rolled back, and nothing goes to the board. Return so the abort path
    // below settles the ticket the way whoever stopped the run intends.
    if ("jobAborted" in kept) return;
    // A FRESH preserve is the only outcome that moved the branch; everything else — an attempt that
    // wrote nothing, and a refusal whose rollback keeps a previous attempt's commit — leaves what is
    // on the branch to a previous attempt, and the operator is owed that either way.
    const fresh = "branch" in kept && !kept.retained;
    const preservedOn = "branch" in kept ? kept.branch : kept.retainedOn;
    const retained = preservedOn !== null && !fresh;
    // Both routes answer the SAME question — is anything of this ticket still loose in the tree —
    // and neither is trusted to have worked. A FRESH preserve re-reads the tree from scratch (`null`
    // baseline: dirt is dirt, whatever it was before), because the commit it just made moved the
    // tree away from the baseline the rollback compares against. Everything else takes the ordinary
    // rollback — which restores a baseline any preserved commit is already part of, keeping it on
    // the branch while clearing anything loose.
    const leftovers = fresh
      ? await leftChangesBehind(worktreePath, null)
      : await rollbackTimedOutTicket(worktreePath, baseline, committed);
    // Asked AGAIN, because the tree read above is the last await between the preserve's own abort
    // check and the first board write (PR #228 review). A kill that lands in that window is still a
    // kill: the ordinary abort path writes nothing to a board a human is deciding on, and the
    // timeout's status/assignee/label/note would be a write it never authorised. The worktree work
    // is already settled either way — kept or rolled back — so there is nothing left to lose by
    // handing the ticket to the abort path below.
    if (ctx.signal.aborted) return;
    const marked = await blockTimedOutTicket({
      repo,
      ticket,
      worktreePath,
      timeoutMs,
      committed,
      delivered,
      leftovers,
      preservedOn,
      retained,
      ...("rolledBackWhy" in kept ? { rolledBackWhy: kept.rolledBackWhy } : {}),
    });
    // Emptying the tree is what keeps the REST of the run honest, so its failure cannot be absorbed
    // the way the timeout itself is: the next ticket captures its baseline from this same tree
    // and would commit these leftovers under its own name. The bead note can't prevent that —
    // nothing pauses the run, so the wrong commit lands long before an operator reads it. Halt
    // instead (poison → park) and let a human clear the tree before anything else commits.
    if (leftovers) {
      throw new WorktreeDirtyError(
        `${ticket.id} exceeded its ${Math.round(timeoutMs / 60_000)}m ticket budget and its ` +
          `partial work could NOT be ` +
          `${fresh ? "fully committed" : "rolled back"} — the ` +
          `run's worktree (${worktreePath}) still carries changes that the next ticket would ` +
          `commit as its own, so the run stopped here. Clear the worktree by hand, then resume ` +
          `the run`,
      );
    }
    // Same reasoning one step further out: this ticket is in no PR's delivered list — preserved or
    // not — and without the marker the merge of the PR carrying the REST of the feature closes it
    // as shipped. The bead note can't prevent that — finalization reads labels, not prose — so halt
    // instead of absorbing this timeout and walking on toward a PR that would swallow the ticket.
    if (!marked) {
      throw new PoisonEpic(
        `${ticket.id} exceeded its ${Math.round(timeoutMs / 60_000)}m ticket budget and its ` +
          `partial work was ${workFate(preservedOn, retained, committed && !delivered)}, ` +
          `but bd would not record \`${LABELS.notDelivered}\` on it — the run stopped rather than ` +
          `carry on to a pull request whose merge would close this undelivered ticket as shipped. ` +
          `Check the beads DB, then resume the run`,
      );
    }
    throw new TicketTimeoutError(ticket.id, timeoutMs, delivered, preservedOn);
  }
}

/**
 * What became of a timed-out ticket's work, in one phrase for an operator reading a halt. The
 * retained state is the one a flat preserved/rolled-back pair cannot say (PR #228 review): this
 * attempt kept nothing of its own, but a previous one's commit is still on the branch and the resume
 * continues from it rather than starting over.
 */
function workFate(preservedOn: string | null, retained: boolean, refusedCommit: boolean): string {
  // A commit the delivery gate refused is the third state (PR #228 review): nothing was rolled back
  // — the branch still carries it — but nobody delivered it either.
  if (refusedCommit) return "left in a commit this run's delivery gate REFUSED";
  if (!preservedOn) return "rolled back";
  return retained
    ? `rolled back onto the work a previous attempt PRESERVED on \`${preservedOn}\``
    : `preserved on \`${preservedOn}\``;
}

/**
 * The share of a ticket's own budget the preserve is allowed to spend re-running the verify gates,
 * and the floor/ceiling it is clamped to. The ticket is already over time, so this cannot be
 * unbounded — but a gate that never gets to finish can never keep anything either.
 */
const PRESERVE_VERIFY_SHARE = 0.25;
const PRESERVE_VERIFY_MIN_MS = 60_000;
const PRESERVE_VERIFY_MAX_MS = 15 * 60_000;

/**
 * What became of a timed-out ticket's uncommitted work: kept on a branch, rolled back and why, or
 * nothing at all because the JOB was aborted while the preserve was deciding.
 *
 * `retained` separates the two ways work ends up kept. A fresh preserve COMMITTED this attempt's
 * tree; a retained one only reports what a previous attempt already preserved and this one did not
 * touch — the caller still rolls that tree back (the reset restores a baseline the commit is part
 * of), but the operator is owed the truth that the work is still on the branch.
 *
 * `retainedOn` carries that same truth through a REFUSAL (PR #228 review): a resume can start from a
 * previous attempt's preserved commit, write more, and have the additions rejected — the rollback
 * then drops only the additions, and reporting a bare rollback would tell the operator work that is
 * still on the branch was thrown away.
 */
type PreservedWork =
  | { branch: string; retained: boolean }
  | { rolledBackWhy: string; retainedOn: string | null }
  | { jobAborted: true };

/**
 * Keep a timed-out ticket's work when it can be PROVEN fit to keep (anton-d967) — the branch it was
 * committed to, or the reason the run had to fall back to the rollback.
 *
 * The loss this exists to stop: a ticket that implemented, tested and verified its change and was
 * cut off during its closing bookkeeping had all of it deleted, from a tree no commit, reflog or
 * dangling object could recover it from. What proves the work fit is the project's OWN verify gates
 * — the same commands `step:verify` runs before any ordinary commit — so nothing is kept here that
 * anton would not have committed anyway.
 *
 * ONLY A CHILDLESS RUN TARGET may keep it, and that limit is the whole safety argument. Those gates
 * prove the tree is not BROKEN; they cannot prove the ticket is DONE, and half-work usually passes
 * them (a module nothing imports yet compiles and lints fine — and on a multi-ticket run they mostly
 * re-measure the siblings that already committed). On a run with other tickets, that unfinished diff
 * would ride into the pull request they open and be merged into the trunk under a delivery it is no
 * part of — the exact harm the rollback was written for. When the ticket IS the run target, the
 * timeout leaves the run with nothing delivered, so it parks: no pull request exists to carry the
 * work anywhere, it simply waits on the branch for the resume that continues it. That is the case
 * that lost two hours of finished work on 2026-08-17, and it is the one this keeps.
 *
 * Every refusal below falls back to the rollback rather than improvising, because the caller's
 * safety property is absolute and each of these is a case where "this diff is this ticket's, it is
 * sound, and nothing else will carry it" cannot be shown:
 *
 * - the ticket already committed — there is nothing loose to keep;
 * - the run has other tickets — see above;
 * - the JOB was aborted while the gates ran, or while the commit itself was being made — that abort
 *   outranks the timeout, so this reports it rather than a verdict, and the caller hands the work
 *   and the bead to whoever stopped the run;
 * - no baseline was readable — the delta in the tree cannot be attributed to this ticket at all;
 * - the tree is unchanged — there is nothing to keep, and the rollback is a no-op;
 * - HEAD left the run's branch, or the branch no longer contains where the ticket started — the
 *   same two states `step:commit` refuses to adopt (a stray checkout, a reset/amend/rebase), and
 *   the rollback is what puts the run back on its branch;
 * - the project pins NO verify gates — nothing can prove the tree sound, so the pre-anton-d967
 *   behaviour stands;
 * - the gates fail, error, or outrun their own budget — the tree is not fit to keep;
 * - git refuses the commit outright, or `git add -A` finds nothing to commit AND HEAD never moved —
 *   either way nothing was preserved, and the reason says which. An empty index with a HEAD that
 *   DID move is not that case: the agent committed its own work, and {@link adoptSelfCommittedWork}
 *   keeps it.
 */
export async function preserveTimedOutWork(args: {
  run: Omit<StepContext, "tickets">;
  ticket: Bead;
  logPath: string;
  baseline: WorktreeState | null;
  committed: boolean;
  timeoutMs: number;
  standalone: boolean;
}): Promise<PreservedWork> {
  const { run, ticket, logPath, baseline, committed, timeoutMs, standalone } = args;
  const { worktreePath, branch, settings } = run;
  // What a PREVIOUS attempt already preserved, read once below and carried by every refusal after
  // it: the rollback a refusal asks for restores the baseline, which on a resume that started from
  // that commit still contains it.
  let retainedOn: string | null = null;
  const rollBack = async (why: string): Promise<PreservedWork> => {
    await logPreserve(
      logPath,
      `rolling back — ${why}` +
        (retainedOn ? ` (a previous attempt's work stays on ${retainedOn})` : ``),
    );
    return { rolledBackWhy: why, retainedOn };
  };
  if (committed) return { rolledBackWhy: "its work was already committed", retainedOn };
  if (!baseline) {
    return rollBack(`anton could not read the worktree this ticket started from`);
  }

  const now = await readWorktreeState(worktreePath).catch(() => null);
  if (!now) return rollBack(`anton could not read the worktree back`);
  // "Nothing kept" is a verdict on THIS attempt, never on the branch (PR #228 review). A resume that
  // starts from a previous attempt's preserved commit leaves it wherever the ticket ends — untouched
  // if nothing was written, and still there if what was written gets refused below, since the
  // rollback restores a baseline the commit is part of. Read once, here, so every answer past this
  // point tells the operator the truth about the branch; without it the bead note and the park say
  // the work is gone and the next resume starts over, when in fact it continues from that commit.
  // Only while HEAD is on the run's branch: off it, anton cannot say what the rollback puts back.
  if (
    now.ref === `refs/heads/${branch}` &&
    (await worktreeHasPreservedCommitFor(worktreePath, ticket.id))
  ) {
    retainedOn = branch;
  }
  // Asked before the sibling check below, so a ticket that left nothing is never told the reason it
  // could not keep work it never wrote.
  if (sameWorktreeState(now, baseline)) {
    if (retainedOn) {
      await logPreserve(
        logPath,
        `left the tree untouched — a previous attempt's work is still on ${retainedOn}`,
      );
      return { branch: retainedOn, retained: true };
    }
    return { rolledBackWhy: "it left nothing in the worktree", retainedOn };
  }
  if (!standalone) {
    return rollBack(
      `this run has other tickets, and the pull request they open would carry this ticket's ` +
        `unfinished work into the trunk under a delivery it is no part of`,
    );
  }
  if (now.ref !== `refs/heads/${branch}` || !(await stillContains(worktreePath, baseline, now))) {
    return rollBack(
      `it left the run's branch (${branch}) rewritten or checked out elsewhere, so anton could ` +
        `not tell its changes apart from the rest of the tree`,
    );
  }

  const gates = resolveVerifyGates(settings);
  if (gates.length === 0) {
    return rollBack(`this project pins no verify gates, so nothing can show the work is sound`);
  }

  // The gates get a clock of their own, derived from the JOB's signal rather than the ticket's:
  // the ticket's is already aborted, so a gate started on it would be killed before it spawned.
  const gateBudget = startTicketBudget(run.ctx, preserveVerifyMs(timeoutMs));
  await logPreserve(
    logPath,
    `re-running ${gates.length} verify gate(s) to decide whether the work can be kept`,
  );
  let gateFailure: { error: unknown } | null = null;
  try {
    await runVerifyGates(
      gates,
      worktreePath,
      gateBudget.signal,
      logPath,
      (gate, code) => `${gate.label} gate failed for ${ticket.id} (exit ${code})`,
    );
  } catch (error) {
    gateFailure = { error };
  } finally {
    gateBudget.stop();
  }
  // A job-level abort inside this window is NOT a failed gate (PR #228 review). The gates run on the
  // job's own signal — the only clock left once the ticket's is spent — so an operator's kill, a lost
  // lease or the runner's no-progress timeout arriving during a window of up to 15 minutes rejects
  // them exactly as a broken tree does. Read that way it would hard-reset the worktree to the
  // baseline and write the board, which is what the abort must NOT do: a job-level abort outranks the
  // ticket timeout, and the work and the board belong to whoever stopped the run. Asked before the
  // failure, so an abort is never read as a verdict on the tree.
  if (run.ctx.signal.aborted) {
    await logPreserve(
      logPath,
      `the job was aborted while the verify gates ran — leaving this ticket's work and its bead to ` +
        `whoever stopped the run`,
    );
    return { jobAborted: true };
  }
  if (gateFailure) {
    return rollBack(
      `it does not pass this project's verify gates ` +
        `(${gateFailure.error instanceof Error ? gateFailure.error.message : String(gateFailure.error)})`,
    );
  }

  // An empty index and a REFUSED commit are two different facts an operator repairs differently
  // (PR #228 review), so the error is carried rather than flattened into "nothing to commit": a
  // locked index, a rejecting pre-commit hook or a full disk is what they need to see, and the
  // rollback below is safe either way.
  const kept = await commitAll(worktreePath, preservedCommitMessage(ticket, timeoutMs)).catch(
    (error: unknown) => ({ committed: false as const, error }),
  );
  // The abort outranks the timeout on THIS side of the commit too (PR #228 review). `commitAll` runs
  // on no signal — a pre-commit hook can hold it for minutes — so an operator's kill, a lost lease or
  // the no-progress timeout can land here just as it can in the gate window above, and neither
  // outcome of the commit is a verdict once it has: a commit that landed simply stays on the branch,
  // and one that did not must not be read as "unfit" and rolled back. Reported as the abort so the
  // caller leaves the tree and the bead to whoever stopped the run.
  if (run.ctx.signal.aborted) {
    await logPreserve(
      logPath,
      kept.committed
        ? `committed this ticket's work on ${branch}, then found the job aborted — leaving it and ` +
            `the bead to whoever stopped the run`
        : `the job was aborted while committing this ticket's work — leaving the tree and the bead ` +
            `to whoever stopped the run`,
    );
    return { jobAborted: true };
  }
  if (!kept.committed) {
    if ("error" in kept) {
      return rollBack(
        `anton could not commit the work (${kept.error instanceof Error ? kept.error.message : String(kept.error)})`,
      );
    }
    // An empty index is not proof the ticket wrote nothing (PR #228 review). HEAD moved — and the
    // checks above already proved it moved FORWARD on the run's branch — so the agent committed its
    // own work, which is exactly what `step:commit` adopts rather than refuses. Rolling back here
    // would hard-reset that commit off the branch: the deletion of finished work this whole path
    // exists to stop, arriving through the one door that looks like an empty tree.
    if (now.head !== baseline.head) {
      return adoptSelfCommittedWork({
        worktreePath, branch, ticket, timeoutMs, logPath, alreadyMarked: retainedOn !== null,
      });
    }
    return rollBack(`there was nothing for git to commit`);
  }
  await logPreserve(logPath, `work PRESERVED on ${branch} as an explicitly incomplete commit`);
  return { branch, retained: false };
}

/**
 * The agent committed this ticket's work ITSELF and the deadline landed before `step:commit` could
 * record it (PR #228 review). Against the operating contract, but it happens — and `step:commit`
 * treats it as delivery for the same reason this must treat it as preserved: the commits are real,
 * they are on the run's branch, and here they have just passed the project's verify gates.
 *
 * The marker is what keeps that work FINDABLE. The agent's own subjects carry no `WIP <id>:` prefix,
 * so without one the resume's zero diff reads as "nothing landed" and parks the run one step from
 * the pull request it already earned. A marker that cannot be written is still no reason to roll
 * back — the work outranks its bookkeeping — so the failure is logged and the commits are kept.
 */
async function adoptSelfCommittedWork(args: {
  worktreePath: string;
  branch: string;
  ticket: Bead;
  timeoutMs: number;
  logPath: string;
  /** A previous attempt's marker is already on the branch; one is all a resume needs. */
  alreadyMarked: boolean;
}): Promise<PreservedWork> {
  const { worktreePath, branch, ticket, timeoutMs, logPath, alreadyMarked } = args;
  const marked =
    alreadyMarked ||
    (await safe(() =>
      commitMarker(worktreePath, preservedCommitMessage(ticket, timeoutMs, { marker: true })),
    ));
  await logPreserve(
    logPath,
    marked
      ? `the agent committed this ticket's work itself — KEPT on ${branch} rather than rolled back`
      : `the agent committed this ticket's work itself — KEPT on ${branch}, but anton could not ` +
          `record the marker a resume reads, so that resume may report a zero diff`,
  );
  return { branch, retained: false };
}

/** Whether the branch still CONTAINS where the ticket started — no reset, amend or rebase. */
function stillContains(
  worktreePath: string,
  baseline: WorktreeState,
  now: WorktreeState,
): Promise<boolean> {
  return isAncestor(worktreePath, baseline.head, now.head).catch(() => false);
}

/** How long the preserve may spend on the gates — a quarter of the ticket's own budget, clamped. */
function preserveVerifyMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return PRESERVE_VERIFY_MAX_MS;
  const share = timeoutMs * PRESERVE_VERIFY_SHARE;
  return Math.min(PRESERVE_VERIFY_MAX_MS, Math.max(PRESERVE_VERIFY_MIN_MS, share));
}

/** The preserve's own account, on the ticket's session log where the timeout line already is. */
async function logPreserve(logPath: string, line: string): Promise<void> {
  await appendSessionLog(logPath, `[ticket-timeout] ${line}\n`).catch(() => {});
}

/**
 * The subject of a preserved commit — deliberately NOT `<ticketId>:`, which is the delivery
 * attribution `worktreeHasCommitFor` reads. This commit is the opposite of a delivery: the
 * ticket is blocked, marked `not-delivered` and in no PR body, and a run that read this commit as
 * its work would close a ticket nobody finished.
 *
 * The resume still has to SEE it, or the work it kept can never reach a pull request — that read is
 * {@link worktreeHasPreservedCommitFor}, which `step:commit` asks before reporting a zero diff.
 */
function preservedCommitMessage(
  ticket: Bead,
  timeoutMs: number,
  options: { marker?: boolean } = {},
): string {
  return (
    `${preservedCommitPrefix(ticket.id)} ${ticket.title}\n\n` +
    `INCOMPLETE — the ticket exceeded its ${Math.round(timeoutMs / 60_000)}m budget and was ` +
    `stopped before it finished. anton kept this work rather than deleting it because the ` +
    `project's verify gates passed on the tree; the ticket itself is blocked for review and is in ` +
    `no pull request's delivered list. Resuming the run continues from this commit.` +
    (options.marker
      ? `\n\nThis commit is EMPTY: the agent committed the work itself, under subjects that name ` +
        `neither this ticket nor its incompleteness. Those commits are the work; this one records ` +
        `whose it is.`
      : ``)
  );
}

/**
 * The OPERATOR-facing record that precedes the deadline (anton-d967). It goes to the session log an
 * operator tails and to the run's own record; the running agent cannot read either — the driver
 * delivers its prompt on stdin and closes it (`writePrompt`), so there is no channel back into a
 * live session and this is no instruction to it. What actually saves finished work is
 * {@link preserveTimedOutWork}, after the deadline. This is what lets a person see the clock running
 * down in time to raise the budget or stop the run, instead of meeting the kill in the log.
 */
function warnBudgetRunningOut(
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
  /** Whether a commit exists on the branch — a fact about the tree, not a verdict on it. */
  committed: boolean;
  /** Whether that commit is this ticket's DELIVERY, i.e. every gate in `assertDelivered` took it. */
  delivered: boolean;
  leftovers: boolean;
  /** The branch its work was preserved on (anton-d967), or null when it was rolled back. */
  preservedOn: string | null;
  /**
   * Whether that preserved work is a PREVIOUS attempt's — this one either added nothing to the tree
   * or had what it added rolled back (`rolledBackWhy` tells the two apart).
   */
  retained?: boolean;
  /** Why the work could NOT be kept — the operator is owed the reason, not just the verdict. */
  rolledBackWhy?: string;
}): Promise<boolean> {
  const { repo, ticket, worktreePath, timeoutMs, committed, delivered, leftovers, preservedOn } =
    args;
  await safe(() => beads.setStatus(repo, ticket.id, "blocked"));
  await safe(() => beads.unassign(repo, ticket.id));
  await safe(() => beads.untag(repo, ticket.id, [LABELS.stage("implementing")]));
  // Not delivered ⇒ mark it, or merge finalization closes it as shipped when the rest of the feature
  // lands (anton-67xj). Both the rolled-back and the PRESERVED ticket are marked (anton-d967):
  // preserved work is on the branch but is nobody's delivery — the ticket is in no PR body and
  // nobody finished it, so a merge that closed it would file half a ticket as shipped. Only a ticket
  // stopped after a commit the delivery gate ACCEPTED goes unmarked — that work IS the diff a human
  // merges. A commit that gate REFUSED is marked like any other undelivered ticket (PR #228 review):
  // the deadline landing on the refusal does not turn work nobody affirmed into a delivery. The
  // marker is finalization's only input, so it is retried rather than best-effort; a run that still
  // cannot record it must not reach its PR (the caller escalates, once the note below is on the bead
  // — the operator needs the timeout's own account either way).
  const marked =
    delivered || (await mustPersist(() => beads.tag(repo, ticket.id, [LABELS.notDelivered])));
  await safe(() =>
    beads.note(
      repo,
      ticket.id,
      `anton: stopped after ${Math.round(timeoutMs / 60_000)}m — the ticket outlived its ` +
        `budget, so the run blocked it and carried on with the rest of the feature. ` +
        (committed
          ? delivered
            ? `Its work IS committed on the branch (it was stopped after the commit) — review it ` +
              `and close the ticket by hand if it is complete. `
            : // The commit is on the branch and stays there, but nothing affirmed it finished, so
              // the operator is owed both halves of that: the work is not lost, and it is also not
              // delivered — no pull request lists it and no merge will close it.
              `Its work IS committed on the branch, but this run's delivery gate REFUSED that ` +
              `commit as this ticket's delivery — it is NOT delivered and is in no pull request. ` +
              `Review the commit and finish the work, then close the ticket by hand. `
          : leftovers
            ? `Its partial work could NOT be ` +
              `${preservedOn && !args.retained ? "fully committed" : "rolled back"} ` +
              `and is STILL in the run's worktree (${worktreePath}), so the run stopped rather ` +
              `than let another ticket commit it — clear the worktree by hand before resuming. `
            : preservedOn
              ? (args.retained
                  ? (args.rolledBackWhy
                      ? `What this attempt added was rolled back (${args.rolledBackWhy}), but the ` +
                        `work a previous one PRESERVED on branch \`${preservedOn}\` is still there ` +
                        `as an explicitly incomplete commit `
                      : `This attempt added nothing to the tree, and the work a previous one ` +
                        `PRESERVED on branch \`${preservedOn}\` is still there as an explicitly ` +
                        `incomplete commit `)
                  : `Its work passed this project's verify gates, so it was PRESERVED on branch ` +
                    `\`${preservedOn}\` as an explicitly incomplete commit rather than deleted `) +
                `— it is NOT delivered and is in no pull request, and resuming the run on this ` +
                `machine continues from that commit instead of redoing the work (a run branch is ` +
                `pushed only at its pull request, so a resume elsewhere starts the ticket over). `
              : `Its partial work was rolled back (nothing from it is on the branch)` +
                (args.rolledBackWhy ? ` — ${args.rolledBackWhy}` : ``) +
                `. `) +
        `Split it into smaller tickets, or raise ticketTimeoutMinutes, then resume the run`,
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
  session: Awaited<ReturnType<typeof startJobSession>>;
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
  session: Awaited<ReturnType<typeof startJobSession>>;
  progress: TicketProgress;
  e: unknown;
  kinds: TicketFailureKinds;
  /** What the factual repair pass answered, when it ran — see {@link repairBlockedTicket}. */
  repair?: TicketRepair;
}): Promise<void> {
  const { run, ticket, session, e } = args;
  const { worktreePath } = run;
  const repo = run.repoPath;
  const { sessionId } = session;
  const { committed, selfReport } = args.progress;
  const { noDelivery, agentBlocked, needsHuman } = args.kinds;
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
  const staysClaimable =
    args.repair?.action === "repaired" || args.repair?.action === "parked";
  if (!isUsageLimitError(e)) {
    if ((committed || noDelivery || agentBlocked) && !needsHuman && !staysClaimable) {
      await safe(() => beads.setStatus(repo, ticket.id, "blocked"));
      // The tip this ticket's work landed on — the operator's route from the note straight to the
      // diff. Best-effort and only when something was committed: an unreadable worktree costs the
      // sha, never the note.
      const head = committed
        ? await readWorktreeState(worktreePath)
            .then((s) => s.head)
            .catch(() => undefined)
        : undefined;
      await safe(() =>
        beads.note(
          repo,
          ticket.id,
          ticketBlockNote({
            kind: noDelivery ? "no-delivery" : agentBlocked ? "agent-blocked" : "post-commit",
            selfReport,
            error: e,
            sessionId,
            branch: run.branch,
            head,
          }),
        ),
      );
    } else {
      await safe(() => beads.setStatus(repo, ticket.id, "open"));
    }
    await safe(() => beads.unassign(repo, ticket.id));
    await safe(() => beads.untag(repo, ticket.id, [LABELS.stage("implementing")]));
  }
}

/** Cap on in-session `claude --resume` retries before escalating to a fresh restart (anton-juar). */
const MAX_RESUME_ATTEMPTS = 2;

export function claudeResumeDecision(
  error: { sessionId?: string; signature: string },
  attempt: number,
  priorSignature?: string,
): { resume: true } | { resume: false; reason: string } {
  if (!error.sessionId) return { resume: false, reason: "no session id" };
  if (error.signature === priorSignature) {
    return { resume: false, reason: `repeated ${error.signature}` };
  }
  if (attempt >= MAX_RESUME_ATTEMPTS) {
    return { resume: false, reason: "resume budget spent" };
  }
  return { resume: true };
}

/**
 * A claude driver with resilient in-session recovery (anton-juar), shaped exactly like `runClaude`
 * so it drops into the step registry's driver seam and every step inherits the recovery. A transient
 * mid-stream
 * death (network drop, truncated stream, exit-without-result) that captured a Claude session id is
 * retried with `claude --resume <id>` — continuing the same conversation instead of re-running the
 * whole ticket from scratch — bounded by MAX_RESUME_ATTEMPTS so a flapping connection can't burn the
 * job's retry budget. A resume that dies the SAME way escalates immediately to a fresh restart. When
 * no session id was captured, the failure is deterministic (non-recoverable), or the resume budget
 * is spent, the error propagates so the job-level runner does today's fresh spawn (then parks after
 * maxAttempts) — resume is best-effort and never a new failure mode.
 */
function resilientClaude(args: {
  db: AntonDb;
  ctx: Pick<JobContext, "signal">;
  /** anton's session row for this ticket — where the captured claude id and the resume log land. */
  sessionId: string;
  logPath: string;
  /** The ticket in scope, for the continuation prompt a resumed session gets. */
  ticket: Bead;
  /**
   * The formula step being dispatched. Every dispatching step in the ticket phase inherits this
   * driver — `implement`, and any `step:claude` the project added — so the continuation prompt names
   * the step rather than implying the resumed session was implementing the ticket.
   */
  stepId?: string;
}): (options: RunClaudeOptions) => Promise<ClaudeResult> {
  const { db, ctx, sessionId, logPath, ticket, stepId } = args;
  return async function dispatch(options: RunClaudeOptions): Promise<ClaudeResult> {
    let resumeId: string | undefined;
    let priorError: string | undefined;
    let priorSignature: string | undefined;

    for (let attempt = 0; ; attempt++) {
      try {
        const result = await runClaude(
          resumeId
            ? {
                ...options,
                // The interrupted step's own context already lives in the resumed conversation, so
                // the prompt is a brief continuation rather than the whole instruction again.
                prompt: continuationPrompt(ticket, priorError, stepId),
                resumeSessionId: resumeId,
              }
            : options,
        );
        // Persist the real Claude session id once the run reports it (diagnostics + future resume).
        if (result.sessionId) await setSessionClaudeId(db, sessionId, result.sessionId).catch(() => {});
        return result;
      } catch (e) {
        // Only a transient (RecoverableClaudeError) failure is resume-eligible. A deterministic/content
        // failure (verify-gate, agent error), poison, or quota is NOT — it propagates unchanged so the
        // runner applies today's fresh-restart/park policy (never a resume that would replay bad state).
        if (!isRecoverableClaudeError(e)) throw e;
        // A killed job (force-kill, or an abandon that cancelled the run — anton-6xj0) aborts the
        // child mid-stream, which looks exactly like a transient death. Never resume through it: the
        // operator asked for this agent to stop, and the retry would spawn against an already-aborted
        // signal anyway. Checked before the resume decision so the abort propagates immediately.
        if (ctx.signal.aborted) throw e;
        // Persist the captured id even on the failure path — a mid-stream death may carry it only via
        // the system-init event, and it's what a fresh-restart's operator or a future resume relies on.
        if (e.sessionId) await setSessionClaudeId(db, sessionId, e.sessionId).catch(() => {});

        const decision = claudeResumeDecision(e, attempt, priorSignature);
        if (!decision.resume) {
          await appendSessionLog(
            logPath,
            `[resume] not resuming (${decision.reason}) — escalating to a fresh restart: ${e.message}\n`,
          ).catch(() => {});
          throw e;
        }
        resumeId = e.sessionId;
        priorError = e.message;
        priorSignature = e.signature;
        await appendSessionLog(
          logPath,
          `[resume] transient failure (${e.signature}); resuming claude session ${e.sessionId} — ` +
            `attempt ${attempt + 2}/${MAX_RESUME_ATTEMPTS + 1}: ${e.message}\n`,
        ).catch(() => {});
      }
    }
  };
}

/**
 * Brief continuation prompt for a resumed session (anton-juar). Whatever the interrupted session was
 * given — the ticket spec, or a `step:claude`'s own prompt — already lives in the resumed
 * conversation, so this only nudges the agent to pick up where it left off. It names the STEP when
 * there is one: the ticket phase can dispatch several agents, and telling a custom step's agent that
 * its session "for <ticket>" was interrupted misdescribes the work it was actually doing. The
 * captured error is injected ONLY when it may have been caused by the agent's own output (e.g. an
 * oversized tool result that tripped a limit) — never for pure infra noise the agent can't act on,
 * which would only distract it.
 */
export function continuationPrompt(ticket: Bead, priorError?: string, stepId?: string): string {
  const subject = stepId ? `the \`${stepId}\` step of ${ticket.id}` : ticket.id;
  const lines = [
    `Your previous session — ${subject} — was interrupted mid-stream by a transient failure and ` +
      `has been resumed with full conversation context. Continue from where you left off — do NOT ` +
      `restart from scratch. Inspect the working tree for partial edits before redoing anything, so ` +
      `you don't duplicate or conflict with work already in progress.`,
  ];
  if (priorError && mayBeAgentCaused(priorError)) {
    lines.push(
      ``,
      `Your previous session ended with: "${truncateField(priorError)}". If that was caused by your ` +
        `own output (an oversized tool result, too-long input), adjust your approach so it doesn't recur.`,
    );
  }
  lines.push(``, `Follow the operating contract in your system prompt.`);
  return lines.join("\n");
}

/**
 * Could this transient error have been triggered by the AGENT's own output rather than pure infra
 * noise (anton-juar)? Oversized-input / context-window / too-large-payload errors are the agent-caused
 * class worth surfacing back into the continuation; a bare network drop is not, so it's left out.
 */
function mayBeAgentCaused(message: string): boolean {
  return /prompt is too long|input (?:is )?too long|too many tokens|maximum context|context (?:length|window)|request (?:entity )?too large|payload too large|too large|\b413\b/i.test(
    message,
  );
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

/** Fold the parsed self-report into a zero-diff block reason, when one was emitted (anton-j5i8). */
function selfReportSuffix(selfReport: AntonResult | null): string {
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
