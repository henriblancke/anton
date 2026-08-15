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
 *     and its "abandon" would cancel it. The board half of that check is read after a PULL and fails
 *     closed when the pull doesn't land:
 *     run ownership is cross-machine state, and a stale local mirror of it can only be wrong in the
 *     direction that double-runs.
 */
import { beads, type Bead } from "../beads/bd";
import { getPrActivity, type PrActivity } from "../git/pr";
import {
  DEFAULT_MAX_RETRIES,
  getProjectById,
  getProjectSettings,
  resolveRunHealthThresholds,
} from "../projects";
import { getRunHealthReport, type RunHealthFinding } from "../run-health";
import { listRunsByStatus, type RunRow } from "../runs";
import { detectExhaustedJobs, detectStalePrs } from "./run-health";
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
   * Whether a `stale-pr` / `exhausted-job` finding STILL satisfies the detector that raised it,
   * re-checked against the live PR and job rows (see {@link revalidate}). Those two kinds carry no
   * other live handle in this context — a run row or a bead — so without this the pass would
   * escalate a PR that merged, or a job an operator resumed, in the window between the sweep and
   * now. Prefetched, because the classifier stays synchronous and pure.
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
      // A settled epic's parked run row simply never caught up — an abandon raised from an
      // `exhausted-job` escalation closes the bead but has no run id to settle, and a deletion
      // settles nothing at all. Either way the run has no epic left to act on (see
      // {@link epicSettled}), and this is the only check standing between a deleted epic and a
      // resume that parks straight back on `bead ... not found`.
      const settled = epicSettled(ctx, run.epicBeadId);
      if (settled) return hold(settled);
      if (run.error?.trim() !== USAGE_LIMIT_PARK) {
        // Jobs are machine-local, so nothing above rules out another machine having picked this
        // epic back up since the park. Escalating then puts Resume/Abandon in front of the founder
        // for work that is executing elsewhere, and the abandon closes the bead underneath it.
        // Only a CONFIRMED foreign lease holds: unlike the resume below, an untrusted board still
        // escalates — a missed escalation strands the stall, a redundant one costs a glance.
        const contested = ctx.boardFresh ? leaseStandDown(ctx, run.epicBeadId, run.id) : undefined;
        if (contested) return contested;
        return escalate(finding.reason);
      }
      const reopensAt = ctx.usageWindowEndsAt(run.epicBeadId);
      if (reopensAt !== undefined && reopensAt > ctx.nowMs) {
        return hold(`the usage window reopens at ${new Date(reopensAt).toISOString()}`);
      }
      // An operator who cancelled the backoff job said stop. The run row stays parked regardless, so
      // this is the only thing standing between a cancel and the window's expiry re-enqueuing it.
      if (ctx.epicCancelled(run.epicBeadId)) {
        return hold("this epic's latest job was cancelled by an operator");
      }
      // Jobs are machine-local, so `activeEpicKeys` above only rules out a run THIS machine owns.
      // The lease is what rules out one another machine picked up while this run sat parked.
      const contested = leaseStandDown(ctx, run.epicBeadId, run.id);
      if (contested) return contested;
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
      // Same operator-said-stop rule as the parked-run path. A cancel clears the JOB, not the bead's
      // run-lease label — a process that dies (or fails its `clearRunLease`/sync) after terminalizing
      // the row leaves the lease behind to expire, and this finding is what it decays into. Resuming
      // it would reverse the cancel, and `resumeEpic` can't catch that: cancelled jobs are outside
      // its covering set, so it would enqueue a fresh one.
      if (ctx.epicCancelled(bead.id)) {
        return hold("this epic's latest job was cancelled by an operator");
      }
      // The finding's whole premise is an EXPIRED lease a dying owner left behind. A bead carrying no
      // lease at all had it cleared — the owning run settled and swept its own label — so there is no
      // dead run to revive, and re-enqueuing would start fresh work nobody asked for. The report is a
      // candidate list, so the predicate that raised it has to still hold against the pulled bead.
      const expiry = beads.runLeaseExpiry(bead);
      if (expiry === undefined) {
        return hold("the run-lease has since been cleared");
      }
      // A lease that is live NOW belongs to a machine that picked the work back up after the sweep
      // saw it expired — resuming here would double-run the epic, the one thing the lease exists to
      // prevent. That is a foreign holder, so this pass stands down entirely.
      const contested = leaseStandDown(ctx, bead.id);
      if (contested) return contested;
      // Presence alone is a weaker bar than the detector's `expiry + grace <= now`, and the grace is
      // the whole allowance for a refresh that ran late or a clock that skews. A lease that lapsed
      // moments ago — a REPLACEMENT one, taken after the sweep by a machine now missing a heartbeat —
      // reads as uncontested above while its ticket may still be executing. Wait out the same window
      // the detector would have.
      if (expiry + ctx.deadLeaseGraceMs > ctx.nowMs) {
        return hold("the run-lease expired inside the dead-lease grace window");
      }
      return {
        disposition: "resume",
        why: "the run-lease expired with no foreign holder",
        epicBeadId: bead.id,
      };
    }

    // stale-pr and exhausted-job are never auto-actionable: a PR nobody reviewed needs a reviewer,
    // and a job that spent its whole retry budget already proved retrying doesn't fix it. They are
    // still re-checked first, for the same reason the two resumable kinds are — the report is a
    // candidate list. A PR merged since the sweep would otherwise be escalated as idle, and a
    // resumed job would be escalated as exhausted, where "abandon" then cancels live work.
    case "stale-pr":
      return ctx.stillStuck(finding)
        ? escalate(finding.reason)
        : hold("the PR has since merged, closed, or been picked back up");

    case "exhausted-job":
      // Same settled-epic rule as the parked-run path, and for the same loop: an abandon closes the
      // bead FIRST and only then cancels the job, so a failed cancel leaves a parked job under a
      // closed — or since-deleted — epic. Re-escalating that offers a "resume" that re-poisons on
      // the missing bead and an "abandon" whose `abandonTicket` now throws, settling the escalation
      // without settling the job — forever. Only an execute-epic finding carries an epic bead id;
      // the job-only kinds skip this and settle through `actOnJob`.
      if (finding.beadId) {
        const settled = epicSettled(ctx, finding.beadId);
        if (settled) return hold(settled);
      }
      return ctx.stillStuck(finding)
        ? escalate(finding.reason)
        : hold("the job has since been resumed or settled");

    default:
      return escalate(finding.reason);
  }
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
  // The escalation id is stamped in because bd notes are append-only with no dedupe: if the note
  // lands but `markEscalationNoted` doesn't, the next pass writes it again, and the token is what
  // tells a human reading the bead that the two entries are one escalation rather than two stalls.
  return (
    `anton: escalated a ${finding.kind} [${escalationId.slice(0, 8)}] — ${reason}. Nothing will ` +
    `retry this automatically; resume or abandon it from the anton board.`
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
  const summary: UnstickSummary = { findings: 0, resumed: 0, escalated: 0, held: 0 };

  const report = await getRunHealthReport(db, projectId);
  // No report means the run-health sweep has never run for this project (it ships off by default),
  // so there is nothing to act on — not an error, just an idle pass.
  if (!report || report.findings.length === 0) return summary;
  summary.findings = report.findings.length;

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
  for (const run of parkedRunRows) {
    if (run.error?.trim() !== USAGE_LIMIT_PARK) continue;
    await primeLatestJob(run.epicBeadId);
  }
  // A dead lease reads the same row for its cancellation guard; there the bead IS the epic.
  for (const finding of report.findings) {
    if (finding.kind === "dead-lease" && finding.beadId) await primeLatestJob(finding.beadId);
  }

  // Same reason, one gh/job read per stale-pr / exhausted-job finding.
  for (const finding of report.findings) {
    if (finding.kind === "stale-pr") {
      stillStuck.set(
        finding.key,
        await stalePrStillStuck(finding, {
          repoPath,
          readPrActivity,
          nowMs: ctx.nowMs,
          thresholdMs: thresholds.stalePrHours * 3_600_000,
          bead: finding.beadId ? ctx.board.get(finding.beadId) : undefined,
          boardFresh,
          signal: opts.signal,
        }),
      );
      await heartbeat();
    } else if (finding.kind === "exhausted-job") {
      stillStuck.set(
        finding.key,
        await exhaustedJobStillStuck(db, finding, settings.maxRetries ?? DEFAULT_MAX_RETRIES, ctx.nowMs),
      );
    }
  }

  let wroteBeads = false;
  for (const finding of report.findings) {
    // Stop acting the moment the job is cancelled or times out. Everything already done stands —
    // both verbs are idempotent, so the next pass picks up exactly where this one left off.
    opts.signal?.throwIfAborted();
    const verdict = classifyFinding(finding, ctx);
    if (verdict.disposition === "hold") {
      summary.held += 1;
      continue;
    }

    if (verdict.disposition === "resume" && verdict.epicBeadId) {
      const outcome = await resumeEpic(db, clock, projectId, verdict.epicBeadId);
      if (outcome === "resumed-job" || outcome === "enqueued") {
        summary.resumed += 1;
        console.log(
          `[unstick] ${outcome} ${verdict.epicBeadId} (${finding.key}): ${verdict.why}`,
        );
      } else {
        // Nothing was restarted: either a prior pass (or an operator) already did it — the
        // idempotent path — or an operator cancelled the epic's job after this pass classified it.
        summary.held += 1;
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
 * Does a `stale-pr` finding still hold? Re-read through the sweep's OWN detector, so the two can
 * never drift on what "idle" means: a PR that merged, closed, or was touched since the report is no
 * longer stalled, and escalating it would ask a founder to judge work that already moved.
 *
 * Fails OPEN — an unreadable PR keeps the finding — because a missed escalation strands the stall
 * the sweep exists to surface, while a redundant one costs a glance. The bead check only counts on a
 * FRESH board: a closed or absent bead read off a stale local mirror is not evidence the work is
 * done.
 */
async function stalePrStillStuck(
  finding: RunHealthFinding,
  opts: {
    repoPath: string;
    readPrActivity: NonNullable<UnstickDeps["readPrActivity"]>;
    nowMs: number;
    thresholdMs: number;
    bead: Bead | undefined;
    boardFresh: boolean;
    signal?: AbortSignal;
  },
): Promise<boolean> {
  // Two shapes of settled, one meaning — the same rule {@link epicSettled} applies to the other
  // kinds: a CLOSED target ended deliberately, and so did a DELETED one, since the pass lists every
  // status and a bead missing from a pulled board was removed rather than filtered. Escalating
  // either offers an abandon that throws on the gone bead and a note that fails to write, so the
  // same finding comes back every sweep.
  if (opts.boardFresh && finding.beadId && (!opts.bead || opts.bead.status === "closed")) {
    return false;
  }
  if (finding.prNumber === undefined || !finding.beadId) return true;
  try {
    const activity = await opts.readPrActivity(opts.repoPath, finding.prNumber, opts.signal);
    return (
      detectStalePrs([{ beadId: finding.beadId, activity }], opts.nowMs, opts.thresholdMs).length > 0
    );
  } catch (e) {
    // An abort is not an unreadable PR — the pass itself is being stopped, so failing open here
    // would escalate on behalf of a cancelled job. Let it propagate and settle the job instead.
    opts.signal?.throwIfAborted();
    console.error(
      `[unstick] could not re-read PR #${finding.prNumber} for ${finding.beadId}; escalating on the report's word`,
      e,
    );
    return true;
  }
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
  finding: RunHealthFinding,
  maxAttempts: number,
  nowMs: number,
): Promise<boolean> {
  if (!finding.jobId) return true;
  try {
    const job = await getJob(db, finding.jobId);
    if (!job) return false;
    return detectExhaustedJobs([job], maxAttempts, nowMs).length > 0;
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
 * resolve-and-resume close the gate and stop there (see escalation-actions.ts).
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

  return async function unstick(ctx: JobContext): Promise<void> {
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
        `${summary.resumed} resumed, ${summary.escalated} escalated, ${summary.held} held`,
    );
  };
}
