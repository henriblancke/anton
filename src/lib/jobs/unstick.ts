/**
 * unstick job (anton-wvcy). The half of run-health that MOVES: it reads the sweep's report and turns
 * every finding into either an automatic resume or a founder-facing escalation — never into a silent
 * retry loop.
 *
 * The split is deliberately conservative. Only two classes of stall are provably safe to restart
 * without a human:
 *
 *   • a run parked on `usage-limit` whose quota window has since reopened — the park was never a
 *     failure, just a wait, and the thing it was waiting for has happened; and
 *   • a bead holding an EXPIRED run-lease with no foreign holder — the owning machine died, and no
 *     one else has since claimed the work.
 *
 * Everything else — an agent failure, a PR nobody reviewed, a job that spent its retries — is a
 * judgment call, so it becomes an escalation carrying its evidence and waits. A wrong auto-retry
 * burns quota on work that will fail the same way; a wrong escalation costs one glance.
 *
 * Two properties do the load-bearing work:
 *
 *   • IDEMPOTENCE — a resume is gated on there being no active execute-epic job for the epic, so
 *     the pass that acts leaves behind exactly the state that makes the NEXT pass a no-op. Running
 *     it hourly over an unchanged stall re-enqueues once, not once per hour. Escalations converge
 *     the same way, on `escalations_open_unique`.
 *   • RE-VERIFICATION — the report is a candidate list, never an authority. Every finding is
 *     re-checked against live runs/jobs/board/PR before anything is touched, so a report minutes or
 *     hours old can't resurrect a run that has since moved on, steal one a live job owns, or nag a
 *     founder about a PR that merged or a job someone already resumed. Escalations are re-checked
 *     for the same reason resumes are: a stale one asks for a decision on work that already moved,
 *     and its "abandon" would cancel it. The same re-check retires an escalation once its stall ends
 *     (see `settleEndedStalls`) — a report that has stopped carrying a finding is a candidate for
 *     retirement, never a verdict. The board half of that check is read after a PULL and fails
 *     closed when the pull doesn't land:
 *     run ownership is cross-machine state, and a stale local mirror of it can only be wrong in the
 *     direction that double-runs.
 */
import { beads, type Bead, type Gate } from "../beads/bd";
import { getPrActivity, type PrActivity } from "../git/pr";
import {
  DEFAULT_MAX_RETRIES,
  getProjectById,
  getProjectSettings,
  resolveRunHealthThresholds,
} from "../projects";
import { getRunHealthReport, type RunHealthFinding } from "../run-health";
import { listRunsByStatus, type RunRow } from "../runs";
import { detectExhaustedJobs, detectOpenHumanGates, detectStalePrs } from "./run-health";
import {
  listOpenEscalations,
  markEscalationNoted,
  raiseEscalation,
  settleEscalation,
  toEscalationView,
  type EscalationRow,
} from "../escalations";
import { parkedAskGateId, parkedAskGateIds, poisonBlockerIds, PoisonError } from "./errors";
import {
  activeExecuteEpicId,
  activeExecuteEpicKeys,
  enqueueExecuteEpicIfAbsent,
  getJob,
  latestExecuteEpicJob,
  resumableExecuteEpicId,
  resumeJob,
  systemClock,
  toMs,
  type AntonDb,
  type Clock,
  type JobRow,
} from "./queue";
import type { JobContext, JobEffect, JobHandler } from "./runner";

/** The park reason execute-epic records on a run it stopped because Claude's quota ran out. */
const USAGE_LIMIT_PARK = "usage-limit";

/** How the runner spells a quota backoff on the job row — the only record of when the window ends. */
const RESUMES_AT = /usage-limit: resumes at (\S+)/;

export interface UnstickPayload {
  projectId: string;
}

export interface UnstickDeps {
  db: AntonDb;
  clock?: Clock;
  /**
   * How the pass re-reads a PR before escalating a `stale-pr` finding. Injectable for the same
   * reason the sweep's is (tests, any future non-GitHub forge); the default is the real read-only
   * `gh pr view`.
   */
  readPrActivity?: (repo: string, number: number, signal?: AbortSignal) => Promise<PrActivity>;
}

/**
 * What the pass decided about one finding:
 *   • `resume`   — provably safe to restart; re-enqueue it.
 *   • `escalate` — needs a human; raise it on the board with its evidence.
 *   • `hold`     — do nothing THIS pass: the finding is stale, a live job already owns the work, or
 *                  it is still legitimately waiting (a usage window that hasn't reopened). Holding is
 *                  not an escalation — nagging a founder about a run that is about to resume itself
 *                  is exactly the noise that trains them to ignore the panel.
 */
export type UnstickDisposition = "resume" | "escalate" | "hold";

export interface UnstickVerdict {
  disposition: UnstickDisposition;
  /** Why, in one line — logged for a resume, carried into the escalation for everything else. */
  why: string;
  /** The epic a resume re-enqueues (jobs are keyed by epic, not by the ticket that stalled). */
  epicBeadId?: string;
}

/** The live state a verdict is judged against — never the report alone. */
export interface UnstickContext {
  projectId: string;
  nowMs: number;
  /** `${projectId}::${epicBeadId}` for execute-epic jobs that are queued or running. */
  activeEpicKeys: Set<string>;
  /** The project's still-parked runs, by id. A finding whose run is absent has moved on. */
  parkedRuns: Map<string, RunRow>;
  /** A fresh board read, by bead id. */
  board: Map<string, Bead>;
  /**
   * Whether `board` was read after a SUCCESSFUL pull of the shared remote. False means the local
   * Dolt working set may trail another machine's writes, so run-lease state can't be trusted — every
   * resume that depends on it stands down (see {@link leaseStandDown}).
   */
  boardFresh: boolean;
  /**
   * The project's dead-lease grace, in ms — the same one `detectDeadLeases` applies past expiry. The
   * re-check has to re-apply it, or it would be strictly weaker than the detector that raised the
   * finding and would resume inside the window the grace exists to protect.
   */
  deadLeaseGraceMs: number;
  /** When this epic's quota window reopens (ms epoch), or undefined when nothing recorded one. */
  usageWindowEndsAt: (epicBeadId: string) => number | undefined;
  /**
   * Whether the epic's most recent execute-epic job was CANCELLED. A cancel is an operator saying
   * stop, and `cancelJob` guarantees no durability path revives it — but it only settles the JOB, so
   * both resumable findings outlive it: a usage-limit park leaves its RUN row parked, and a cancel
   * that never reached the board (a crash, a failed `clearRunLease`/sync) leaves the bead's lease to
   * expire into a `dead-lease`. Without this, either one re-enqueues exactly the work that was
   * cancelled.
   */
  epicCancelled: (epicBeadId: string) => boolean;
  /**
   * Whether a `stale-pr` / `exhausted-job` / `needs-human` finding STILL satisfies the detector that
   * raised it, re-checked against the live PR, job row, and gate list. Those three kinds carry no
   * other live handle in this context — a run row or a bead — so without this the pass would
   * escalate a PR that merged, a job an operator resumed, or a gate the founder answered, in the
   * window between the sweep and now. Prefetched, because the classifier stays synchronous and pure.
   */
  stillStuck: (finding: RunHealthFinding) => boolean;
}

function hold(why: string): UnstickVerdict {
  return { disposition: "hold", why };
}

function escalate(why: string): UnstickVerdict {
  return { disposition: "escalate", why };
}

/**
 * Why a resume must stand down, or undefined when the epic is free to restart. A resume is a
 * CROSS-MACHINE act: the run-lease on the epic is the only record that another machine is executing
 * it, and this pass reads that off a board the local Dolt working set mirrors on a sync heartbeat.
 *
 * So an untrusted board (the pull failed — see `unstickPass`) fails CLOSED: an unnecessary hold
 * costs one more hour of stall, a double-run costs a duplicate PR and the quota to produce it.
 *
 * `ownRunId`, when given, is the stalled run's own id. execute-epic publishes the lease under the
 * run id, so a leftover from the very run being revived is ours, not a foreign holder; the dead-lease
 * path has no run of its own, so there any live lease is foreign.
 */
function leaseStandDown(
  ctx: UnstickContext,
  epicBeadId: string,
  ownRunId?: string,
): UnstickVerdict | undefined {
  if (!ctx.boardFresh) {
    return hold("the shared board could not be pulled, so a foreign run-lease can't be ruled out");
  }
  const bead = ctx.board.get(epicBeadId);
  if (!bead) return undefined;
  const foreign =
    ownRunId === undefined
      ? beads.isRunLive(bead, ctx.nowMs)
      : beads.foreignRunLeaseLive(bead, ctx.nowMs, ownRunId);
  return foreign ? hold("another machine holds a live run-lease") : undefined;
}

/**
 * Why this epic has already settled off-board, or undefined while it is still live work. Two shapes
 * of settled, one meaning: a CLOSED bead ended deliberately, and so did a DELETED one — the pass
 * lists every status, so a bead missing from a successfully pulled board was removed, not filtered.
 *
 * Neither disposition left makes sense on one: a resume hands execute-epic a bead it can only park
 * back on with `bead ... not found`, turning an intentional deletion into a poison job, and an
 * escalation offers an "abandon" that now throws on the gone bead — settling the escalation without
 * settling anything, every sweep, forever.
 *
 * Only trusted on a FRESH board, the same posture as {@link leaseStandDown}: read off a stale local
 * mirror, "closed" and "absent" are lag rather than evidence.
 */
function epicSettled(ctx: UnstickContext, epicBeadId: string): string | undefined {
  if (!ctx.boardFresh) return undefined;
  const bead = ctx.board.get(epicBeadId);
  if (!bead) return "the epic is gone from the board";
  if (bead.status === "closed") return "the epic has since closed";
  return undefined;
}

/**
 * When this job's quota window reopens. The runner records a usage-limit backoff on the JOB — a
 * `usage-limit: resumes at <ISO>` lastError and a `runAt` pushed to the reset — never on the run
 * row, whose bare `usage-limit` error can't say whether the quota is back. The lastError is read
 * first because it survives a later `runAt` change; `runAt` is the fallback for a job whose error
 * text was overwritten by a subsequent settle.
 */
export function usageWindowEnd(
  job: { lastError: string | null; runAt: unknown } | undefined,
): number | undefined {
  if (!job) return undefined;
  const match = RESUMES_AT.exec(job.lastError ?? "");
  if (match) {
    const parsed = Date.parse(match[1]!);
    if (Number.isFinite(parsed)) return parsed;
  }
  return toMs(job.runAt);
}

/**
 * Decide what to do about one finding, against live state. Pure — every input is explicit — so the
 * safety rules are testable without a runner, a board, or a clock.
 *
 * The judgment itself lives in one named classifier per finding KIND, each independently testable:
 * every stuck-shape the pass recognises is decided in its own function, so teaching it a new one is
 * a new entry in {@link CLASSIFIERS} rather than another branch in a block nobody can hold in their
 * head.
 */
export function classifyFinding(finding: RunHealthFinding, ctx: UnstickContext): UnstickVerdict {
  const classify = CLASSIFIERS[finding.kind];
  // A kind with no classifier is a stall nobody taught the pass to judge — a human decides it.
  return classify ? classify(finding, ctx) : escalate(finding.reason);
}

/** One kind's judgment: live state in, verdict out, no I/O. */
type FindingClassifier = (finding: RunHealthFinding, ctx: UnstickContext) => UnstickVerdict;

/** The stuck-shapes this pass recognises, one classifier each. */
const CLASSIFIERS: Partial<Record<RunHealthFinding["kind"], FindingClassifier>> = {
  "parked-run": classifyParkedRun,
  "dead-lease": classifyDeadLease,
  "stale-pr": classifyStalePr,
  "exhausted-job": classifyExhaustedJob,
  "needs-human": classifyNeedsHuman,
};

/** Whether a live (queued or running) execute-epic job on THIS machine already owns the epic. */
function ownedByLiveJob(ctx: UnstickContext, epicBeadId: string): boolean {
  return ctx.activeEpicKeys.has(`${ctx.projectId}::${epicBeadId}`);
}

/** A park execute-epic recorded because Claude's quota ran out — the one stall that is just a wait. */
function isQuotaPark(run: RunRow): boolean {
  return run.error?.trim() === USAGE_LIMIT_PARK;
}

/**
 * STUCK SHAPE: a run execute-epic parked and never came back to.
 *
 * Only a quota park is ever resumable, and only once its window has passed; every other park is a
 * judgment call. The report is a candidate list, so a run no longer in the parked set was resumed,
 * failed, or finished since the sweep — acting on that stale claim would be acting on a ghost.
 */
export function classifyParkedRun(
  finding: RunHealthFinding,
  ctx: UnstickContext,
): UnstickVerdict {
  const run = finding.runId ? ctx.parkedRuns.get(finding.runId) : undefined;
  if (!run) return hold("the run is no longer parked");
  return (
    parkedRunStandDown(run, ctx) ??
    (isQuotaPark(run) ? classifyQuotaPark(run, ctx) : classifyNonQuotaPark(finding, run, ctx))
  );
}

/**
 * Why this parked run is nobody's to act on this pass, or undefined while it is still a live stall.
 * Applies to a park of ANY reason, quota or not:
 *
 *   • a live job on this machine already owns the run;
 *   • the epic settled off-board — an abandon raised from an `exhausted-job` escalation closes the
 *     bead but has no run id to settle, and a deletion settles nothing at all, so the parked row
 *     simply never caught up. This is the only check standing between a deleted epic and a resume
 *     that parks straight back on `bead ... not found` (see {@link epicSettled});
 *   • an operator cancelled the epic's job, which is them saying stop. On a usage-limit park this is
 *     the only thing standing between the cancel and the window's expiry re-enqueuing it; on any
 *     other park it is what stops the pass asking the founder to re-decide a stop they already made,
 *     every hour, forever.
 */
function parkedRunStandDown(run: RunRow, ctx: UnstickContext): UnstickVerdict | undefined {
  if (ownedByLiveJob(ctx, run.epicBeadId)) return hold("a live job already owns this run");
  const settled = epicSettled(ctx, run.epicBeadId);
  if (settled) return hold(settled);
  if (ctx.epicCancelled(run.epicBeadId)) {
    return hold("this epic's latest job was cancelled by an operator");
  }
  return undefined;
}

/**
 * STUCK SHAPE: a park that was never a wait — an agent failure, a poisoned job, a blocked start.
 * Retrying is exactly what already failed, so it goes to a human carrying its evidence.
 *
 * Jobs are machine-local, so nothing before this rules out another machine having picked the epic
 * back up since the park. Escalating then puts Resume/Abandon in front of the founder for work that
 * is executing elsewhere, and the abandon closes the bead underneath it. Only a CONFIRMED foreign
 * lease holds: unlike a quota resume, an untrusted board still escalates — a missed escalation
 * strands the stall, a redundant one costs a glance.
 */
export function classifyNonQuotaPark(
  finding: RunHealthFinding,
  run: RunRow,
  ctx: UnstickContext,
): UnstickVerdict {
  const contested = ctx.boardFresh ? leaseStandDown(ctx, run.epicBeadId, run.id) : undefined;
  return contested ?? escalate(finding.reason);
}

/**
 * STUCK SHAPE: a run parked on `usage-limit` — a wait, not a failure. Resumable once the quota
 * window it was waiting for has passed and no other machine picked the epic up meanwhile.
 *
 * `activeEpicKeys` only rules out a run THIS machine owns; the run-lease is what rules out one
 * another machine took while this run sat parked.
 */
export function classifyQuotaPark(run: RunRow, ctx: UnstickContext): UnstickVerdict {
  const reopensAt = ctx.usageWindowEndsAt(run.epicBeadId);
  if (reopensAt !== undefined && reopensAt > ctx.nowMs) {
    return hold(`the usage window reopens at ${new Date(reopensAt).toISOString()}`);
  }
  return (
    leaseStandDown(ctx, run.epicBeadId, run.id) ?? {
      disposition: "resume",
      why: "parked on usage-limit and the quota window has passed",
      epicBeadId: run.epicBeadId,
    }
  );
}

/**
 * STUCK SHAPE: a bead still holding an EXPIRED run-lease — the machine executing it died. Resumable
 * when nothing has since picked it back up, the one restart that needs no human at all.
 */
export function classifyDeadLease(
  finding: RunHealthFinding,
  ctx: UnstickContext,
): UnstickVerdict {
  const bead = finding.beadId ? ctx.board.get(finding.beadId) : undefined;
  // A bead that vanished between the sweep and now settled its own way.
  if (!bead) return hold("the bead is gone from the board");
  return (
    deadLeaseTargetStandDown(bead, ctx) ??
    expiredLeaseStandDown(bead, ctx) ?? {
      disposition: "resume",
      why: "the run-lease expired with no foreign holder",
      epicBeadId: bead.id,
    }
  );
}

/**
 * Why the bead a dead lease sits on is not ours to revive, or undefined while it is still live work.
 * A closed bead settled its own way; the cancel is the same operator-said-stop rule the parked-run
 * path applies. A cancel clears the JOB, not the bead's run-lease label — a process that dies (or
 * fails its `clearRunLease`/sync) after terminalizing the row leaves the lease behind to expire, and
 * this finding is what it decays into. Resuming would reverse the cancel, and `resumeEpic` can't
 * catch that: cancelled jobs are outside its covering set, so it would enqueue a fresh one.
 */
function deadLeaseTargetStandDown(bead: Bead, ctx: UnstickContext): UnstickVerdict | undefined {
  if (bead.status === "closed") return hold("the bead has since closed");
  if (ownedByLiveJob(ctx, bead.id)) return hold("a live job already owns this run");
  if (ctx.epicCancelled(bead.id)) {
    return hold("this epic's latest job was cancelled by an operator");
  }
  return undefined;
}

/**
 * Why the lease itself doesn't justify a revive, or undefined when it is a genuine dead one:
 *
 *   • NO LEASE AT ALL — the owning run settled and swept its own label, so there is no dead run to
 *     revive and re-enqueuing would start fresh work nobody asked for. The finding's whole premise
 *     is an expired lease a dying owner left behind, so the predicate that raised it has to still
 *     hold against the pulled bead.
 *   • LIVE NOW — a machine picked the work back up after the sweep saw it expired; resuming would
 *     double-run the epic, the one thing the lease exists to prevent.
 *   • INSIDE THE GRACE — presence alone is a weaker bar than the detector's `expiry + grace <= now`,
 *     and the grace is the whole allowance for a refresh that ran late or a clock that skews. A
 *     REPLACEMENT lease taken after the sweep by a machine now missing a heartbeat reads as
 *     uncontested while its ticket may still be executing. Wait out the detector's own window.
 */
function expiredLeaseStandDown(bead: Bead, ctx: UnstickContext): UnstickVerdict | undefined {
  const expiry = beads.runLeaseExpiry(bead);
  if (expiry === undefined) return hold("the run-lease has since been cleared");
  const contested = leaseStandDown(ctx, bead.id);
  if (contested) return contested;
  return expiry + ctx.deadLeaseGraceMs > ctx.nowMs
    ? hold("the run-lease expired inside the dead-lease grace window")
    : undefined;
}

/**
 * STUCK SHAPE: a PR nobody reviewed. Never auto-actionable — a PR nobody reviewed needs a reviewer —
 * but re-checked first, because the report is a candidate list: a PR merged since the sweep would
 * otherwise be escalated as idle.
 */
export function classifyStalePr(finding: RunHealthFinding, ctx: UnstickContext): UnstickVerdict {
  return ctx.stillStuck(finding)
    ? escalate(finding.reason)
    : hold("the PR has since merged, closed, or been picked back up");
}

/**
 * STUCK SHAPE: a job that spent its whole retry budget. Never auto-actionable — retrying already
 * proved it doesn't fix it — and re-checked first, because a job resumed since the sweep would
 * otherwise be escalated as exhausted, where "abandon" then cancels live work.
 *
 * The settled-epic rule is the parked-run path's, and for the same loop: an abandon closes the bead
 * FIRST and only then cancels the job, so a failed cancel leaves a parked job under a closed — or
 * since-deleted — epic. Re-escalating that offers a "resume" that re-poisons on the missing bead and
 * an "abandon" whose `abandonTicket` now throws, settling the escalation without settling the job —
 * forever. Only an execute-epic finding carries an epic bead id; the job-only kinds skip this and
 * settle through `actOnJob`.
 */
export function classifyExhaustedJob(
  finding: RunHealthFinding,
  ctx: UnstickContext,
): UnstickVerdict {
  const settled = finding.beadId ? epicSettled(ctx, finding.beadId) : undefined;
  if (settled) return hold(settled);
  return ctx.stillStuck(finding)
    ? escalate(finding.reason)
    : hold("the job has since been resumed or settled");
}

/**
 * STUCK SHAPE: a run waiting on a person — a wait BY DESIGN, and the one stall a person ends without
 * touching anton at all (`bd gate resolve`, or answering a different escalation on the same gate).
 * The sweep runs on the hour and this pass at :10, so a gate answered inside that gap would
 * otherwise raise "Waiting on you" for a wait that already ended. The mirror case — a gate answered
 * AFTER the row was raised, which this hold can never see because later reports omit the finding
 * entirely — is retired by {@link settleEndedGateWaits}.
 */
export function classifyNeedsHuman(finding: RunHealthFinding, ctx: UnstickContext): UnstickVerdict {
  return ctx.stillStuck(finding)
    ? escalate(finding.reason)
    : hold("the gate has since been resolved or removed");
}

/**
 * What a resume attempt actually did — distinct outcomes so the log never overstates the action.
 * `job-cancelled` is a deliberate NON-action: an operator cancelled the epic's job under us, and a
 * cancel is never reversed by a resume.
 */
export type ResumeOutcome = "resumed-job" | "enqueued" | "already-active" | "job-cancelled";

/**
 * The two queue verbs a resume needs, injectable so the UI path can route them through the runner
 * singleton (which adds the project-teardown quiesce guard) while the job runs them db-directly.
 */
export interface EpicResumeOps {
  resume(jobId: string): Promise<boolean>;
  enqueueIfAbsent(projectId: string, epicBeadId: string): string | undefined;
}

/**
 * Restart an epic, picking the verb its local state calls for. Order matters:
 *
 *   1. An ACTIVE (queued/running) job already covers the epic → touch nothing. This is both the
 *      "never take a run a live job owns" rule and the idempotence guard that makes a second pass a
 *      no-op: the first pass's own resume left an active job behind.
 *   2. A settled-but-recoverable (parked/failed) job → resume THAT job, so it reuses its open run and
 *      worktree instead of starting a duplicate. `enqueueExecuteEpicIfAbsent` alone can't do this —
 *      a parked job counts as covering, so it would return undefined and quietly do nothing.
 *   3. Nothing left to resume, but the epic's LATEST job was CANCELLED → stop. The classifier's
 *      cancellation guard reads a snapshot taken earlier in the pass, so an operator who cancels in
 *      that window would otherwise be overruled here: cancelled rows don't cover the epic, so the
 *      enqueue below would hand them back the exact job they just stopped.
 *   4. Otherwise enqueue a fresh job, which respects `jobs_active_epic_unique` on its own.
 */
export async function resumeEpic(
  db: AntonDb,
  clock: Clock,
  projectId: string,
  epicBeadId: string,
  ops?: EpicResumeOps,
): Promise<ResumeOutcome> {
  const resume = ops?.resume ?? ((jobId: string) => resumeJob(db, clock, jobId));
  const enqueueIfAbsent =
    ops?.enqueueIfAbsent ??
    ((project: string, epic: string) => enqueueExecuteEpicIfAbsent(db, clock, project, epic));

  if (activeExecuteEpicId(db, projectId, epicBeadId)) return "already-active";
  const resumable = await resumableExecuteEpicId(db, projectId, epicBeadId);
  if (resumable && (await resume(resumable))) return "resumed-job";
  // Nothing was resumed — which is not the same as nothing having been there. A CANCEL is an
  // operator saying stop, and `cancelJob` promises no durability path revives it, but a cancelled row
  // covers neither the resumable lookup above nor the enqueue below, so falling straight through
  // would quietly hand back the exact job they just stopped. The window is wider than the `resume`
  // call: a cancel that lands BEFORE the lookup leaves it finding nothing at all. So the check is on
  // the epic's LATEST job — the same evidence the classifier's `epicCancelled` reads — which covers
  // both halves. Every other loser of that race (a concurrent enqueue, a settle) leaves a
  // non-cancelled latest job and is absorbed below by the enqueue's own covering check.
  const latest = await latestExecuteEpicJob(db, projectId, epicBeadId);
  if (latest?.status === "cancelled") return "job-cancelled";
  return enqueueIfAbsent(projectId, epicBeadId) ? "enqueued" : "already-active";
}

/**
 * The board-native record of an escalation: one machine note on the target bead, so the stall is
 * visible to anyone reading the board with `bd` and never only inside the anton UI. Single-line by
 * construction — beads stores notes as one newline-joined blob where each unindented line is a
 * separate machine entry (see beads/notes.ts), so an embedded newline would split into two notes.
 */
export function escalationNote(finding: RunHealthFinding, escalationId: string): string {
  const reason = finding.reason.replace(/\s+/g, " ").trim();
  // This note lands on the RUN TARGET, so an ask has to name the ticket it came from: the resumed
  // session reads its steering off that ticket's own notes, and one left here reaches no dispatch.
  const answer = finding.askBeadId ? ` Answer on ${finding.askBeadId}, as a note.` : "";
  // The escalation id is stamped in because bd notes are append-only with no dedupe: if the note
  // lands but `markEscalationNoted` doesn't, the next pass writes it again, and the token is what
  // tells a human reading the bead that the two entries are one escalation rather than two stalls.
  return (
    `anton: escalated a ${finding.kind} [${escalationId.slice(0, 8)}] — ${reason}.${answer} ` +
    `Nothing will retry this automatically; resume or abandon it from the anton board.`
  );
}

/** Tally of one pass, for the runner log and for tests to assert the shape of what happened. */
export interface UnstickSummary {
  findings: number;
  resumed: number;
  escalated: number;
  held: number;
  /**
   * Open escalations retired because the stall they asked about ended, or was never theirs to ask
   * about — of every kind (see {@link settleEndedStalls}, {@link settleEndedGateWaits} and
   * {@link settleGateBlockedJobWaits}).
   */
  settled: number;
}

/**
 * Run one unstick pass over the project's latest run-health report. Exported separately from the
 * handler so it can be driven directly with an injected clock/db.
 *
 * Bead writes (the escalation notes) are best-effort: a bd failure leaves `notedAt` unset so the
 * NEXT pass retries the note, rather than failing the pass and losing the resumes it already made.
 */
export async function unstickPass(
  deps: { db: AntonDb; clock: Clock; readPrActivity?: UnstickDeps["readPrActivity"] },
  opts: {
    projectId: string;
    repoPath: string;
    heartbeat?: () => Promise<void>;
    /** The job's abort signal, so a cancelled/timed-out pass kills its in-flight `gh` child too. */
    signal?: AbortSignal;
  },
): Promise<UnstickSummary> {
  const { db, clock } = deps;
  const readPrActivity = deps.readPrActivity ?? getPrActivity;
  const { projectId, repoPath } = opts;
  const heartbeat = opts.heartbeat ?? (async () => {});
  const summary: UnstickSummary = { findings: 0, resumed: 0, escalated: 0, held: 0, settled: 0 };

  const report = await getRunHealthReport(db, projectId);
  const findings = report?.findings ?? [];
  summary.findings = findings.length;

  // An open escalation OUTLIVES the report that raised it: once the stall ends the sweep simply
  // stops reporting the finding, so the loop below — which only ever visits findings in the CURRENT
  // report — never sees it again, and the row keeps claiming a stall that is over. Reconciling those
  // is why an empty report is not yet an idle pass: it is precisely the report an ended stall
  // produces. No report at all means the run-health sweep has never run here (it ships off by
  // default), and with no open row either there is nothing to act on: not an error, just an idle
  // pass.
  //
  // Candidates are the rows the current report no longer carries. A row still reported is either a
  // genuine stall or one the loop below re-raises anyway, so retiring it here would churn it
  // settle-raise every pass.
  const openRows = await listOpenEscalations(db, projectId);
  const reportedKeys = new Set(findings.map((f) => f.key));
  const orphanRows = openRows.filter((row) => !reportedKeys.has(row.findingKey));
  // A gate wait is the one kind reconciled whether or not the report still carries it: the gate list
  // answers "is anybody still waiting" outright, and the panel offers no Dismiss on a `needs-human`
  // row, so nothing else can retire one.
  const gateWaits = openRows.filter((row) => row.kind === "needs-human");
  // The special case one kind over: an `exhausted-job` row raised for a job parked on a human gate —
  // one that refused to start behind someone else's gate, or one that ARMED its own for an ask —
  // back before the sweep deduped the two halves of that one wait (`withoutGateBlockedJobs`).
  // Suppression retires the FINDING, never the row it already raised, and the job itself is still
  // legitimately parked — so only the gate id in the park message can tell this row is a duplicate
  // of the gate's own wait.
  const blockedJobWaits = orphanRows.filter(
    (row) =>
      row.kind === "exhausted-job" &&
      (poisonBlockerIds(row.reason) !== undefined || parkedAskGateId(row.reason) !== undefined),
  );
  // The general retirement, one live re-check per kind (see {@link settleEndedStalls}). Gate-blocked
  // rows stay in this set on purpose rather than being carved out: the gate path above retires one
  // only while a gate still owns its whole wait, so this is the fallback for the job itself ending
  // (resumed, vanished, or blocked by an ordinary prerequisite too) — without it those rows would
  // have no re-check at all. Rows the gate path just settled are dropped below, not re-read.
  const endedStalls = orphanRows.filter((row) => row.kind !== "needs-human");
  if (findings.length === 0 && gateWaits.length === 0 && endedStalls.length === 0) {
    return summary;
  }

  // Pull BEFORE reading the board, exactly as the runner's `liveRunCheck` does: the local Dolt
  // working set trails the shared remote by a sync heartbeat, so a run-lease another machine renewed
  // moments ago is invisible without this — and a resume judged against that stale snapshot would
  // re-run work someone else currently owns. A pull failure doesn't fail the pass (the escalation
  // half needs no shared state); it marks the board untrusted so the lease-gated resumes stand down.
  let boardFresh = true;
  await beads.pull(repoPath).catch((e) => {
    boardFresh = false;
    console.error(
      `[unstick] beads pull failed for ${projectId}; holding every lease-gated resume this pass`,
      e,
    );
  });

  // The thresholds come from the project's own settings so every re-check below applies the SAME bar
  // the sweep did — a re-check on a different bar is a second, undeclared policy.
  const [board, activeEpicKeys, parkedRunRows, settings] = await Promise.all([
    beads.list(repoPath, ["--status", "all"]),
    activeExecuteEpicKeys(db),
    listRunsByStatus(db, projectId, ["parked"]),
    getProjectSettings(db, projectId),
  ]);
  const thresholds = resolveRunHealthThresholds(settings);

  // One job read per epic at most, memoized: several findings can point at the same epic. The row
  // answers both job-side questions — when the quota window reopens, and whether it was cancelled.
  const latestJobs = new Map<string, JobRow | undefined>();
  // Per-finding re-check verdicts for the two kinds with no live handle in the context below.
  const stillStuck = new Map<string, boolean>();
  const ctx: UnstickContext = {
    projectId,
    nowMs: clock.now(),
    activeEpicKeys,
    parkedRuns: new Map(parkedRunRows.map((r) => [r.id, r])),
    board: new Map(board.map((b) => [b.id, b])),
    boardFresh,
    deadLeaseGraceMs: thresholds.deadLeaseMinutes * 60_000,
    usageWindowEndsAt: (epicBeadId) => usageWindowEnd(latestJobs.get(epicBeadId)),
    epicCancelled: (epicBeadId) => latestJobs.get(epicBeadId)?.status === "cancelled",
    // Absent → the finding was never re-checked (a kind that judges itself off the context), so the
    // report's word stands.
    stillStuck: (finding) => stillStuck.get(finding.key) ?? true,
  };

  // Prime the memo before classifying: the job-backed lookups are synchronous so the classifier
  // stays pure, which means the async job reads have to happen up front. An epic the memo never
  // learned about reads as "not cancelled", so every path that consults `epicCancelled` must prime.
  const primeLatestJob = async (epicBeadId: string) => {
    if (latestJobs.has(epicBeadId)) return;
    latestJobs.set(epicBeadId, await latestExecuteEpicJob(db, projectId, epicBeadId));
  };
  // Every parked run, not just the quota parks: the cancellation guard now applies to a park of any
  // reason, and an epic the memo never learned about reads as "not cancelled".
  for (const run of parkedRunRows) {
    await primeLatestJob(run.epicBeadId);
  }
  // A dead lease reads the same row for its cancellation guard; there the bead IS the epic.
  for (const finding of findings) {
    if (finding.kind === "dead-lease" && finding.beadId) await primeLatestJob(finding.beadId);
  }

  // Same reason again, but ONE read for every gate finding: `gate list` answers all of them at once,
  // and gate beads are absent from the ordinary board read above (see the sweep's own two reads).
  // The same read answers both halves of a gate wait's lifecycle — whether to raise one, and whether
  // an already-raised one is still waiting on anybody.
  const gateFindings = findings.filter((f) => f.kind === "needs-human");
  if (gateFindings.length > 0 || gateWaits.length > 0) {
    const openGates = await readOpenGates(repoPath);
    for (const finding of gateFindings) {
      stillStuck.set(finding.key, gateStillOpen(finding.gateId, openGates, board, ctx.nowMs));
    }
    summary.settled = await settleEndedGateWaits(db, clock, gateWaits, {
      openGates,
      board,
      nowMs: ctx.nowMs,
    });
    await heartbeat();
  }

  let gateBlockedSettled: ReadonlySet<string> = new Set();
  if (blockedJobWaits.length > 0) {
    gateBlockedSettled = await settleGateBlockedJobWaits(db, clock, repoPath, blockedJobWaits);
    summary.settled += gateBlockedSettled.size;
    await heartbeat();
  }

  // The re-checks the classifier and the retirement share, spelled once: a row can never be retired
  // on a different bar than the one its finding was raised on.
  const live: LiveRecheck = {
    ctx,
    repoPath,
    readPrActivity,
    stalePrThresholdMs: thresholds.stalePrHours * 3_600_000,
    maxAttempts: settings.maxRetries ?? DEFAULT_MAX_RETRIES,
    heartbeat,
    signal: opts.signal,
  };

  // A row the gate path already retired needs no second live re-read to reach the same verdict.
  const unsettledStalls = endedStalls.filter((row) => !gateBlockedSettled.has(row.id));
  if (unsettledStalls.length > 0) {
    summary.settled += await settleEndedStalls(db, clock, unsettledStalls, live);
  }

  // Same reason, one gh/job read per stale-pr / exhausted-job finding.
  for (const finding of findings) {
    if (finding.kind === "stale-pr") {
      stillStuck.set(finding.key, await stalePrStillStuck(finding, live));
      await heartbeat();
    } else if (finding.kind === "exhausted-job") {
      stillStuck.set(finding.key, await exhaustedJobStillStuck(db, finding, live));
    }
  }

  const actor: FindingActor = { db, clock, projectId, repoPath, ctx, heartbeat };
  let wroteBeads = false;
  for (const finding of findings) {
    // Stop acting the moment the job is cancelled or times out. Everything already done stands —
    // both verbs are idempotent, so the next pass picks up exactly where this one left off.
    opts.signal?.throwIfAborted();
    const { action, wroteBead } = await actOnFinding(finding, actor);
    summary[action] += 1;
    wroteBeads = wroteBead || wroteBeads;
  }

  // Every note above is a beads write; push it so the board-native record reaches teammates rather
  // than living only in this machine's Dolt working set. Logged, never thrown: a push failure must
  // not fail a pass whose resumes and escalations already landed locally.
  if (wroteBeads) {
    await beads
      .sync(repoPath)
      .catch((e) => console.error(`[unstick] beads dolt sync failed for ${projectId}`, e));
  }
  return summary;
}

/** Everything acting on one finding needs, gathered once so the per-finding step stays small. */
interface FindingActor {
  db: AntonDb;
  clock: Clock;
  projectId: string;
  repoPath: string;
  ctx: UnstickContext;
  heartbeat: () => Promise<void>;
}

/** Which of {@link UnstickSummary}'s counters one finding moved — the names are its own keys. */
type FindingAction = "resumed" | "escalated" | "held";

interface FindingOutcome {
  action: FindingAction;
  /** Whether a bd note actually landed, so the pass knows a push is owed. */
  wroteBead: boolean;
}

/** Carry out one finding's verdict. Holding is the pass deciding not to act, so it touches nothing. */
async function actOnFinding(
  finding: RunHealthFinding,
  actor: FindingActor,
): Promise<FindingOutcome> {
  const verdict = classifyFinding(finding, actor.ctx);
  if (verdict.disposition === "hold") return { action: "held", wroteBead: false };
  if (verdict.disposition === "resume" && verdict.epicBeadId) {
    const action = await resumeForFinding(finding, verdict, verdict.epicBeadId, actor);
    return { action, wroteBead: false };
  }
  return escalateFinding(finding, actor);
}

/**
 * Restart the epic a resume verdict names. Nothing restarted counts as HELD, not as a failure:
 * either a prior pass (or an operator) already did it — the idempotent path that makes an hourly
 * cron a no-op over an unchanged stall — or an operator cancelled the epic's job after this pass
 * classified it.
 */
async function resumeForFinding(
  finding: RunHealthFinding,
  verdict: UnstickVerdict,
  epicBeadId: string,
  actor: FindingActor,
): Promise<FindingAction> {
  const outcome = await resumeEpic(actor.db, actor.clock, actor.projectId, epicBeadId);
  const restarted = outcome === "resumed-job" || outcome === "enqueued";
  if (restarted) {
    console.log(`[unstick] ${outcome} ${epicBeadId} (${finding.key}): ${verdict.why}`);
  }
  await actor.heartbeat();
  return restarted ? "resumed" : "held";
}

/**
 * Raise the finding on the board with its evidence, and note it on the target bead. A row that
 * already existed converges on `escalations_open_unique` rather than counting twice — the same
 * idempotence the resume path has.
 */
async function escalateFinding(
  finding: RunHealthFinding,
  actor: FindingActor,
): Promise<FindingOutcome> {
  const { escalation, created } = await raiseEscalation(actor.db, actor.clock, {
    projectId: actor.projectId,
    finding,
    epicBeadId: epicBeadIdFor(finding, actor.ctx),
  });
  const wroteBead = await writeEscalationNote(
    actor.repoPath,
    escalation,
    finding,
    actor.db,
    actor.clock,
  );
  await actor.heartbeat();
  return { action: created ? "escalated" : "held", wroteBead };
}

/**
 * Retire every open escalation whose stall has ENDED — the general case {@link settleEndedGateWaits}
 * only ever covered for gates.
 *
 * An escalation is raised from a finding, and `classifyFinding` only ever runs over the findings in
 * the CURRENT report. So the moment a stall clears, its finding vanishes from the report and its row
 * becomes unreachable: no later pass visits it, no re-check ever runs against it, and it sits on the
 * board claiming a stall that is over. The strip then stops being a list of things that need a
 * decision, which is the only thing it is for.
 *
 * Two rules keep this from being a dismiss-everything:
 *
 *   • ABSENCE IS A CANDIDATE, NOT A VERDICT. The report going quiet is what makes a row worth
 *     re-checking, never what retires it. Each kind is retired only on its own live evidence, by the
 *     same re-check that gates RAISING it — a `stale-pr` on {@link stalePrStillStuck}, an
 *     `exhausted-job` on {@link exhaustedJobStillStuck}, a `parked-run` on the run row itself. A
 *     stall the sweep merely stopped reporting (a threshold change, a suppression) keeps its row.
 *   • ONLY ORPHANS. A row the current report still carries is not passed in at all: it is either a
 *     live stall or one the pass re-raises anyway, so retiring it would churn settle-raise hourly.
 *
 * `dismissed`, like the two paths above: the stall ended without anton acting on it, so claiming it
 * was resumed or abandoned here would record a decision nobody made. Best-effort and fails OPEN — a
 * failed re-check or a failed settle logs and leaves the row for the next pass rather than failing a
 * pass whose resumes already landed. An abort is the exception: that is the pass being stopped, not
 * evidence, so it propagates.
 */
async function settleEndedStalls(
  db: AntonDb,
  clock: Clock,
  rows: EscalationRow[],
  live: LiveRecheck,
): Promise<number> {
  let settled = 0;
  for (const row of rows) {
    try {
      const ended = await stallEnded(db, row, live);
      await live.heartbeat();
      if (!ended) continue;
      if (!(await settleEscalation(db, clock, row.id, "dismissed"))) continue;
      settled += 1;
      console.log(`[unstick] settled escalation ${row.id} (${row.findingKey}): ${ended}`);
    } catch (e) {
      live.signal?.throwIfAborted();
      console.error(
        `[unstick] could not reconcile escalation ${row.id} (${row.findingKey}); keeping it for ` +
          `the next pass`,
        e,
      );
    }
  }
  return settled;
}

/**
 * Why this open row's stall is over, or undefined while it still holds — the retirement counterpart
 * of {@link classifyFinding}, asked of a ROW rather than a finding. Read through
 * {@link toEscalationView} the way the panel reads it, so a row whose evidence blob is unparseable
 * degrades to "keep it" rather than losing its stall silently.
 */
async function stallEnded(
  db: AntonDb,
  row: EscalationRow,
  live: LiveRecheck,
): Promise<string | undefined> {
  const view = toEscalationView(row);
  switch (view.kind) {
    case "parked-run":
      // The run row IS the evidence, and the pass already read every parked run: one absent from
      // that set was resumed, failed, or finished — the same read `classifyFinding` holds a stale
      // parked-run finding on.
      return view.runId && !live.ctx.parkedRuns.has(view.runId)
        ? "the run is no longer parked"
        : undefined;

    case "stale-pr":
      return (await stalePrStillStuck(view, live))
        ? undefined
        : "the PR has since merged, closed, or been picked back up";

    case "exhausted-job":
      return (await exhaustedJobStillStuck(db, view, live))
        ? undefined
        : "the job has since been resumed or settled";

    default:
      // `needs-human` is retired by its own gate re-check ({@link settleEndedGateWaits}), and
      // `dead-lease` never escalates at all — it only ever resumes or holds. Anything else has no
      // re-check to reuse, and a row is only ever retired on evidence.
      return undefined;
  }
}

/**
 * The live handles the per-kind re-checks read, gathered once. Shared by the finding loop (which
 * asks before RAISING a row) and by {@link settleEndedStalls} (which asks before RETIRING one), so a
 * stall can never be judged on one bar and retired on another.
 */
interface LiveRecheck {
  ctx: UnstickContext;
  repoPath: string;
  readPrActivity: NonNullable<UnstickDeps["readPrActivity"]>;
  /** The sweep's own `stalePrHours`, in ms — a re-check on a different bar is a second policy. */
  stalePrThresholdMs: number;
  /** The project's retry budget, the bar `detectExhaustedJobs` judges a job against. */
  maxAttempts: number;
  heartbeat: () => Promise<void>;
  signal?: AbortSignal;
}

/**
 * Has the bead a `stale-pr` finding hangs on already settled off-board? Two shapes of settled, one
 * meaning — the same rule {@link epicSettled} applies to the other kinds: a CLOSED target ended
 * deliberately, and so did a DELETED one, since the pass lists every status and a bead missing from
 * a pulled board was removed rather than filtered. Escalating either offers an abandon that throws
 * on the gone bead and a note that fails to write, so the same finding comes back every sweep.
 *
 * Only counts on a FRESH board: a closed or absent bead read off a stale local mirror is not
 * evidence the work is done.
 */
function prTargetSettled(finding: Pick<RunHealthFinding, "beadId">, ctx: UnstickContext): boolean {
  if (!ctx.boardFresh || !finding.beadId) return false;
  const bead = ctx.board.get(finding.beadId);
  return !bead || bead.status === "closed";
}

/**
 * Is the PR itself still idle? Re-read through the sweep's OWN detector, so the two can never drift
 * on what "idle" means.
 *
 * Fails OPEN — an unreadable PR keeps the finding — because a missed escalation strands the stall
 * the sweep exists to surface, while a redundant one costs a glance. An abort is not an unreadable
 * PR: the pass itself is being stopped, so failing open there would escalate on behalf of a
 * cancelled job. Let it propagate and settle the job instead.
 */
async function prStillIdle(beadId: string, prNumber: number, live: LiveRecheck): Promise<boolean> {
  try {
    const activity = await live.readPrActivity(live.repoPath, prNumber, live.signal);
    return (
      detectStalePrs([{ beadId, activity }], live.ctx.nowMs, live.stalePrThresholdMs).length > 0
    );
  } catch (e) {
    live.signal?.throwIfAborted();
    console.error(
      `[unstick] could not re-read PR #${prNumber} for ${beadId}; escalating on the report's word`,
      e,
    );
    return true;
  }
}

/**
 * Does a `stale-pr` finding still hold? A PR that merged, closed, or was touched since the report is
 * no longer stalled, and escalating it would ask a founder to judge work that already moved. A
 * finding naming no PR or no bead has nothing left to re-read, so the report's word stands.
 */
async function stalePrStillStuck(
  finding: Pick<RunHealthFinding, "beadId" | "prNumber">,
  live: LiveRecheck,
): Promise<boolean> {
  if (prTargetSettled(finding, live.ctx)) return false;
  if (finding.prNumber === undefined || !finding.beadId) return true;
  return prStillIdle(finding.beadId, finding.prNumber, live);
}

/**
 * The project's OPEN gates (bd's `gate list` default), or undefined when bd could not answer. That
 * undefined fails OPEN in {@link gateStillOpen}, the same posture as the other two re-checks: an
 * unreadable board is no evidence a wait ended, and a missed escalation strands the human the sweep
 * exists to find.
 */
async function readOpenGates(repoPath: string): Promise<Gate[] | undefined> {
  try {
    return await beads.gateList(repoPath);
  } catch (e) {
    console.error("[unstick] could not re-read the gate list; escalating on the report's word", e);
    return undefined;
  }
}

/**
 * Is this gate still waiting on somebody? A human gate is the one stall a person can end outside
 * anton entirely, and the report is up to a sweep old, so escalating without re-reading asks the
 * founder to answer a wait they already answered. Asked of a FINDING before raising a row, and of an
 * open row's own gate before retiring it (see {@link settleEndedGateWaits}) — one question, one
 * answer, so a wait can never be raised on one rule and retired on another.
 *
 * Judged by the sweep's OWN detector, so the two can never drift on what an open human gate is. A
 * gate absent from the open list was resolved or deleted, which end the wait alike — and both are
 * evidence even on an untrusted board, since either could only reach this mirror by being made here
 * or synced in.
 */
function gateStillOpen(
  gateId: string | undefined,
  openGates: Gate[] | undefined,
  board: Bead[],
  nowMs: number,
): boolean {
  if (!openGates || !gateId) return true;
  const gate = openGates.find((g) => g.id === gateId);
  if (!gate) return false;
  return detectOpenHumanGates([gate], board, nowMs).length > 0;
}

/**
 * Retire the open gate waits whose gate has since been answered, and report how many. The re-check
 * above only covers the window BEFORE a wait is raised; this covers the far longer one after, and it
 * is the only thing that does. Once the gate closes, the sweep stops reporting the finding
 * altogether — so no later pass re-checks it, and the escalation sits on the board asking a founder
 * to answer a wait they already ended. A `needs-human` row is also the one kind the panel offers no
 * Dismiss on (a wait on a person is not something to acknowledge and leave open), so nothing else
 * can retire it: the two answers it does offer would resolve an already-closed gate and restart work
 * nobody asked to restart.
 *
 * Settled as `dismissed` — the resolution for a stall that ended without anton acting. The wait was
 * answered off-board (`bd gate resolve`, another operator, another machine), so claiming it was
 * resumed or abandoned here would record a decision nobody made. This is a settle only: the gate is
 * already closed and the work it blocked, if any, is gate-check's to pick up exactly as it would be
 * for a gate closed by hand.
 *
 * Fails OPEN on an unreadable gate list, the same posture as {@link gateStillOpen}: bd's silence is
 * no evidence a wait ended, and the next pass reconciles it anyway. The settle is the same status
 * CAS a founder's click takes, so a click landing in this window still wins exactly once.
 */
async function settleEndedGateWaits(
  db: AntonDb,
  clock: Clock,
  waits: EscalationRow[],
  live: { openGates: Gate[] | undefined; board: Bead[]; nowMs: number },
): Promise<number> {
  if (!live.openGates) return 0;
  let settled = 0;
  for (const wait of waits) {
    // The gate id lives in the evidence blob, not a column of its own — read it the way the panel
    // does, so a row whose evidence can't be parsed keeps its wait rather than losing it silently.
    const { gateId } = toEscalationView(wait);
    if (gateStillOpen(gateId, live.openGates, live.board, live.nowMs)) continue;
    if (!(await settleEscalation(db, clock, wait.id, "dismissed"))) continue;
    settled += 1;
    console.log(
      `[unstick] settled escalation ${wait.id} (${wait.findingKey}): the gate has since been ` +
        `resolved or removed`,
    );
  }
  return settled;
}

/**
 * Every HUMAN gate this repo has, open or resolved (`gate list --all`) — undefined when bd could not
 * answer. Read separately from the open list the rest of the pass uses, because the question here is
 * the other one: not "is this gate still waiting" but "was this blocker a human gate at all", which
 * only a listing that survives the gate's own resolution can answer.
 */
async function readHumanGateIds(repoPath: string): Promise<Set<string> | undefined> {
  try {
    const gates = await beads.gateList(repoPath, { all: true });
    return new Set(
      gates.filter((g) => g.issue_type === "gate" && g.await_type === "human").map((g) => g.id),
    );
  } catch (e) {
    console.error(
      "[unstick] could not re-read the full gate list; keeping every open exhausted-job escalation",
      e,
    );
    return undefined;
  }
}

/**
 * Retire the `exhausted-job` rows that are a human gate's wait wearing a second face.
 *
 * Two shapes reach here: a gate hung on work whose job was already queued poison-parks that job on
 * the gate, and a run that ARMED a human gate for its own ask parks on the gate it just made. Either
 * way a sweep from before the dedupe (`withoutGateBlockedJobs`) raised BOTH halves as escalations.
 * Suppression only stops the finding being reported again — the row it already raised is now
 * invisible to every re-check the pass makes, so it sits on the board forever as a "Retries spent"
 * failure carrying an Abandon that would cancel work the gate is merely waiting on.
 *
 * Settled when EVERY gate the park names is a human gate, which covers both ends of the gate's
 * life: while it is open the `needs-human` row carries the wait, and once it is answered the wait is
 * over and gate-check resumes the job. A job also held by an ordinary prerequisite is left alone —
 * that outlives the gate, and nothing else would surface it. So is a job still parked after its gate
 * was answered: the sweep reports that one again, so it never reaches this list at all.
 *
 * `dismissed`, like {@link settleEndedGateWaits}: the row is retired because it was never a stall of
 * its own, not because anton acted on it. Fails OPEN on an unreadable gate list, for the same reason.
 *
 * Returns the ids it retired, so the general retirement — which keeps these rows as its fallback for
 * the job itself ending — can skip the ones already decided here.
 */
async function settleGateBlockedJobWaits(
  db: AntonDb,
  clock: Clock,
  repoPath: string,
  waits: EscalationRow[],
): Promise<ReadonlySet<string>> {
  const settled = new Set<string>();
  const humanGateIds = await readHumanGateIds(repoPath);
  if (!humanGateIds) return settled;
  for (const wait of waits) {
    // An armed ask names the gate it armed plus the holds that outlive it; a blocked park names
    // every bead that held the run, and only a set that is ALL human gates is the gate's wait
    // wearing a second face.
    const parkedOn = parkedAskGateIds(wait.reason);
    const blockers = parkedOn ?? poisonBlockerIds(wait.reason);
    if (!blockers?.every((id) => humanGateIds.has(id))) continue;
    if (!(await settleEscalation(db, clock, wait.id, "dismissed"))) continue;
    settled.add(wait.id);
    console.log(
      `[unstick] settled escalation ${wait.id} (${wait.findingKey}): the job it reports is parked ` +
        `on a human gate, which carries that wait on its own`,
    );
  }
  return settled;
}

/**
 * Does an `exhausted-job` finding still hold? A job an operator (or a prior escalation) resumed
 * between the sweep and now is live work again — escalating it would offer an "abandon" that
 * cancels a running job. Judged by the sweep's own detector against the CURRENT row; a job that has
 * vanished settled its own way.
 *
 * Fails OPEN on a read error, the same posture as {@link stalePrStillStuck}: a locked SQLite would
 * otherwise throw straight through the caller's loop and abandon every finding after it, losing the
 * resumes and escalations of a whole pass over one transient error.
 */
async function exhaustedJobStillStuck(
  db: AntonDb,
  finding: Pick<RunHealthFinding, "jobId">,
  live: LiveRecheck,
): Promise<boolean> {
  if (!finding.jobId) return true;
  try {
    const job = await getJob(db, finding.jobId);
    if (!job) return false;
    return detectExhaustedJobs([job], live.maxAttempts, live.ctx.nowMs).length > 0;
  } catch (e) {
    console.error(
      `[unstick] could not re-read job ${finding.jobId}; escalating on the report's word`,
      e,
    );
    return true;
  }
}

/**
 * The epic an escalation's resume button would target. For a parked run that's the run's epic (the
 * finding names the ticket, but jobs are keyed by epic); otherwise the run target the detector
 * resolved, falling back to the finding's own bead — which for a stale PR or a dead lease IS the
 * run target.
 *
 * NO fallback for a human gate, which is the one kind whose bead is arbitrary: a founder may hang
 * one on a molecule step or on anything else anton never dispatches, and `detectOpenHumanGates`
 * reports that wait with no `targetBeadId` precisely because there is no run target above it.
 * Falling back would point the resume at a bead execute-epic cannot run; leaving it undefined lets
 * resolve-and-resume close the gate and stop there (see escalation-gate.ts).
 */
function epicBeadIdFor(finding: RunHealthFinding, ctx: UnstickContext): string | undefined {
  if (finding.kind === "parked-run" && finding.runId) {
    return ctx.parkedRuns.get(finding.runId)?.epicBeadId;
  }
  if (finding.kind === "needs-human") return finding.targetBeadId;
  return finding.targetBeadId ?? finding.beadId;
}

/**
 * Write the escalation's bd note, once. Returns whether a note was actually written (so the caller
 * knows whether a sync is owed). An escalation with no bead has nowhere to write — it stays visible
 * on the board panel alone rather than blocking the pass.
 */
async function writeEscalationNote(
  repoPath: string,
  escalation: EscalationRow,
  finding: RunHealthFinding,
  db: AntonDb,
  clock: Clock,
): Promise<boolean> {
  if (!escalation.beadId || escalation.notedAt != null) return false;
  try {
    await beads.note(repoPath, escalation.beadId, escalationNote(finding, escalation.id));
    await markEscalationNoted(db, clock, escalation.id);
    return true;
  } catch (e) {
    // Left unstamped on purpose: the next pass retries it, so a transient bd failure can't silently
    // cost the board its only off-anton record of the escalation.
    console.error(`[unstick] could not note escalation on ${escalation.beadId}`, e);
    return false;
  }
}

/** Build the runner handler bound to a db/clock. Register it as the "unstick" handler. */
export function makeUnstickHandler(deps: UnstickDeps): JobHandler {
  const db = deps.db;
  const clock = deps.clock ?? systemClock;
  const readPrActivity = deps.readPrActivity;

  return async function unstick(ctx: JobContext): Promise<JobEffect> {
    const { projectId } = ctx.payload as UnstickPayload;
    const project = await getProjectById(db, projectId);
    if (!project) throw new PoisonError(`project ${projectId} not found`);

    const summary = await unstickPass(
      { db, clock, readPrActivity },
      {
        projectId,
        repoPath: project.repoPath,
        heartbeat: () => ctx.heartbeat(),
        signal: ctx.signal,
      },
    );
    console.log(
      `[unstick] ${project.slug}: ${summary.findings} findings — ` +
        `${summary.resumed} resumed, ${summary.escalated} escalated, ${summary.held} held, ` +
        `${summary.settled} settled`,
    );

    // `held` is deliberately NOT an effect: holding a finding is the pass deciding not to act on it.
    const acted = summary.resumed + summary.escalated + summary.settled;
    return acted > 0
      ? {
          changed: true,
          note: `${summary.resumed} resumed, ${summary.escalated} escalated, ${summary.settled} settled`,
        }
      : { changed: false, note: summary.findings > 0 ? "findings held, none actionable" : "nothing to unstick" };
  };
}
