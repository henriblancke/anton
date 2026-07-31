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
 *     re-checked against live runs/jobs/board before anything is touched, so a report minutes or
 *     hours old can't resurrect a run that has since moved on, nor steal one a live job owns.
 */
import { beads, type Bead } from "../beads/bd";
import { getProjectById } from "../projects";
import { getRunHealthReport, type RunHealthFinding } from "../run-health";
import { listRunsByStatus, type RunRow } from "../runs";
import {
  markEscalationNoted,
  raiseEscalation,
  type EscalationRow,
} from "../escalations";
import { PoisonError } from "./errors";
import {
  activeExecuteEpicId,
  activeExecuteEpicKeys,
  enqueueExecuteEpicIfAbsent,
  latestExecuteEpicJob,
  resumableExecuteEpicId,
  resumeJob,
  systemClock,
  toMs,
  type AntonDb,
  type Clock,
} from "./queue";
import type { JobContext, JobHandler } from "./runner";

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
  /** When this epic's quota window reopens (ms epoch), or undefined when nothing recorded one. */
  usageWindowEndsAt: (epicBeadId: string) => number | undefined;
}

function hold(why: string): UnstickVerdict {
  return { disposition: "hold", why };
}

function escalate(why: string): UnstickVerdict {
  return { disposition: "escalate", why };
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
 */
export function classifyFinding(
  finding: RunHealthFinding,
  ctx: UnstickContext,
): UnstickVerdict {
  const ownedByLiveJob = (epicBeadId: string) =>
    ctx.activeEpicKeys.has(`${ctx.projectId}::${epicBeadId}`);

  switch (finding.kind) {
    case "parked-run": {
      const run = finding.runId ? ctx.parkedRuns.get(finding.runId) : undefined;
      // The report is a candidate list: a run that is no longer parked was resumed, failed, or
      // finished since the sweep, and acting on the stale claim would be acting on a ghost.
      if (!run) return hold("the run is no longer parked");
      if (ownedByLiveJob(run.epicBeadId)) return hold("a live job already owns this run");
      if (run.error?.trim() !== USAGE_LIMIT_PARK) {
        return escalate(finding.reason);
      }
      const reopensAt = ctx.usageWindowEndsAt(run.epicBeadId);
      if (reopensAt !== undefined && reopensAt > ctx.nowMs) {
        return hold(`the usage window reopens at ${new Date(reopensAt).toISOString()}`);
      }
      return {
        disposition: "resume",
        why: "parked on usage-limit and the quota window has passed",
        epicBeadId: run.epicBeadId,
      };
    }

    case "dead-lease": {
      const bead = finding.beadId ? ctx.board.get(finding.beadId) : undefined;
      // A bead that vanished or closed between the sweep and now has settled its own way.
      if (!bead) return hold("the bead is gone from the board");
      if (bead.status === "closed") return hold("the bead has since closed");
      if (ownedByLiveJob(bead.id)) return hold("a live job already owns this run");
      // A lease that is live NOW belongs to a machine that picked the work back up after the sweep
      // saw it expired — resuming here would double-run the epic, the one thing the lease exists to
      // prevent. That is a foreign holder, so this pass stands down entirely.
      if (beads.isRunLive(bead, ctx.nowMs)) return hold("another machine holds a live run-lease");
      return {
        disposition: "resume",
        why: "the run-lease expired with no foreign holder",
        epicBeadId: bead.id,
      };
    }

    // stale-pr and exhausted-job are never auto-actionable: a PR nobody reviewed needs a reviewer,
    // and a job that spent its whole retry budget already proved retrying doesn't fix it.
    default:
      return escalate(finding.reason);
  }
}

/** What a resume attempt actually did — distinct outcomes so the log never overstates the action. */
export type ResumeOutcome = "resumed-job" | "enqueued" | "already-active";

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
 *   3. Otherwise enqueue a fresh job, which respects `jobs_active_epic_unique` on its own.
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
  // Either there was no job to resume, or one raced us into an active status; both are correctly
  // absorbed here — the enqueue no-ops when a covering job now exists.
  return enqueueIfAbsent(projectId, epicBeadId) ? "enqueued" : "already-active";
}

/**
 * The board-native record of an escalation: one machine note on the target bead, so the stall is
 * visible to anyone reading the board with `bd` and never only inside the anton UI. Single-line by
 * construction — beads stores notes as one newline-joined blob where each unindented line is a
 * separate machine entry (see beads/notes.ts), so an embedded newline would split into two notes.
 */
export function escalationNote(finding: RunHealthFinding): string {
  const reason = finding.reason.replace(/\s+/g, " ").trim();
  return (
    `anton: escalated a ${finding.kind} — ${reason}. Nothing will retry this automatically; ` +
    `resume or abandon it from the anton board.`
  );
}

/** Tally of one pass, for the runner log and for tests to assert the shape of what happened. */
export interface UnstickSummary {
  findings: number;
  resumed: number;
  escalated: number;
  held: number;
}

/**
 * Run one unstick pass over the project's latest run-health report. Exported separately from the
 * handler so it can be driven directly with an injected clock/db.
 *
 * Bead writes (the escalation notes) are best-effort: a bd failure leaves `notedAt` unset so the
 * NEXT pass retries the note, rather than failing the pass and losing the resumes it already made.
 */
export async function unstickPass(
  deps: { db: AntonDb; clock: Clock },
  opts: { projectId: string; repoPath: string; heartbeat?: () => Promise<void> },
): Promise<UnstickSummary> {
  const { db, clock } = deps;
  const { projectId, repoPath } = opts;
  const heartbeat = opts.heartbeat ?? (async () => {});
  const summary: UnstickSummary = { findings: 0, resumed: 0, escalated: 0, held: 0 };

  const report = await getRunHealthReport(db, projectId);
  // No report means the run-health sweep has never run for this project (it ships off by default),
  // so there is nothing to act on — not an error, just an idle pass.
  if (!report || report.findings.length === 0) return summary;
  summary.findings = report.findings.length;

  const [board, activeEpicKeys, parkedRunRows] = await Promise.all([
    beads.list(repoPath, ["--status", "all"]),
    activeExecuteEpicKeys(db),
    listRunsByStatus(db, projectId, ["parked"]),
  ]);

  // One job read per epic at most, memoized: several findings can point at the same epic.
  const usageWindows = new Map<string, number | undefined>();
  const ctx: UnstickContext = {
    projectId,
    nowMs: clock.now(),
    activeEpicKeys,
    parkedRuns: new Map(parkedRunRows.map((r) => [r.id, r])),
    board: new Map(board.map((b) => [b.id, b])),
    usageWindowEndsAt: (epicBeadId) => usageWindows.get(epicBeadId),
  };

  // Prime the memo before classifying: `usageWindowEndsAt` is synchronous so the pure classifier
  // stays pure, which means the async job reads have to happen up front.
  for (const run of parkedRunRows) {
    if (run.error?.trim() !== USAGE_LIMIT_PARK || usageWindows.has(run.epicBeadId)) continue;
    usageWindows.set(
      run.epicBeadId,
      usageWindowEnd(await latestExecuteEpicJob(db, projectId, run.epicBeadId)),
    );
  }

  let wroteBeads = false;
  for (const finding of report.findings) {
    const verdict = classifyFinding(finding, ctx);
    if (verdict.disposition === "hold") {
      summary.held += 1;
      continue;
    }

    if (verdict.disposition === "resume" && verdict.epicBeadId) {
      const outcome = await resumeEpic(db, clock, projectId, verdict.epicBeadId);
      if (outcome === "already-active") {
        // The idempotent path: a prior pass (or an operator) already restarted this epic.
        summary.held += 1;
      } else {
        summary.resumed += 1;
        console.log(
          `[unstick] ${outcome} ${verdict.epicBeadId} (${finding.key}): ${verdict.why}`,
        );
      }
      await heartbeat();
      continue;
    }

    const { escalation, created } = await raiseEscalation(db, clock, {
      projectId,
      finding,
      epicBeadId: epicBeadIdFor(finding, ctx),
    });
    if (created) summary.escalated += 1;
    else summary.held += 1;
    wroteBeads = (await writeEscalationNote(repoPath, escalation, finding, db, clock)) || wroteBeads;
    await heartbeat();
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

/**
 * The epic an escalation's resume button would target. For a parked run that's the run's epic (the
 * finding names the ticket, but jobs are keyed by epic); otherwise the finding's own bead, which for
 * a stale PR or a dead lease IS the run target.
 */
function epicBeadIdFor(finding: RunHealthFinding, ctx: UnstickContext): string | undefined {
  if (finding.kind === "parked-run" && finding.runId) {
    return ctx.parkedRuns.get(finding.runId)?.epicBeadId;
  }
  return finding.beadId;
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
    await beads.note(repoPath, escalation.beadId, escalationNote(finding));
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

  return async function unstick(ctx: JobContext): Promise<void> {
    const { projectId } = ctx.payload as UnstickPayload;
    const project = await getProjectById(db, projectId);
    if (!project) throw new PoisonError(`project ${projectId} not found`);

    const summary = await unstickPass(
      { db, clock },
      { projectId, repoPath: project.repoPath, heartbeat: () => ctx.heartbeat() },
    );
    console.log(
      `[unstick] ${project.slug}: ${summary.findings} findings — ` +
        `${summary.resumed} resumed, ${summary.escalated} escalated, ${summary.held} held`,
    );
  };
}
