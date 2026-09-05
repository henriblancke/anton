/**
 * What brackets ONE ticket's walk (anton-owlx — extracted from execute-epic-ticket.ts): the claim it
 * must hold before any work, the session and step context its steps run in, the wall clock they run
 * under, and the single board write its committed work earns.
 *
 * Everything here is bookkeeping the walk needs done but does not itself decide. What happens when a
 * ticket stops short is the settlement's (execute-epic-ticket-settle.ts).
 */
import { beads, labelValueOf, LABELS, type Bead } from "../beads/bd";
import { readWorktreeState, type WorktreeState } from "../git/ops";
import { updateRun } from "../runs";
import { endSession, startJobSession, type JobSession } from "../sessions";
import { PoisonEpic } from "./errors";
import { mustPersist, safe } from "./execute-epic-persist";
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
      // Same restore the retryable-failure path performs, for the same reason.
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

/** Arm this ticket's deadline, derived from the job's own signal. */
export function startTicketBudget(
  ctx: Pick<JobContext, "signal">,
  timeoutMs: number,
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
  const deadline =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          ranOutOfTime = true;
          ticketAbort.abort();
        }, timeoutMs)
      : null;
  if (deadline && typeof deadline.unref === "function") deadline.unref();
  return {
    signal: ticketAbort.signal,
    ranOutOfTime: () => ranOutOfTime,
    stop: () => {
      if (deadline) clearTimeout(deadline);
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

/** Persist this ticket's "code done" state the moment it commits. */
export async function finishTicket(
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
