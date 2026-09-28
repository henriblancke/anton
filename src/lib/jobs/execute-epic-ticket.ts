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
import { metered, type InvocationDimensions } from "../claude-invocations";
import { formatAntonResult, type AntonOutcome, type AntonResult } from "../claude/anton-result";
import { runClaude } from "../claude/driver";
import { applyStashEntry, branchAddedCommit, readStashEntries, type StashEntry } from "../git/ops";
import {
  AgentYieldedError,
  BlockedByAgentError,
  NeedsHumanError,
  NoDeliveryError,
  selfReportSuffix,
  StashedWorkError,
} from "./execute-epic-errors";
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
  settleFailedTicket,
  ticketSettlement,
  type TicketProgress,
  type TicketSettlement,
} from "./execute-epic-ticket-settle";
import type { ResolvedStep } from "./run-formula";
import { stepName, type StepContext, type StepFacts } from "./step-registry";

/**
 * How a finished ticket settled, plus whether its close actually landed (PR #253 review). The close
 * is best-effort, so the run may not derive it from its own shape: a bd that refused the write left
 * the bead open, and the pull request has to say so.
 */
export type TicketOutcome = TicketSettlement & { closed: boolean };

/**
 * One ticket: session → the formula's ticket phase (…→ commit) → close. Answers HOW the ticket
 * settled (anton-8h4b) — on its own commit, or on an earlier commit of the run — because the close
 * looks the same either way and the pull request must not.
 */
export async function runTicket(args: {
  /** The run-level step context every ticket shares; this ticket's own is derived from it. */
  run: Omit<StepContext, "tickets">;
  /** The formula's ticket phase, in execution order — dispatched once per ticket (anton-lnkt). */
  steps: ResolvedStep[];
  ticket: Bead;
  /**
   * Every ticket this run holds, ids only — the set that tells a prerequisite this run will land
   * itself from one outside it (anton-0gm2). Carried down to the `dep-missing` repair in the
   * settlement; the run already has it, so nothing below re-derives it from the board.
   */
  runTicketIds: readonly string[];
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
}): Promise<TicketOutcome> {
  const { run, ticket, operator, timeoutMs } = args;
  const standalone = args.standalone ?? false;
  const { ctx, worktreePath } = run;
  const closeOnDone = args.closeOnDone ?? true;

  const claimedOperator = await claimTicket(run, ticket, operator);
  const session = await openTicketSession(run, ticket);
  const budget = startTicketBudget(ctx, timeoutMs, (remainingMs) =>
    warnBudgetRunningOut(session.logPath, ticket, timeoutMs, remainingMs),
  );
  const baseline = await readTicketBaseline(worktreePath);
  const ticketCtx = narrowToTicket(run, ticket, session, budget, baseline);
  const progress: TicketProgress = { committed: false, delivered: false, selfReport: null };

  try {
    // Read INSIDE the try, deliberately not wrapped in its own catch (anton-wjfkn): a stash baseline
    // anton could not read is not "no stashes", and treating it as one would let a PRE-EXISTING entry
    // (a neighbour's, or an earlier failed attempt's own) get misread as gained during this ticket and
    // spliced into this worktree by `refuseStashedDelivery`. Letting the read failure fall straight
    // into this catch stops the ticket the same safe way any other setup failure does, with the
    // baseline left unknown rather than guessed at.
    const stash = ticketStashRecovery(worktreePath, run.branch, await readStashEntries(worktreePath));
    await walkTicketSteps({ run, steps: args.steps, ticket, ticketCtx, session, progress, stash });
    const settlement = await ticketSettlement(run, progress);
    // The deadline only stops what observes it (PR #253 review). The gate's branch reads and the
    // settlement's commit lookup are plain git reads that take no signal, so a deadline landing
    // during one aborts nothing: the walk returns as if in time, and nothing below would ask. Asked
    // here, the last point before the board is written — a ticket the clock caught on its final
    // read settles as the timeout it is, never as a close.
    if (budget.ranOutOfTime() || ctx.signal.aborted) {
      throw new Error(
        budget.ranOutOfTime()
          ? `${ticket.id} ran out of its ticket budget while the delivery gate was reading the branch`
          : `${ticket.id}'s run was aborted while the delivery gate was reading the branch`,
      );
    }
    const { closed } = await finishTicket(ticketCtx, ticket, session.sessionId, closeOnDone, settlement);
    return { ...settlement, closed };
  } catch (e) {
    // Always throws; returned so the signature carries the `never` and the walk's answer is typed.
    return settleFailedTicket({
      run,
      ticket,
      runTicketIds: args.runTicketIds,
      session,
      ranOutOfTime: budget.ranOutOfTime(),
      baseline,
      progress,
      timeoutMs,
      standalone,
      operator: claimedOperator,
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
  /** The stash reads that tell an empty tree from a set-aside one (anton-wjfkn). */
  stash: StashRecovery;
}): Promise<void> {
  const { run, ticket, ticketCtx, session, progress } = args;
  const { db } = run;
  const { sessionId, logPath } = session;
  for (const { step: cooked, definition } of args.steps) {
    // Every step boundary is a lease checkpoint, exactly as every ticket boundary is.
    run.assertLeaseHeld?.();
    // Built once per step, before the handler below resolves what to attribute it to — the object
    // `setAttribution` mutates once it does (PR #313 review).
    const dimensions: InvocationDimensions = {
      projectId: ticketCtx.projectId,
      jobType: ticketCtx.ctx.type,
      jobId: ticketCtx.ctx.jobId,
      step: cooked.id,
      // The handler beside the author's step id (anton-234ja) — same reason `dispatchClaude`
      // records it: a project formula's own step id classifies nothing.
      stepHandler: stepName(cooked),
      runId: ticketCtx.runId,
      beadId: ticket.id,
      modelRequested: ticketCtx.settings?.model,
      // Same for the pipeline digest; the prompt digest `metered` takes from the spawn options,
      // which a resumed attempt carries unchanged.
      formulaDigest: ticketCtx.formulaDigest,
    };
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
          // Meter the bare driver inside the resilience loop: every interrupted call and its
          // resumed successor are distinct paid attempts, even when the wrapper returns one result.
          // `dimensions` is mutated in place by `setAttribution` below rather than rebuilt, because
          // `metered` reads it at CALL time (once the handler below has actually dispatched) — the
          // object built here, before the handler runs, is the same one that read picks up.
          driver: metered(db, ticketCtx.clock, dimensions, runClaude),
        }),
        recordsEachAttempt: true,
        // This driver meters its own attempts, so `dispatchClaude` adds no outer row and — unlike
        // the shared dispatch boundary's own meter — its resolved attribution never reaches this one
        // on its own (PR #313 review). `dispatchClaude` calls this right before dispatching with
        // whatever it resolved: `implementStep`'s ticket `agent:` tag, or `claudeStep`'s
        // `promptId`/`skillId` + digest — never both, and never the ticket's own agent for the
        // latter, which does not run it.
        setAttribution: (attribution) => Object.assign(dimensions, attribution),
      },
    });
    recordStepReport(progress, result.facts);

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

    // The agent ENDED ITS TURN to wait (anton-wjfkn): its last message armed a wake-up, a monitor or
    // a background job and it emitted no `ANTON-RESULT` at all. Nothing wakes an autonomous ticket
    // session, so that turn is the whole session — and it is a stop, not a finish.
    //
    // Judged HERE, at the step that yielded, for the same reason the ask above is: what follows would
    // MISREAD it. A `verify` gate would run against a half-written tree, and the delivery gate would
    // read the agent's silence as "nothing to report" and settle whatever the tree happens to hold —
    // which for the shape that actually occurs is an empty tree it files as a zero-diff stall. The
    // stash is recovered on the way out, because this exit precedes the gate that would otherwise do
    // it and the yield and the stash are one event: the agent stashed in order to measure, then
    // yielded to wait for the measurement.
    if (progress.yielded) {
      throw await yieldedMidWork(ticket, progress.yielded, cooked.id, progress, args.stash);
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
    // `run.alreadyShippedBase`, not `run.baseRef` (PR #279 review, round 2 — this call site was the
    // one the refactor missed): `baseRef` is a movable ref name that a failed fetch resolves LOCALLY,
    // which can read behind the base a reused checkout's refresh already committed the branch onto.
    // Before this run's own refresh could move the base mid-run, the two always agreed; now that they
    // can diverge, checking a `satisfied` self-report against the stale `baseRef` instead of
    // `alreadyShippedBase` can let a commit the checkout only carries because of the base refresh —
    // not this run's own work — read as "added by the branch", the exact false success every sibling
    // check in this file was updated to close (see `alreadyShippedBase`'s own doc comment).
    await assertDelivered(
      ticket,
      result.facts ?? {},
      progress,
      (commit) => branchAddedCommit(run.repoPath, run.branch, run.alreadyShippedBase, commit),
      args.stash,
    );
  }
}

/**
 * Fold one step's report into the phase's, REPORT AND DISPATCH SNAPSHOT TOGETHER (PR #238 review).
 *
 * A `blocked` or `needs-human` self-report is STICKY across a phase with several dispatching steps,
 * by SEVERITY (see {@link selfReportRank}). A later agent — a `step:claude` the project added after
 * `implement` — reports on its own work only, so letting its `delivered` overwrite an earlier block
 * would close a ticket the implementer declared incomplete on the partial changes it left behind. An
 * ask still outranks an earlier block, because it names the exact move a person owes; sticking on the
 * block instead would drop it silently and settle the run behind no gate at all (PR #205 review). A
 * missing/unparseable line (null) keeps whatever the phase reported before it.
 *
 * The bead the step was PROMPTED with travels with that report and only with it. They are one fact —
 * a claim about "this ticket" is a claim about the read it was made from — and updating them
 * independently pairs them wrongly the moment a phase has two dispatching steps: an additive
 * `step:claude` reporting `already-shipped` after `implement` displaces the implementer's report but
 * supplies no snapshot of its own, so the `already-shipped` repair would fence the generic step's
 * claim against the IMPLEMENTER's read — and a human note that landed between the two would look
 * like a note the reporting agent had seen. So a displacing report carries its own snapshot, or
 * none: `already-shipped` rejects a missing snapshot rather than retire a ticket on a contract the
 * reporting agent never received.
 */
export function recordStepReport(progress: TicketProgress, facts: StepFacts | undefined): void {
  // The yield is a fact about the step that just ran and is acted on immediately by the walk, so it
  // is recorded outside the severity merge above: it is not a claim competing with other claims, and
  // a step that yielded cannot have reported anything for the merge to weigh it against.
  if (facts?.yielded?.length) progress.yielded = facts.yielded;
  const reported = facts?.selfReport;
  if (!reported || !displacesSelfReport(reported, progress.selfReport)) return;
  progress.selfReport = reported;
  progress.dispatched = facts?.dispatched;
}

/**
 * Asks the branch whether `commit` is one this run added over its base (anton-nuft) — the one read
 * that can settle a `satisfied` self-report. Injected so the gate is a unit: production hands it
 * {@link branchAddedCommit} over the run's repository, branch and fork point.
 */
export type BranchAddedCommit = (commit: string) => Promise<boolean>;

/**
 * The stash reads the delivery gate needs to tell an empty tree from a SET-ASIDE one (anton-wjfkn),
 * injected for the same reason {@link BranchAddedCommit} is: the gate stays a unit.
 *
 * Required rather than optional, deliberately. An agent that stashed its diff and yielded produces a
 * tree byte-identical to one that did nothing, so a call site that omitted this would settle the
 * incident this exists to stop while looking perfectly correct — the silent-failure seam is the bug.
 */
export interface StashRecovery {
  /**
   * Stash entries the worktree gained since this ticket's baseline, newest first — `[]` when it
   * gained none, which is every ordinary ticket.
   *
   * The DELTA, not the stack: the stack is shared by every worktree cut from the repository, so a
   * concurrent run's entries are on it and are none of this ticket's business.
   */
  gained: () => Promise<readonly StashEntry[]>;
  /** Put one entry's changes back into the tree, leaving the durable stack copy — {@link applyStashEntry}. */
  apply: (sha: string) => Promise<boolean>;
}

/**
 * Whether a stash entry's reflog subject names `branch` — git's own record of which checkout pushed
 * it: `On <branch>: <message>` for an explicit `git stash push -m`, `WIP on <branch>: <sha> <subject>`
 * for an autostash (anton-wjfkn round 2 review).
 *
 * The baseline diff in {@link ticketStashRecovery} tells a NEW entry from an old one, but `refs/stash`
 * is repository-wide — every worktree cut from this repo pushes onto the same stack, and anton runs
 * several epics' worktrees off one repo concurrently. A sibling ticket's OWN push landing between this
 * ticket's baseline read and its own gained-check is new to the delta too, and an absolute "is it new"
 * read would misattribute it here — parking `stashed-work` over a neighbour's entry and, worse, calling
 * {@link applyStashEntry} to splice that neighbour's changes into this worktree. The subject is the one
 * field that says whose checkout it came from, so scoping the delta by it (not just by sha) is what
 * keeps a sibling's entry out of this ticket's recovery.
 */
export function stashEntryOnBranch(entry: StashEntry, branch: string): boolean {
  const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:WIP on|On) ${escaped}:`).test(entry.subject);
}

/**
 * The production {@link StashRecovery} for one ticket, closed over the stash stack as it stood BEFORE
 * any of the ticket's steps ran, and over the ticket's own branch.
 *
 * The baseline is what makes the answer this ticket's own IN TIME. `refs/stash` lives in the shared
 * git dir, so every worktree on this machine pushes onto one stack — a run executing tickets in
 * parallel worktrees has siblings' entries on it, and an absolute read would attribute them here: the
 * ticket would park `stashed-work` over a neighbour's entry and, worse, APPLY that neighbour's changes
 * into this worktree. Diffing against the baseline by sha keeps both halves honest for an entry that
 * predates this ticket's run — but a sibling ticket can push its OWN entry after this ticket's baseline
 * was read, which the sha diff alone cannot tell apart from this ticket's entry. The branch filter is
 * what makes the answer this ticket's own IN OWNERSHIP: only an entry whose reflog subject names this
 * ticket's own branch survives ({@link stashEntryOnBranch}). Together they are a two-way guard — an
 * entry that was already there and has since been popped elsewhere simply drops out of the delta
 * (correct), and an entry pushed by a different checkout drops out regardless of when it landed
 * (anton-wjfkn round 2).
 */
function ticketStashRecovery(
  worktreePath: string,
  branch: string,
  baseline: readonly StashEntry[],
): StashRecovery {
  const before = new Set(baseline.map((e) => e.sha));
  return {
    gained: async () =>
      (await readStashEntries(worktreePath)).filter(
        (e) => !before.has(e.sha) && stashEntryOnBranch(e, branch),
      ),
    apply: (sha) => applyStashEntry(worktreePath, sha),
  };
}

/**
 * The commit is the ticket's evidence of record — honor the step's verdict on whether there is one,
 * and on whose work it is.
 *
 * A clean agent exit that leaves NO diff delivered nothing: the exact false-success in issue #46
 * (root cause #1). Do NOT close/advance the ticket on empty delivery. {@link NoDeliveryError} is
 * poison, so the runner parks the run for a human instead of retrying claude to the same empty
 * result forever, and the ticket's own catch BLOCKS the bead rather than re-queueing it open.
 *
 * ONE zero diff is a delivery (anton-nuft): the step whose work an EARLIER commit of this same run
 * already did, which the agent reports as `satisfied — <commit>` (anton-6l0q). That is a claim, and
 * the false-success property above is exactly why a claim cannot settle anything on its own — the
 * `delivered` line on an empty tree is the same words with a different verb. So the gate settles on
 * the branch, never on the agent's word: `branchAdded` asks git whether the named commit is among
 * those this run's branch added over its base. A claim naming no commit, a commit git cannot find,
 * or a commit of the base parks exactly as the plain zero diff does, with the unverified claim
 * folded into the reason. The step then settles with `committed: false` — the tree fact is still
 * true, this ticket added nothing — and `delivered: true`, which is what the board and the pull
 * request read. Which commit it settled against is the next ticket's business (attribution).
 *
 * ONE zero diff is not this ticket's answer to give at all (anton-wjfkn): the tree is empty because
 * the agent STASHED its own work. `git stash` produces a tree byte-identical to one nothing touched,
 * so before this gate may call an empty tree a zero diff it asks {@link StashRecovery} whether the
 * worktree gained an entry since the ticket's baseline — and refuses the delivery block if it did.
 * See {@link refuseStashedDelivery} for what it does instead.
 */
export async function assertDelivered(
  ticket: Bead,
  facts: StepFacts,
  progress: TicketProgress,
  branchAdded: BranchAddedCommit,
  stash: StashRecovery,
): Promise<void> {
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
    // A satisfied step settles on the branch's answer, never on the claim (anton-nuft). The read is
    // skipped when the claim names nothing: parsing already rejects such a line, but the type does
    // not, and asking git about an empty sha would be asking it about HEAD.
    if (
      selfReport?.outcome === "satisfied" &&
      selfReport.commit &&
      (await branchAdded(selfReport.commit))
    ) {
      progress.delivered = true;
      return;
    }
    // Before the tree may be called EMPTY, ask whether it is merely SET ASIDE (anton-wjfkn). Asked
    // only here, on the one path that would otherwise report "nothing landed" over work that exists.
    // Deliberately NOT caught into `[]` (PR #333 review): the same reasoning as the baseline read
    // above applies to this later one — a `git stash list` failure here is not "no new stash", and
    // swallowing it would report a stashed change as ordinary no-delivery. Let it fall into the
    // ticket's own catch, exactly like the baseline read does.
    const stashed = await stash.gained();
    if (stashed.length > 0) {
      await refuseStashedDelivery(ticket, progress, stashed, stash);
    }
    // Empty tree: the delivery-evidence gate blocks + halts. Cross-check the self-report and
    // fold it into the reason (anton-j5i8): a `delivered` claim on an empty tree is the exact
    // false success the gate exists to catch; a `blocked` self-report corroborates the block and
    // carries the agent's own reason forward; a `satisfied` claim that the branch did not bear out
    // is named as unverified. A missing line just reads as the plain gate message.
    const structural =
      `${ticket.id} produced no delivery: claude exited cleanly and passed the verify gates but ` +
      `left no changes to commit (zero diff). Blocking the ticket for operator review and ` +
      `halting the epic — nothing landed, so closing it would be a false success.`;
    throw new NoDeliveryError(structural + selfReportSuffix(selfReport), structural, selfReport);
  }
  // Commit evidence exists, but the agent SELF-REPORTED blocked (anton-j5i8): it is telling us
  // the ticket is not actually done. Honor that honest signal — block the ticket for a human
  // rather than closing it on a partial change. This is NOT a self-report-alone failure (out of
  // scope): there IS commit evidence; we surface the contradiction (work committed + agent-declared
  // block) so the partial work isn't lost and a human decides. A `delivered`/missing self-report
  // with a real commit is the normal path and proceeds to close/in-review below.
  if (selfReport?.outcome === "blocked") {
    // `structural` skips the parenthetical agent quote `formatAntonResult` renders into the message
    // below — that quote IS the agent's half, already held apart on `selfReport` — so anton's own
    // half is recoverable without re-parsing it back out of the rendered sentence.
    const structural =
      `${ticket.id} was self-reported blocked by the agent even though it committed changes. ` +
      `Blocking the ticket for operator review and halting the epic — the agent declared the work ` +
      `incomplete, so closing it would be a false success.`;
    throw new BlockedByAgentError(
      `${ticket.id} was self-reported blocked by the agent (${formatAntonResult(selfReport)}) even ` +
        `though it committed changes. Blocking the ticket for operator review and halting the epic — ` +
        `the agent declared the work incomplete, so closing it would be a false success.`,
      structural,
      selfReport,
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
    // No suffix is folded into the message here — the missing/non-delivered self-report is already
    // anton's own reasoning (see the sentence below), not a quote of the agent's words — so
    // `structural` is the whole message, and whatever the agent DID report (if anything short of
    // `delivered`) still rides along on `selfReport` for a reader that wants it.
    const structural =
      `${ticket.id} produced no delivery: claude left no changes to commit (zero diff) and no ` +
      `\`ANTON-RESULT\` from this run says the ticket is finished, so the only work on the branch ` +
      `is the explicitly incomplete commit a previous attempt PRESERVED when it ran out of time. ` +
      `Blocking the ticket for operator ` +
      `review and halting the epic — nothing this run did says that work is finished, so ` +
      `adopting it as the delivery would be a false success. Finish it by hand or resume the run ` +
      `with a raised ticketTimeoutMinutes.`;
    throw new NoDeliveryError(structural, structural, selfReport ?? null);
  }
  progress.delivered = true;
}

/**
 * The empty tree is a SET-ASIDE one: the worktree gained stash entries while this ticket ran, so
 * whatever the agent built is on the stash stack rather than nowhere (anton-wjfkn). Always throws.
 *
 * This is the incident of 2026-09-27 (fati-8sme): the agent implemented the ticket, hit a coverage
 * floor, ran `git stash -u` to measure the baseline, started that measurement in the background and
 * yielded its turn. anton read the yielded turn as a clean exit over an empty tree, blocked the
 * ticket `no-delivery`, halted the epic, and force-removed the worktree — after which a stash commit
 * in the shared repository was the only copy of +171 lines of passing work. Every step of that was
 * correct except the first: the tree was never empty.
 *
 * So the entries are RESTORED, newest last — `git stash` is a stack, so replaying it oldest-first is
 * what reproduces the tree the agent had. A restore that lands is not a delivery: nothing here
 * verified the work or ran a gate over it, and the commit step has already been and gone. The ticket
 * still stops, but it stops on THIS class rather than a zero diff, which changes the three things
 * that actually cost the work:
 *
 *  - the park names the stash shas, so the durable copy is reachable from the operator's own note;
 *  - the worktree is KEPT (this error is `holdsPartialWork` at the run's teardown), so the restored
 *    tree survives for the resume that continues from it;
 *  - the remedy an operator is handed is "your work is here", not "implement this ticket".
 *
 * The apply is best-effort and its failure is reported rather than repaired: `applyStashEntry` leaves
 * every entry on the stack either way, so the only thing a failed apply costs is the convenience of
 * finding the work already in the tree. Nothing is ever dropped — see {@link applyStashEntry}.
 */
async function refuseStashedDelivery(
  ticket: Bead,
  progress: TicketProgress,
  stashed: readonly StashEntry[],
  stash: StashRecovery,
): Promise<never> {
  const shas = stashed.map((e) => e.sha);
  const list = shas.map((sha) => `\`${sha}\``).join(", ");
  const recovery = await recoverStashed(stashed, stash);
  const structural =
    `${ticket.id} delivered nothing because its work is STASHED, not absent: the worktree gained ` +
    `${shas.length} stash ${shas.length === 1 ? "entry" : "entries"} (${list}) while this ticket ran, ` +
    `so the empty tree the commit step saw is work the agent set aside rather than work it never did. ` +
    `${recovery.summary}. Blocking the ticket and halting the epic — nothing was ` +
    `verified or committed, so this is no delivery — but the worktree is KEPT rather than removed, ` +
    `because that stash is the only record of the change. Read it with ` +
    `\`git stash show -p <sha>\` and restore it with \`git stash apply <sha>\`, then finish the ` +
    `ticket by hand or resume the run. Agents must never stash their own work: the harness reads the ` +
    `worktree as the delivery.`;
  throw new StashedWorkError(
    structural + selfReportSuffix(progress.selfReport),
    shas,
    structural,
    progress.selfReport,
    recovery.failed,
  );
}

/**
 * The stop a yielded turn earns (anton-wjfkn), with whatever the agent stashed on its way to yielding
 * put back first.
 *
 * The recovery runs HERE and not only in {@link refuseStashedDelivery} because a yield exits the walk
 * BEFORE the commit step, so that gate never gets to ask. They are one event in practice — the agent
 * stashes to measure a baseline, then yields to wait for the measurement — and the incident this
 * closes is exactly that pair. A yield with no stash is the ordinary case and costs one empty read.
 *
 * Returns the error rather than throwing it, so the throw is visible at the call site in the walk.
 */
async function yieldedMidWork(
  ticket: Bead,
  armed: readonly string[],
  stepId: string,
  progress: TicketProgress,
  stash: StashRecovery,
): Promise<AgentYieldedError> {
  // NOT read as "stashed nothing" on a read failure (PR #333 review, round 2): a raw rejection
  // escaping this function would reach the walk's catch as a plain `Error`, which
  // `holdsRecoverableWork` does not recognise — the run's teardown would then read this stop as
  // ordinary failure residue and force-remove the very worktree this recovery exists to keep. Caught
  // instead, so the stop still comes back as a RECOVERABLE `AgentYieldedError`, one that says plainly
  // it does not know whether a stash exists rather than falsely claiming there is none.
  let stashed: readonly StashEntry[] = [];
  let stashReadFailed = false;
  try {
    stashed = await stash.gained();
  } catch {
    stashReadFailed = true;
  }
  const recovery =
    stashed.length > 0 ? await recoverStashed(stashed, stash) : { restored: [], failed: [], summary: "" };
  return new AgentYieldedError(
    ticket.id,
    armed,
    stashed.map((e) => e.sha),
    stepId,
    progress.selfReport,
    recovery.failed,
    stashReadFailed,
  );
}

/** What became of a {@link recoverStashed} pass — the shas that landed, the shas that did not, and a
 * ready-made clause for an operator-facing message that needs to say so in one sentence. */
interface StashRecoveryResult {
  restored: string[];
  failed: string[];
  summary: string;
}

/**
 * Put every gained stash entry back into the worktree, and say what became of them in one clause an
 * operator-facing message can embed.
 *
 * Replayed OLDEST FIRST — the entries arrive newest-first off the reflog, and applying a stack in that
 * order would lay an earlier snapshot over a later one. Best-effort per entry: `applyStashEntry`
 * leaves every entry on the stack whatever happens, so a failed apply costs only the convenience of
 * finding the work already in the tree, never the work.
 *
 * Returns which shas actually landed and which did not — never just the prose — so a caller composing
 * a SEPARATE, shorter note (the bead's block note) can say the same true thing in its own words rather
 * than repeat-or-drop this function's summary and risk the two disagreeing (anton-wjfkn round 3).
 */
async function recoverStashed(
  stashed: readonly StashEntry[],
  stash: StashRecovery,
): Promise<StashRecoveryResult> {
  const restored: string[] = [];
  const failed: string[] = [];
  for (const entry of [...stashed].reverse()) {
    if (await stash.apply(entry.sha)) restored.push(entry.sha);
    else failed.push(entry.sha);
  }
  const one = stashed.length === 1;
  const summary =
    failed.length === 0
      ? `anton applied ${one ? "it" : "them"} back into the worktree and left ` +
        `${one ? "the entry" : "the entries"} on the stash stack as the durable copy`
      : restored.length === 0
        ? `anton could NOT apply ${one ? "it" : "any of them"} back into the worktree (the tree has ` +
          `moved under ${one ? "it" : "them"}), so the stash ${one ? "commit is" : "commits are"} the ` +
          `only copy`
        : `anton applied ${restored.length} of ${stashed.length} back into the worktree and could not ` +
          `apply ${failed.map((sha) => `\`${sha}\``).join(", ")}; every entry is still on the stash stack`;
  return { restored, failed, summary };
}

/**
 * How much a self-report OUTRANKS the one a phase already carries. A phase of several dispatching
 * steps keeps the most severe report any of them made, and severity is how actionable it is: an ask
 * names the one move a person owes, a block names a defect to diagnose, and `delivered` is a claim
 * a later step cannot make on an earlier step's behalf. `satisfied` (anton-6l0q) ranks below even
 * that, deliberately: it says this step added nothing because an earlier commit already covers it,
 * so a step in the same phase that DID deliver has the report that describes the tree — and a later
 * step's `satisfied` must not talk an earlier `delivered` down to "nothing new here". An absent
 * report (null) ranks below all four, so the first step to say anything sets the phase's report.
 *
 * Rank alone does not decide the merge — see {@link displacesSelfReport} for the one case where the
 * higher rank loses.
 */
export function selfReportRank(outcome: AntonOutcome | undefined): number {
  switch (outcome) {
    case "needs-human":
      return 3;
    case "blocked":
      return 2;
    case "delivered":
      return 1;
    case "satisfied":
      return 0;
    default:
      return -1;
  }
}

/**
 * Whether a step's report replaces the one its phase already carries: by {@link selfReportRank},
 * with one exception (PR #253 review). A `delivered` outranks a `satisfied`, but it never DISPLACES
 * one that names a commit. The two agree that the step found nothing wrong; they differ in what a
 * zero diff can then settle on. `satisfied` carries the commit the gate verifies against the branch,
 * and `delivered` carries nothing — so a project's own `step:claude` reporting `delivered` on the
 * unchanged tree the implementer honestly left would turn a verifiable claim into the plain
 * zero-diff park this outcome exists to prevent. Keeping the claim costs a later step that DID
 * commit nothing: the tree fact decides that settlement, and a `satisfied` report on a committed
 * tree settles as the commit ({@link satisfiedClaim} reads `committed` first).
 */
export function displacesSelfReport(incoming: AntonResult, current: AntonResult | null): boolean {
  if (current?.outcome === "satisfied" && current.commit && incoming.outcome === "delivered") {
    return false;
  }
  return selfReportRank(incoming.outcome) >= selfReportRank(current?.outcome);
}
