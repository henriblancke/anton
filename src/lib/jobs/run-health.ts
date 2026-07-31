/**
 * run-health job (anton-4ks0). Every way a run can silently stall, detected in one deterministic
 * scheduled sweep and written out as an inspectable report.
 *
 * The point is to sweep the CLASS, not the instance: a run parked at 02:00, a PR whose reviewer
 * went on holiday, a laptop that closed mid-run and left its lease behind, a job that quietly spent
 * its last retry — none of these announce themselves, and each strands work indefinitely. One
 * scheduled pass over anton.db's runs/jobs joined with the board finds all of them.
 *
 * READ-ONLY by construction (this ticket): the sweep never touches runs, jobs, or beads. Its only
 * write is the report row, which is upserted per project — so re-running it over unchanged state
 * converges on the identical report rather than accumulating. Acting on a finding (resume, escalate)
 * is the follow-up job (anton-wvcy).
 *
 * Off by default: the schedule is seeded disabled (schedules.ts), so a project opts in.
 */
import { beads, LABELS, type Bead } from "../beads/bd";
import { getPrActivity, prNumberFromRef, type PrActivity } from "../git/pr";
import {
  DEFAULT_MAX_RETRIES,
  getProjectById,
  getProjectSettings,
  resolveRunHealthThresholds,
} from "../projects";
import { listRunsByStatus, type RunRow } from "../runs";
import { saveRunHealthReport, type RunHealthFinding } from "../run-health";
import { PoisonError } from "./errors";
import {
  activeExecuteEpicKeys,
  listJobsByStatus,
  systemClock,
  toMs,
  type AntonDb,
  type Clock,
  type JobRow,
} from "./queue";
import type { JobContext, JobHandler } from "./runner";

const IN_REVIEW = LABELS.stage("in-review");

export interface RunHealthPayload {
  projectId: string;
  scheduleId?: string;
}

export interface RunHealthDeps {
  db: AntonDb;
  clock?: Clock;
  /**
   * How the sweep learns a PR's last activity. Injectable so tests (and any future non-GitHub
   * forge) don't need `gh`; the default is the real read-only `gh pr view`.
   */
  readPrActivity?: (repo: string, number: number, signal?: AbortSignal) => Promise<PrActivity>;
}

/** Round to whole minutes for prose — an age in ms reads as noise in a report. */
function humanAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// ── detectors (pure; every one takes an explicit `nowMs` so tests run on a fixed clock) ──

/**
 * Runs parked longer than the threshold. A parked run is waiting on a human by definition — nothing
 * in the runner re-dispatches it — so its age is the whole signal. `updatedAt` is when it parked
 * (nothing touches a parked row afterwards), and `error` carries the park reason the runner or
 * execute-epic recorded (`usage-limit`, `run-live-elsewhere`, an agent failure).
 */
export function detectParkedRuns(
  runs: RunRow[],
  nowMs: number,
  thresholdMs: number,
): RunHealthFinding[] {
  const findings: RunHealthFinding[] = [];
  for (const run of runs) {
    if (run.status !== "parked") continue;
    const since = toMs(run.updatedAt);
    if (since === undefined) continue;
    const ageMs = nowMs - since;
    if (ageMs <= thresholdMs) continue;
    findings.push({
      kind: "parked-run",
      key: `parked-run:${run.id}`,
      reason: `run parked ${humanAge(ageMs)}: ${run.error?.trim() || "no reason recorded"}`,
      since,
      ageMs,
      runId: run.id,
      beadId: run.ticketBeadId ?? run.epicBeadId,
    });
  }
  return findings;
}

/** An in-review target paired with the current state of its PR. */
export interface InReviewPr {
  beadId: string;
  activity: PrActivity;
}

/**
 * In-review targets whose OPEN PR has had no activity past the threshold. Only OPEN counts: a
 * merged PR is finalized by review-fix and a closed one is a decision, not a stall — flagging
 * either would train the operator to ignore the report.
 */
export function detectStalePrs(
  prs: InReviewPr[],
  nowMs: number,
  thresholdMs: number,
): RunHealthFinding[] {
  const findings: RunHealthFinding[] = [];
  for (const { beadId, activity } of prs) {
    if (activity.state !== "OPEN") continue;
    const ageMs = nowMs - activity.updatedAtMs;
    if (ageMs <= thresholdMs) continue;
    findings.push({
      kind: "stale-pr",
      key: `stale-pr:${beadId}:${activity.number}`,
      reason: `PR #${activity.number}${activity.isDraft ? " (draft)" : ""} idle ${humanAge(ageMs)} with the target still in review`,
      since: activity.updatedAtMs,
      ageMs,
      beadId,
      prNumber: activity.number,
      prUrl: activity.url,
    });
  }
  return findings;
}

/**
 * Beads still carrying an EXPIRED run-lease with no execute-epic job behind them — the fingerprint
 * of a machine that died mid-run. The lease is the cross-machine liveness mirror of the local job
 * lease, refreshed on a heartbeat, so an expiry well in the past means the owner stopped without
 * settling. `activeEpicKeys` (from `activeExecuteEpicKeys`) is what distinguishes that from a run
 * this machine is about to resume — a keyed bead has a job coming back and is NOT stuck.
 *
 * `graceMs` is applied past expiry so a lease caught mid-refresh (or a machine whose clock skews)
 * never reads as dead. Closed beads are skipped: a leftover label on finished work is litter, not a
 * stalled run.
 */
export function detectDeadLeases(
  board: Bead[],
  activeEpicKeys: Set<string>,
  opts: { projectId: string; nowMs: number; graceMs: number },
): RunHealthFinding[] {
  const { projectId, nowMs, graceMs } = opts;
  const findings: RunHealthFinding[] = [];
  for (const bead of board) {
    if (bead.status === "closed") continue;
    const expiry = beads.runLeaseExpiry(bead);
    if (expiry === undefined) continue;
    if (expiry + graceMs > nowMs) continue; // still live, or inside the grace window
    if (activeEpicKeys.has(`${projectId}::${bead.id}`)) continue; // a job will resume it
    const ageMs = nowMs - expiry;
    findings.push({
      kind: "dead-lease",
      key: `dead-lease:${bead.id}`,
      reason: `run-lease expired ${humanAge(ageMs)} ago with no job to resume it — the owning run died mid-flight`,
      since: expiry,
      ageMs,
      beadId: bead.id,
      prNumber: prNumberFromRef(beads.getPrRef(bead)),
    });
  }
  return findings;
}

/**
 * Jobs that settled `parked`/`failed` having spent their whole attempt budget. These are the ones
 * the runner deliberately stopped retrying — recoverable only by a human resume, so they sit
 * forever unless something surfaces them. A job parked with attempts still on the clock (quota
 * backoff, a held lease) is excluded: those refund the attempt and come back by themselves.
 */
export function detectExhaustedJobs(
  jobs: JobRow[],
  maxAttempts: number,
  nowMs: number,
): RunHealthFinding[] {
  const findings: RunHealthFinding[] = [];
  for (const job of jobs) {
    if (job.status !== "parked" && job.status !== "failed") continue;
    if (job.attempts < maxAttempts) continue;
    const since = toMs(job.updatedAt) ?? nowMs;
    findings.push({
      kind: "exhausted-job",
      key: `exhausted-job:${job.id}`,
      reason: `${job.type} job ${job.status} after ${job.attempts}/${maxAttempts} attempts: ${job.lastError?.trim() || "no error recorded"}`,
      since,
      ageMs: Math.max(0, nowMs - since),
      jobId: job.id,
      beadId: epicBeadIdOf(job.payloadJson),
    });
  }
  return findings;
}

/** The `epicBeadId` a job payload targets, so an exhausted job links to the work it stranded. */
function epicBeadIdOf(payloadJson: string | null): string | undefined {
  try {
    const parsed = JSON.parse(payloadJson ?? "{}") as { epicBeadId?: unknown };
    return typeof parsed.epicBeadId === "string" ? parsed.epicBeadId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Open RUN TARGETS tagged `stage:in-review` that carry a PR pointer — the stale-PR candidates.
 * Classified off the whole board (`isRunTarget`) for the same reason review-fix does: a container
 * epic someone PR-linked by hand has no PR of its own, so reporting it idle would blame the parent
 * for its children's review — and cost a `gh` call per sweep to do it.
 */
export function inReviewTargets(board: Bead[]): Array<{ bead: Bead; prNumber: number }> {
  const targets: Array<{ bead: Bead; prNumber: number }> = [];
  for (const bead of board) {
    if (bead.status === "closed") continue;
    if (!(bead.labels?.includes(IN_REVIEW) ?? false)) continue;
    if (!beads.isRunTarget(bead, board)) continue;
    const prNumber = prNumberFromRef(beads.getPrRef(bead));
    if (prNumber === undefined) continue;
    targets.push({ bead, prNumber });
  }
  return targets;
}

// ── the job ──

/** Build the runner handler bound to a db/clock. Register it as the "run-health" handler. */
export function makeRunHealthHandler(deps: RunHealthDeps): JobHandler {
  const db = deps.db;
  const clock = deps.clock ?? systemClock;
  const readPrActivity = deps.readPrActivity ?? getPrActivity;

  return async function runHealth(ctx: JobContext): Promise<void> {
    const { projectId } = ctx.payload as RunHealthPayload;
    const project = await getProjectById(db, projectId);
    if (!project) throw new PoisonError(`project ${projectId} not found`);

    const settings = await getProjectSettings(db, projectId);
    const thresholds = resolveRunHealthThresholds(settings);
    const maxAttempts = settings.maxRetries ?? DEFAULT_MAX_RETRIES;
    const nowMs = clock.now();

    const board = await beads.list(project.repoPath, ["--status", "all"]);
    const [parkedRuns, settledJobs, activeEpicKeys] = await Promise.all([
      listRunsByStatus(db, projectId, ["parked"]),
      listJobsByStatus(db, projectId, ["parked", "failed"]),
      activeExecuteEpicKeys(db),
    ]);

    const findings: RunHealthFinding[] = [
      ...detectParkedRuns(parkedRuns, nowMs, thresholds.parkedRunMinutes * 60_000),
      ...detectDeadLeases(board, activeEpicKeys, {
        projectId,
        nowMs,
        graceMs: thresholds.deadLeaseMinutes * 60_000,
      }),
      ...detectExhaustedJobs(settledJobs, maxAttempts, nowMs),
    ];

    await ctx.heartbeat();
    findings.push(
      ...detectStalePrs(
        await readInReviewPrs(board, project.repoPath, readPrActivity, ctx),
        nowMs,
        thresholds.stalePrHours * 3_600_000,
      ),
    );

    await saveRunHealthReport(db, clock, { projectId, jobId: ctx.jobId, findings });
  };
}

/**
 * Read each in-review target's PR activity. A per-PR failure is logged and skipped rather than
 * failing the sweep: one unreachable PR (a deleted repo, a rate-limited token) must not cost the
 * operator the parked-run and dead-lease findings that were already computed. The skip is loud in
 * the logs precisely because a silently under-reported PR class would read as "all clear".
 */
async function readInReviewPrs(
  board: Bead[],
  repo: string,
  readPrActivity: NonNullable<RunHealthDeps["readPrActivity"]>,
  ctx: JobContext,
): Promise<InReviewPr[]> {
  const prs: InReviewPr[] = [];
  for (const { bead, prNumber } of inReviewTargets(board)) {
    try {
      prs.push({ beadId: bead.id, activity: await readPrActivity(repo, prNumber, ctx.signal) });
    } catch (e) {
      console.error(`[run-health] could not read PR #${prNumber} for ${bead.id}; skipping`, e);
    }
    await ctx.heartbeat();
  }
  return prs;
}
