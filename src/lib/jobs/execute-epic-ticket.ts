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
import { metered } from "../claude-invocations";
import { formatAntonResult, type AntonOutcome, type AntonResult } from "../claude/anton-result";
import { runClaude } from "../claude/driver";
import { branchAddedCommit } from "../git/ops";
import {
  abandonDispatchBaseline,
  clearBoardEvidencePending,
  ensureBoardBaselinePersisted,
  isBoardOnlyRun,
  readBoardBaseline,
  readBoardEvidence,
  type BoardEvidenceResult,
  type BoardFingerprint,
} from "./execute-epic-board-evidence";
import { BlockedByAgentError, NeedsHumanError, NoDeliveryError } from "./execute-epic-errors";
import { PoisonEpic } from "./errors";
import { mustRead } from "./execute-epic-persist";
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
  ticketSettlement,
  type TicketProgress,
  type TicketSettlement,
} from "./execute-epic-ticket-settle";
import type { ResolvedStep } from "./run-formula";
import { appendSessionLog } from "../sessions";
import { recordBoardOnlyAttribution } from "./step-registry";
import type { StepContext, StepFacts } from "./step-registry";

/**
 * How a finished ticket settled, plus whether its close actually landed (PR #253 review). The close
 * is best-effort, so the run may not derive it from its own shape: a bd that refused the write left
 * the bead open, and the pull request has to say so.
 */
export type TicketOutcome = TicketSettlement & {
  closed: boolean;
  /**
   * The bead ids this ticket's confirmed board evidence covered (PR #284 review round 11) — the same
   * ids `clearBoardEvidencePending` releases below, handed back up so the run can tell the reviewer
   * WHICH beads a board-only ticket actually changed instead of only that some board write happened.
   * Absent for every non-board-only ticket, and for one whose evidence never confirmed.
   */
  boardEvidenceIds?: string[];
};

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
  // The classification (anton-fc5x review round 4) is kept SEPARATE from whether the baseline read
  // that backs it actually succeeded. A board-only ticket whose `bd list` exhausted its retries is
  // still a board-only ticket — collapsing the two into one `null` (as before) made an unreadable
  // baseline indistinguishable from "this was never board-only", which let `walkTicketSteps` skip
  // the board-evidence gate entirely and fall through to the tree-based path: an incidental commit
  // would then settle delivered without the board ever being checked, the exact false success this
  // gate exists to prevent. The read costs a whole-board `bd list`, paid here so every OTHER
  // ticket's zero-diff path stays exactly as cheap as it always was.
  const boardOnly = isBoardOnlyRun(run, ticket);
  // `ticket` is passed so a resumed attempt reuses a PRIOR attempt's preserved baseline instead of
  // taking a fresh one (PR #284 review round 8) — see readBoardBaseline's own docstring.
  let boardBaseline = boardOnly ? await readBoardBaseline(run.repoPath, ticket) : null;
  // Durably persisted BEFORE the agent is ever dispatched (PR #284 review, "Persist the board
  // baseline before dispatch") — a freshly-read baseline otherwise lives only in this process's
  // memory until `readBoardEvidence` first writes a pending marker, and on a shared-server board the
  // agent's own bd writes are globally visible the moment they land. A process/host death inside that
  // window would leave a resumed attempt with nothing preserved to anchor to: `readBoardBaseline`
  // would take a fresh read that already absorbed the delivered state, and an idempotent retry then
  // diffs as no evidence at all, permanently. Kept SEPARATE from `!boardBaseline` below (never folded
  // into it) so the operator note can say precisely which of "unreadable" or "read fine but could not
  // be anchored" happened, instead of a persist failure claiming a read never occurred.
  //
  // `ensureBoardBaselinePersisted`'s confirming push is a pull → commit → push pass, so it can pull
  // in remote changes made by something else with access to the same board between the read above and
  // here — it returns a REFRESHED baseline accounting for them (chatgpt-codex-connector, PR #284
  // review, "Refresh the baseline after the confirming pull"). Reassigned into `boardBaseline` on
  // success so `walkTicketSteps` and the failure-path audit below both measure against the board as it
  // stood after that one guaranteed pull, never the pre-pull read a pulled-in change would otherwise be
  // credited against.
  const refreshedBoardBaseline =
    boardOnly && boardBaseline ? await ensureBoardBaselinePersisted(run.repoPath, ticket, boardBaseline) : null;
  const boardBaselinePersistFailed = boardOnly && boardBaseline ? !refreshedBoardBaseline : false;
  if (refreshedBoardBaseline) boardBaseline = refreshedBoardBaseline;
  const ticketCtx = narrowToTicket(run, ticket, session, budget, baseline, boardOnly);
  const progress: TicketProgress = { committed: false, delivered: false, selfReport: null };
  // Set only once the ticket itself has genuinely finished (PR #284 review round 9) — kept outside
  // the try/catch below so the marker cleanup after it can propagate a failure WITHOUT routing
  // through `settleFailedTicket`, which exists to fail an UNSETTLED ticket and would reopen/reblock
  // this one on a cleanup write that has nothing to do with whether its work landed.
  let finished: { settlement: TicketSettlement; closed: boolean; transitioned: boolean } | undefined;
  // Whether `walkTicketSteps` was ever reached this attempt (PR #284 review, "Skip the failure audit
  // when dispatch never started") — the two `NoDeliveryError` throws below fire BEFORE any step runs,
  // so a catch reached from one of them has no dispatch to audit. Read only in the catch block, never
  // reassigned there, so a throw from `walkTicketSteps` itself still reports `true`.
  let dispatchStarted = false;

  try {
    // A board-only ticket with no baseline is refused BEFORE dispatch, not just at the commit
    // step's evidence gate (PR #284 review round 12): letting the agent run anyway risks it making
    // the very bd writes this ticket is meant to deliver, which `concludeRunAttempt` syncs to the
    // remote regardless of this ticket ultimately failing. A resumed attempt would then take a
    // FRESH baseline that already absorbed those writes, so its idempotent retry produces no delta
    // and can never prove the delivery this attempt actually made. Failing closed here — before any
    // step has a chance to write — keeps that baseline untouched for the resume that follows.
    if (boardOnly && !boardBaseline) {
      throw new NoDeliveryError(
        boardOnlyNoDeliveryMessage(
          ticket,
          { found: false, ids: [], synced: false, baselineUnavailable: true },
          // No agent has run yet at this pre-dispatch check, so there is no self-report to fold in.
          null,
        ),
      );
    }
    // The baseline itself read fine but could not be durably anchored to the ticket before dispatch
    // (PR #284 review, "Persist the board baseline before dispatch") — checked separately from the
    // unreadable case above so the message never claims a read failure that did not happen.
    if (boardBaselinePersistFailed) {
      throw new NoDeliveryError(boardOnlyBaselineNotPersistedMessage(ticket));
    }
    dispatchStarted = true;
    await walkTicketSteps({
      run,
      steps: args.steps,
      ticket,
      ticketCtx,
      session,
      progress,
      boardOnly,
      boardBaseline,
    });
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
    const { closed, transitioned } = await finishTicket(
      ticketCtx,
      ticket,
      session.sessionId,
      closeOnDone,
      settlement,
    );
    finished = { settlement, closed, transitioned };
  } catch (e) {
    // A board-only ticket's deliverable is bd writes the agent makes directly against the live
    // board (PR #284 review, "Audit live-board mutations when ticket execution fails") — so a write
    // it made before a LATER step failed (a verify gate, a timeout) is already live on the board by
    // the time this catch runs, and nothing else on this failure path ever looks: `walkTicketSteps`
    // threw before the commit step's own `assertBoardOnlyDelivered` ever got a chance to compare
    // against `boardBaseline`. Audited here, before the ticket settles, so a resumed attempt still
    // attributes that write instead of `readBoardBaseline` taking a fresh read that already absorbed
    // it as pre-existing (via an independent sync pass, or this run's own best-effort final sync in
    // `concludeRunAttempt`) — the exact loss of attribution the whole board-evidence check exists to
    // prevent.
    //
    // Gated on `dispatchStarted` too (chatgpt-codex-connector, PR #284 review, "Skip the failure
    // audit when dispatch never started"): the two pre-dispatch `NoDeliveryError`s above reach this
    // catch with `boardBaseline` still set but no agent ever run. Auditing there anyway diffs
    // `boardBaseline` against whatever the confirming pull inside `ensureBoardBaselinePersisted` just
    // read — which can be an unrelated writer's board update, not this ticket's own work — and
    // persists it as this ticket's pending evidence. A later attempt that actually dispatches could
    // then have its own honest `satisfied`/`delivered` self-report accepted on THOSE stale ids,
    // defeating the delivery gate for work nobody did.
    if (boardOnly && boardBaseline && dispatchStarted) {
      await auditBoardOnFailedTicket(run, ticket, boardBaseline, session.logPath, e);
    }
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

  // The pending marker (anton-fc5x review round 4) is released only now — the whole handoff this
  // ticket's board evidence unblocked (attribution commit + close/in-review) has gone through
  // without throwing. See {@link clearBoardEvidencePending}.
  //
  // Gated on `transitioned`, not just on the marker's presence (PR #284 review round 7): `closed`
  // reads `false` for a standalone target's normal `stage:in-review` success, so an unconditional
  // clear here released the marker on a bd write that may have been REFUSED — a child ticket whose
  // board edits already landed would then have no pending ids for a later retry to prove delivery
  // from. `transitioned` is the one answer that covers both the epic-child close and the standalone
  // in-review move, and is true only when the write that ends this ticket's handoff actually
  // landed.
  //
  // Left OUTSIDE the try/catch above (PR #284 review round 9): a cleanup write bd keeps refusing
  // must halt the run (see `clearBoardEvidencePending`'s own docstring), but this ticket has already
  // closed/transitioned successfully — reclassifying it as a failure here would reopen or reblock a
  // delivery that genuinely landed. The thrown error propagates straight out of `runTicket` instead.
  if (progress.boardEvidenceIds) {
    if (finished.transitioned) {
      // Re-read the ticket immediately before cleanup (PR #284 review, "Refresh the ticket before
      // clearing newly written evidence"): `ticket` is the snapshot loaded before dispatch, but
      // `readBoardEvidence` (inside `walkTicketSteps` above) adds the `board-evidence-pending:*`
      // label to the LIVE board bead after that snapshot was taken. `clearBoardEvidencePending`
      // derives which label to remove from the bead it is passed, so handing it the stale snapshot
      // makes it see no label, skip the removal, and still record confirmation as though cleanup
      // succeeded — stranding the live pending label on the board for a later reopen to union its
      // old ids into `readBoardEvidence` and misread them as current evidence.
      //
      // A failed re-read must NOT fall back to `ticket` (chatgpt-codex-connector, PR #284 review,
      // "Fail closed when the cleanup re-read is unavailable"): on a FIRST-attempt success `ticket`
      // predates the pending label entirely (it was added later, inside this same call), so a
      // fallback here reproduces exactly the staleness this re-read exists to fix, just moved one
      // step later and made to look handled. Poisoning instead matches every other unrecoverable
      // cleanup-write state in this block (see the `else` branch below, and
      // `clearBoardEvidencePending`'s own all-or-nothing gate): the ticket has already
      // closed/transitioned successfully, so halting for a human costs nothing this run has not
      // already delivered, while silently mislabeling the cleanup would strand a false-evidence risk
      // no later attempt would know to look for.
      const freshTicket = await mustRead(run.repoPath, ticket.id);
      if (!freshTicket) {
        throw new PoisonEpic(
          `${ticket.id}'s board evidence was confirmed and its handoff landed, but the ticket could ` +
            `not be re-read to find its live board-evidence-pending label before cleanup — clearing ` +
            `it from the stale pre-dispatch snapshot risks leaving that label on the board, which a ` +
            `later reopen could misread as current evidence for no new work. Check the beads DB, ` +
            `then resume the run.`,
        );
      }
      await clearBoardEvidencePending(run.repoPath, freshTicket, progress.boardEvidenceIds);
    } else {
      // `finishTicket`'s close/in-review write is best-effort — right for a normal ticket, where an
      // unclosed bead is a survivable, PR-visible state (PR #253 review). It is wrong for a
      // board-only ticket: returning success here would leave the pending-evidence marker on a bead
      // that never closed/transitioned, and a later reopen — or, for an epic child, review-fix's
      // merge-time close of whatever the epic left open (`closeFinalized` in
      // review-fix-finalize.ts, which closes directly and never calls `clearBoardEvidencePending`)
      // — could then read that stale marker as current evidence for a ticket that got no new work.
      // Fail loud instead of conceding a delivered settlement over a handoff that did not land.
      throw new PoisonEpic(
        `${ticket.id}'s board evidence was confirmed and its handoff commit recorded, but bd would ` +
          `not ${closeOnDone ? "close the bead" : "move it to stage:in-review"} — returning success ` +
          `now would leave the pending-evidence marker on a bead that never transitioned, which a ` +
          `later reopen could read as current evidence for no new work. Check the beads DB, then ` +
          `resume the run.`,
      );
    }
  }
  return {
    ...finished.settlement,
    closed: finished.closed,
    ...(progress.boardEvidenceIds ? { boardEvidenceIds: progress.boardEvidenceIds } : {}),
  };
}

/**
 * Audit the board against the pre-dispatch baseline when a board-only ticket fails AFTER dispatch
 * started (PR #284 review, "Audit live-board mutations when ticket execution fails") — every path
 * that reaches `runTicket`'s catch without ever calling `assertBoardOnlyDelivered` (a verify step
 * that threw, a ticket that ran out of its budget, `ticketSettlement`'s own deadline recheck), so no
 * comparison against `boardBaseline` has been made at all.
 *
 * Reuses {@link readBoardEvidence} rather than a bespoke diff, on purpose: finding real evidence here
 * persists the SAME `board-evidence-pending:*` marker the success path writes, and that marker is
 * what a LATER attempt's own `readBoardEvidence` unions into its fresh diff (see that function's own
 * docstring) — so a write this failed attempt made stays attributable to this ticket however many
 * more failed attempts sit between it and the one that finally delivers, even though the next
 * attempt's fresh `readBoardBaseline` read may already contain it as pre-existing state.
 *
 * The marker/baseline write itself failing after every retry is unsafe enough to halt the run
 * outright, and so is a baseline that landed only LOCALLY without a confirmed sync (mirrors
 * `boardOnlyNoDeliveryMessage`'s own `markerUnpersisted`/`baselineUnpersisted`/`baselineUnconfirmed`
 * handling on the success path, chatgpt-codex-connector PR #284 review round 17, "Halt when the
 * recovery baseline remains unsynced") — the run-lease actor is machine-scoped, not run-scoped, so a
 * resume that lands on a DIFFERENT machine never sees a baseline that only landed on this one, and its
 * fresh `readBoardBaseline` may already have absorbed this attempt's writes through an independent
 * sync, permanently losing attribution. Evidence found (and its confirming push verified synced)
 * leaves the recovery state durably on the ticket for the next attempt to pick up, so this ticket's
 * own failure is left to settle exactly as it would have otherwise.
 *
 * A CONCLUSIVE empty audit is different (chatgpt-codex-connector, PR #284 review, "Retire empty
 * baselines after failed dispatches"): `found: false` here means the board genuinely has not moved
 * since the locked, verified pre-dispatch baseline, so there is nothing to preserve — but leaving that
 * baseline standing on the ticket is itself unsafe. `ensureBoardBaselinePersisted`'s `recoveryBaseline`
 * fast path trusts a locked+verified baseline unconditionally on the next attempt, with no re-check
 * that it still reflects the live board. If this failed ticket is later reopened after some UNRELATED
 * board write lands in between, the next attempt would diff that unrelated change against this same
 * stale baseline and credit a no-op agent with delivery it never produced. Retired via
 * {@link abandonDispatchBaseline} instead, so the next attempt takes a genuinely fresh baseline.
 */
async function auditBoardOnFailedTicket(
  run: Omit<StepContext, "tickets">,
  ticket: Bead,
  boardBaseline: BoardFingerprint,
  logPath: string,
  cause: unknown,
): Promise<void> {
  const result = await readBoardEvidence(run.repoPath, boardBaseline, ticket);
  // Checked BEFORE the `!found` return (chatgpt-codex-connector, PR #284 review): a total read
  // failure with no prior pending ids reports `found: false` alongside `baselineUnpersisted: true`
  // (see `readBoardEvidence`'s own docstring) — the one shape where "nothing to attribute" and "the
  // recovery write itself failed" coincide. Returning early on `!found` first would silently drop
  // that failure and let the ticket settle as an ordinary failure, leaving a resumed attempt's fresh
  // `readBoardBaseline` free to absorb this attempt's untracked board writes as pre-existing once a
  // later sync publishes them. `baselineUnconfirmed` is checked the same way and for the same reason
  // (chatgpt-codex-connector, PR #284 review round 17): it can also come back alongside `found: false`
  // (see `readBoardEvidence`'s `!hydrated` branch), and a baseline that is safe only on THIS machine
  // is exactly the state a cross-machine resume must not silently treat as "nothing to attribute".
  if (result.markerUnpersisted || result.baselineUnpersisted || result.baselineUnconfirmed) {
    const unsafeWrite = result.markerUnpersisted
      ? "pending-evidence marker"
      : result.baselineUnpersisted
        ? "recovery baseline"
        : "recovery baseline's confirming sync";
    const sameMachineNote = result.baselineUnconfirmed
      ? " The baseline itself landed locally, so resuming on THIS SAME machine is safe — but the " +
        "run-lease actor is machine-scoped, and a resume on a different machine would never see it, " +
        "silently absorbing these writes as pre-existing."
      : "";
    throw new PoisonEpic(
      `${ticket.id} failed and this attempt's board writes${result.ids.length > 0 ? ` on ${result.ids.join(", ")}` : ""} could not be ` +
        `recorded for a resume — bd refused the ${unsafeWrite} after retries.${sameMachineNote} The run ` +
        `stopped rather than let a resumed attempt's fresh board baseline silently absorb these ` +
        `unreviewed writes as pre-existing, with no way left to attribute or safely reject them. Check ` +
        `the beads DB, then resume the run${result.baselineUnconfirmed ? " on this same machine" : ""}. ` +
        `This ticket failed with: ${String(cause)}`,
    );
  }
  if (!result.found) {
    // Retire the locked, verified pre-dispatch baseline rather than leave it standing — see this
    // function's own docstring for why a stale one is unsafe to trust on a later reopen.
    await abandonDispatchBaseline(run.repoPath, ticket);
    return;
  }
  await appendSessionLog(
    logPath,
    `[board-audit] ${ticket.id} failed after board evidence was found on ${result.ids.join(", ")} — ` +
      `preserved on the ticket for a resumed attempt to attribute.\n`,
  ).catch(() => {});
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
  /** Whether THIS ticket's delivery is board-only ({@link isBoardOnlyRun}) — decided from labels
   * alone, never from whether {@link boardBaseline} came back (anton-fc5x review round 4). Drives
   * which delivery-evidence path `assertDelivered` takes; `boardBaseline` only decides whether that
   * path can actually compare against something. */
  boardOnly: boolean;
  /** The pre-dispatch board read a board-only ticket's evidence check diffs against; null when this
   * ticket isn't board-only, or when it is but the baseline read itself failed (anton-fc5x). */
  boardBaseline: BoardFingerprint | null;
}): Promise<void> {
  const { run, ticket, ticketCtx, session, progress, boardOnly, boardBaseline } = args;
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
          // Meter the bare driver inside the resilience loop: every interrupted call and its
          // resumed successor are distinct paid attempts, even when the wrapper returns one result.
          driver: metered(db, ticketCtx.clock, {
            projectId: ticketCtx.projectId,
            jobType: ticketCtx.ctx.type,
            jobId: ticketCtx.ctx.jobId,
            step: cooked.id,
            runId: ticketCtx.runId,
            beadId: ticket.id,
            modelRequested: ticketCtx.settings?.model,
          }, runClaude),
        }),
        recordsEachAttempt: true,
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
      // Gated on `boardOnly`, never on `boardBaseline` alone (anton-fc5x review round 4) — an
      // unreadable baseline still owes this ticket the board-only path, just one that fails closed
      // instead of silently falling through to the tree-based check below.
      boardOnly
        ? boardBaseline
          ? () => readBoardEvidence(run.repoPath, boardBaseline, ticket)
          : () =>
              Promise.resolve<BoardEvidenceResult>({
                found: false,
                ids: [],
                synced: false,
                baselineUnavailable: true,
              })
        : undefined,
      boardOnly ? () => recordBoardOnlyAttribution(ticketCtx) : undefined,
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
 */
export async function assertDelivered(
  ticket: Bead,
  facts: StepFacts,
  progress: TicketProgress,
  branchAdded: BranchAddedCommit,
  /**
   * The board-only evidence check (anton-fc5x), present only when the caller resolved this
   * ticket's delivery as board-only ({@link isBoardOnlyRun} — the ticket's own `delivery:board`
   * label, or its run target's) and the pre-dispatch baseline read succeeded. `undefined` for every
   * other ticket, which is what keeps the zero-diff guard's plain-code behavior byte-for-byte
   * unchanged. Its mere presence IS the board-only verdict below — `assertDelivered` does not
   * re-derive it from the ticket alone, because that was exactly the anton-fc5x review round 2
   * finding 1/3 bug: a child ticket dispatched under a board-only-labelled run TARGET never carries
   * the label itself.
   */
  checkBoardEvidence?: () => Promise<BoardEvidenceResult>,
  /**
   * Records the empty attribution commit a confirmed board-only delivery needs on the branch
   * (anton-fc5x review round 3) — present exactly when `checkBoardEvidence` is, since both come from
   * the same board-only verdict. Without it, a board-only ticket settles `delivered` on a branch that
   * never moved, and the run's later `step:pr` fails `gh pr create` on an empty diff instead of
   * reaching review. `undefined` in a test that only exercises the board-evidence verdict itself,
   * which is why `committed` stays `false` unless this actually ran.
   */
  recordBoardAttribution?: () => Promise<void>,
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

  // A board-only ticket (anton-fc5x) has the BOARD as its evidence of record, never the tree —
  // resolved here, before the `committed` split below, so an incidental tree change (a stray
  // generated file, an accidental edit) can never let it fall into the tree-based "commit exists"
  // path and settle delivered on a commit that says nothing about whether any `bd` write actually
  // landed (PR #284 review round 2). Everything past this block assumes `checkBoardEvidence` is
  // absent.
  if (checkBoardEvidence) {
    await assertBoardOnlyDelivered(ticket, committed, selfReport, progress, {
      checkBoardEvidence,
      recordBoardAttribution,
    });
    return;
  }

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
    // Empty tree: the delivery-evidence gate blocks + halts. Cross-check the self-report and
    // fold it into the reason (anton-j5i8): a `delivered` claim on an empty tree is the exact
    // false success the gate exists to catch; a `blocked` self-report corroborates the block and
    // carries the agent's own reason forward; a `satisfied` claim that the branch did not bear out
    // is named as unverified. A missing line just reads as the plain gate message.
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
 * The board-only half of the delivery-evidence gate (anton-fc5x), split out of {@link
 * assertDelivered} so it can run BEFORE the tree-based `committed` split rather than nested inside
 * its `!committed` branch — a board-only ticket's deliverable is bd writes, and an incidental tree
 * change (a stray generated file, an accidental edit) must not let it take the tree-based "commit
 * exists" path and settle delivered without the board ever being checked (PR #284 review round 2).
 *
 * Mirrors the shape of the tree-based gate on purpose, with one deliberate difference: neither a
 * `satisfied` claim nor a `delivered` one ever settles straight off `branchAdded` or the ticket's
 * own `board-evidence-pending:*` label — both always re-confirm via {@link
 * evidence.checkBoardEvidence} (PR #284 review round 12, walking back round 11's shortcut). The
 * label records IDs a PRIOR attempt found, written BEFORE that attempt's confirming push (see
 * `readBoardEvidence`), so its presence alone proves writes were found once, never that they ever
 * reached the remote — a `satisfied` resume naming an incidental or sibling commit on the branch
 * (which `branchAdded` cannot tell from this ticket's own delivery) would otherwise settle
 * delivered, close the ticket, and clear that label without ever retrying the confirming push.
 * Everything else (an honest `blocked`, a missing line, or a claim `checkBoardEvidence` does not
 * confirm) is the same false-success shape a plain zero diff is, regardless of what — if
 * anything — the tree happened to pick up.
 */
async function assertBoardOnlyDelivered(
  ticket: Bead,
  committed: boolean,
  selfReport: TicketProgress["selfReport"],
  progress: TicketProgress,
  evidence: {
    checkBoardEvidence: () => Promise<BoardEvidenceResult>;
    recordBoardAttribution?: () => Promise<void>;
  },
): Promise<void> {
  if (selfReport?.outcome === "delivered" || selfReport?.outcome === "satisfied") {
    const result = await evidence.checkBoardEvidence();
    if (result.found && result.synced && !result.markerUnpersisted) {
      // The evidence is confirmed but the handoff isn't done yet — the marker stays on the bead
      // (readBoardEvidence never clears it) until the ticket's own success path releases it via
      // `clearBoardEvidencePending`, once attribution and close/in-review have actually gone
      // through (anton-fc5x review round 4). Recorded on `progress` because that path has no other
      // way to learn which ids this attempt's evidence check confirmed.
      progress.boardEvidenceIds = result.ids;
      // The board is confirmed. Record the empty attribution commit only when the branch genuinely
      // hasn't moved yet (anton-fc5x review round 3) — an incidental tree change already gives
      // `step:pr` a real diff to open against, so a second commit here would be redundant.
      if (!committed && evidence.recordBoardAttribution) {
        await evidence.recordBoardAttribution();
        progress.committed = true;
      }
      progress.delivered = true;
      return;
    }
    throw new NoDeliveryError(boardOnlyNoDeliveryMessage(ticket, result, selfReport));
  }
  // No verified evidence: an honest `blocked`, a missing line, or a `satisfied` claim the branch did
  // not bear out. Cross-checked and folded into the reason exactly as the tree-based gate does
  // (anton-j5i8) — never worded as a "zero diff", since this ticket's tree may well have changed.
  throw new NoDeliveryError(
    `${ticket.id} produced no delivery: this ticket is marked \`delivery:board\`, whose deliverable ` +
      `is bd writes to the board, not the git tree — and nothing here confirms any landed. Halting ` +
      `the epic for operator review — nothing verified landed, so closing it would be a false ` +
      `success. The ticket is left open (not blocked) so a resumed run can reclaim and retry it ` +
      `without a manual status edit.${selfReportSuffix(selfReport)}`,
  );
}

/**
 * Why a board-only ticket was never dispatched at all (PR #284 review, "Persist the board baseline
 * before dispatch") — the pre-dispatch read succeeded, but this attempt could not durably anchor it
 * to the ticket before letting the agent run. Kept as its own message, never folded into {@link
 * boardOnlyNoDeliveryMessage}'s `baselineUnavailable` case, because that one specifically claims the
 * READ failed — untrue here, and misleading for an operator diagnosing a persist/sync outage instead.
 */
function boardOnlyBaselineNotPersistedMessage(ticket: Bead): string {
  return (
    `${ticket.id} was not dispatched: this ticket is marked \`delivery:board\`, whose deliverable is bd ` +
    `writes to the board, not the git tree — the pre-dispatch board baseline was read but could not be ` +
    `durably persisted to the ticket (after retries). Dispatching anyway risks the agent's own bd ` +
    `writes landing before a process/host death, with no anchored baseline for a resumed attempt to ` +
    `compare against — a fresh read there would absorb those writes as pre-existing, and an idempotent ` +
    `retry would then diff as no evidence at all, permanently. Halting before dispatch instead: check ` +
    `the beads DB and the sync channel, then resume the run — the ticket is left open (not blocked) so ` +
    `that resume can reclaim it directly.`
  );
}

/**
 * Why a board-only ticket's zero diff still did not settle (anton-fc5x) — the two ways the board
 * evidence check can come up short, named precisely so the operator note says which.
 *
 * `selfReport` (chatgpt-codex-connector, PR #284 review, "message hardcodes 'self-reported
 * delivered'") lets the `!evidence.found` branch below report what the agent actually claimed via
 * {@link selfReportSuffix} rather than a literal "self-reported delivered" — `assertBoardOnlyDelivered`
 * reaches this whole function on EITHER a `delivered` or an unconfirmed `satisfied` self-report, and
 * the two read very differently to an operator: `satisfied` names a specific commit it claims already
 * covers this ticket, `delivered` claims a change this attempt itself made. The hardcoded wording
 * described only the first.
 */
function boardOnlyNoDeliveryMessage(
  ticket: Bead,
  evidence: BoardEvidenceResult,
  selfReport: TicketProgress["selfReport"],
): string {
  if (evidence.baselineUnavailable) {
    return (
      `${ticket.id} produced no delivery: this ticket is marked \`delivery:board\`, whose deliverable ` +
      `is bd writes to the board, not the git tree — but the pre-dispatch board baseline could not be ` +
      `read (after retries), so no comparison against it could be made at all. Halting the epic until ` +
      `the board read is healthy, then resume the run — an unreadable baseline fails closed rather ` +
      `than falling through to the tree-based check a board-only ticket must never settle on. The ` +
      `ticket is left open (not blocked) so that resume can reclaim it directly.`
    );
  }
  if (evidence.baselineUnpersisted) {
    return (
      `${ticket.id} produced no delivery: this ticket is marked \`delivery:board\`, whose deliverable ` +
      `is bd writes to the board, not the git tree — the post-run board read failed (after retries), ` +
      `and the recovery baseline this attempt tried to preserve for a resume could not be written even ` +
      `LOCALLY (after retries). Halting the epic for operator review — resuming on this machine is ` +
      `NOT specially safe here: with no baseline persisted anywhere, a same-machine resume falls back ` +
      `to the same fresh board read a different machine would, one that may already have absorbed this ` +
      `ticket's own already-synced writes as pre-existing, permanently rejecting an idempotent retry as ` +
      `unchanged.` +
      (evidence.ids.length > 0
        ? ` A prior attempt already confirmed evidence on ${evidence.ids.join(", ")}, which stays ` +
          `pending on the ticket and will be picked up once a healthy resume can compare it again.`
        : "") +
      ` Check the beads DB and the sync channel, then resume the run — the ticket is left ` +
      `open (not blocked) so that resume can reclaim it directly.`
    );
  }
  if (evidence.baselineUnconfirmed) {
    return (
      `${ticket.id} produced no delivery: this ticket is marked \`delivery:board\`, whose deliverable ` +
      `is bd writes to the board, not the git tree — the post-run board read failed (after retries), ` +
      `and the recovery baseline this attempt preserved locally could not be confirmed synced. ` +
      `Halting the epic for operator review — RESUMING ON THIS SAME MACHINE is safe (the baseline ` +
      `landed locally regardless of the push), but resuming on a different one will not see this ` +
      `attempt's baseline and may silently absorb this ticket's own already-synced writes as ` +
      `pre-existing, permanently rejecting an idempotent retry as unchanged.` +
      (evidence.ids.length > 0
        ? ` A prior attempt already confirmed evidence on ${evidence.ids.join(", ")}, which stays ` +
          `pending on the ticket and will be picked up once a healthy resume can compare it again.`
        : "") +
      ` Check the beads DB and ` +
      `the sync channel, then resume the run on this machine — the ticket is left open (not blocked) ` +
      `so that resume can reclaim it directly.`
    );
  }
  if (evidence.evidenceUnavailable) {
    return (
      `${ticket.id} produced no delivery: this ticket is marked \`delivery:board\`, whose deliverable ` +
      `is bd writes to the board, not the git tree — but the post-run board read could not be read ` +
      `(after retries), so no comparison against the pre-dispatch baseline could be made this attempt.` +
      (evidence.ids.length > 0
        ? ` A prior attempt already confirmed evidence on ${evidence.ids.join(", ")}, which stays ` +
          `pending on the ticket and will be picked up once the board read is healthy again.`
        : "") +
      ` Halting the epic until the board read is healthy, then resume the run — an unreadable ` +
      `post-run board fails closed rather than being asserted unchanged. The ticket is left open ` +
      `(not blocked) so that resume can reclaim it directly.`
    );
  }
  if (!evidence.found) {
    return (
      `${ticket.id} produced no delivery: claude exited cleanly and this ticket is marked ` +
      `\`delivery:board\` — but no bd write landed on the board since the ticket started (the whole ` +
      `board's title/description/status was compared against the pre-dispatch read and nothing ` +
      `differs). Halting the epic for operator review — a board-only ticket with no board evidence ` +
      `is the same false success a git zero diff is. The ticket is left open (not blocked) so a ` +
      `resumed run can reclaim and retry it without a manual status edit.${selfReportSuffix(selfReport)}`
    );
  }
  if (evidence.markerUnpersisted) {
    return (
      `${ticket.id} produced no delivery: bd writes were found on ${evidence.ids.join(", ")}` +
      (evidence.synced ? " and confirmed synced" : "") +
      `, but the pending-evidence marker that records them could not be persisted to the board ` +
      `(after retries). Halting the epic until the board write channel is healthy, then resume the ` +
      `run — without that marker, a crash before this ticket's attribution/close completes would ` +
      `strand this evidence with nothing left to recover it from. The ticket is left open (not ` +
      `blocked) so that resume can reclaim it directly.`
    );
  }
  return (
    `${ticket.id} produced no delivery: bd writes were found on ${evidence.ids.join(", ")} since ` +
    `the ticket started, but they could not be confirmed synced (\`bd dolt push\` did not report ` +
    `synced or shared-server). Halting the epic until the sync channel is healthy, then resume the ` +
    `run — the ticket is left open (not blocked) so that resume can reclaim it directly.`
  );
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
