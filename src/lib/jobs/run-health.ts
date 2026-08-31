/**
 * run-health job (anton-4ks0). Every way a run can silently stall, detected in one deterministic
 * scheduled sweep and written out as an inspectable report.
 *
 * The point is to sweep the CLASS, not the instance: a run parked at 02:00, a PR whose reviewer
 * went on holiday, a laptop that closed mid-run and left its lease behind, a job that quietly spent
 * its last retry, a human gate the founder hung and forgot — none of these announce themselves, and
 * each strands work indefinitely. One scheduled pass over anton.db's runs/jobs joined with the board
 * finds all of them.
 *
 * READ-ONLY by construction (this ticket): the sweep never touches runs, jobs, or beads. Its only
 * write is the report row, which is upserted per project — so re-running it over unchanged state
 * converges on the identical report rather than accumulating. Acting on a finding (resume, escalate)
 * is the follow-up job (anton-wvcy).
 *
 * Off by default: the schedule is seeded disabled (schedules.ts), so a project opts in.
 */
import { beads, gateReason as bdGateReason, LABELS, type Bead, type Gate } from "../beads/bd";
import { getPrActivity, prNumberFromRef, type PrActivity } from "../git/pr";
import {
  DEFAULT_MAX_RETRIES,
  getProjectById,
  getProjectSettings,
  resolveRunHealthThresholds,
} from "../projects";
import { listRunsByStatus, type RunRow } from "../runs";
import { saveRunHealthReport, type RunHealthFinding } from "../run-health";
import { parkedAskGateId, poisonBlockerIds, PoisonError } from "./errors";
import { beadBlockedByGate, runTargetAbove } from "./gate-targets";
import {
  activeExecuteEpicKeys,
  listJobsByStatus,
  systemClock,
  toMs,
  type AntonDb,
  type Clock,
  type JobRow,
} from "./queue";
import {
  exhaustedParkAttempts,
  POISON_PARK_PREFIX,
  type JobContext,
  type JobHandler,
} from "./runner";

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
 * The settled (`parked`/`failed`) execute-epic job behind each epic, keyed by epic bead id — the job
 * pointer a `parked-run` finding carries. A run parks because its job parked, and the two are settled
 * SEPARATELY on abandon: `abandonTicket` deliberately leaves a stopped job alone (`requireStopped`),
 * so `settleAbandonedWork` is what cancels it, and it can only do that from `view.jobId`. Without the
 * pointer an abandoned epic keeps its parked job — and the Resume control that job still shows in the
 * jobs UI.
 *
 * Newest wins on a duplicate, tie-broken by id so two jobs settled inside the same second (the
 * timestamps are second-granular) don't make the report non-deterministic.
 */
export function settledExecuteEpicJobsByEpic(jobs: JobRow[]): Map<string, JobRow> {
  const byEpic = new Map<string, JobRow>();
  for (const job of jobs) {
    if (job.type !== "execute-epic") continue;
    const epicBeadId = epicBeadIdOf(job.payloadJson);
    if (!epicBeadId) continue;
    const held = byEpic.get(epicBeadId);
    if (!held || isNewerJob(job, held)) byEpic.set(epicBeadId, job);
  }
  return byEpic;
}

function isNewerJob(job: JobRow, than: JobRow): boolean {
  const a = toMs(job.updatedAt) ?? 0;
  const b = toMs(than.updatedAt) ?? 0;
  return a === b ? job.id > than.id : a > b;
}

/**
 * Runs parked longer than the threshold. A parked run is waiting on a human by definition — nothing
 * in the runner re-dispatches it — so its age is the whole signal. `updatedAt` is when it parked
 * (nothing touches a parked row afterwards), and `error` carries the park reason the runner or
 * execute-epic recorded (`usage-limit`, `run-live-elsewhere`, an agent failure).
 *
 * `jobsByEpic` (from {@link settledExecuteEpicJobsByEpic}) is what lets the finding name the job that
 * parked alongside the run, so an abandon settles both rows rather than only the run.
 */
export function detectParkedRuns(
  runs: RunRow[],
  nowMs: number,
  thresholdMs: number,
  jobsByEpic: Map<string, JobRow> = new Map(),
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
      jobId: jobsByEpic.get(run.epicBeadId)?.id,
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
 * Jobs the runner has stopped retrying — recoverable only by a human, so they sit forever unless
 * something surfaces them. Three shapes qualify:
 *
 *   • a `parked`/`failed` job carrying the runner's `failed N×:` park marker, which records the
 *     budget it was actually given up under. That marker is the durable evidence, because
 *     `maxAttempts` is today's SETTING: raising it after a job parked doesn't restart the job, so
 *     comparing against the new value alone would retire the finding while the work stays stuck —
 *     invisibly for a non-execute job like `sync-push`, which strands no run for another detector
 *     to catch;
 *   • a `parked`/`failed` job whose attempts have reached the current budget, for a row settled
 *     without a marker; and
 *   • a POISON park, which skips the budget entirely (`nextAction`), so its attempt count is no
 *     evidence at all — execute-epic poisons on exactly the actionable conditions (a blocker, a
 *     disabled agent, a contract gap), and several of those fire before a run row exists, so
 *     without this the parked-run detector can't see them either and the work waits invisibly.
 *
 * A job parked with attempts still on the clock for any OTHER reason (quota backoff, a held lease)
 * is excluded: those refund the attempt and come back by themselves.
 */
export function detectExhaustedJobs(
  jobs: JobRow[],
  maxAttempts: number,
  nowMs: number,
): RunHealthFinding[] {
  const findings: RunHealthFinding[] = [];
  for (const job of jobs) {
    if (job.status !== "parked" && job.status !== "failed") continue;
    const lastError = job.lastError?.trim() || "no error recorded";
    const poisoned = lastError.startsWith(POISON_PARK_PREFIX);
    // The budget the runner recorded when it gave up, falling back to the current setting for a row
    // that carries no marker. Reported as well as tested against, so a job parked under an older,
    // smaller budget reads as the exhausted one it is rather than as "3/10, retries left".
    const spentBudget = exhaustedParkAttempts(lastError);
    const budget = spentBudget ?? maxAttempts;
    if (!poisoned && spentBudget === undefined && job.attempts < maxAttempts) continue;
    const since = toMs(job.updatedAt) ?? nowMs;
    findings.push({
      kind: "exhausted-job",
      key: `exhausted-job:${job.id}`,
      reason: poisoned
        ? `${job.type} job parked without retrying (permanent failure): ${lastError.slice(POISON_PARK_PREFIX.length).trim()}`
        : `${job.type} job ${job.status} after ${job.attempts}/${budget} attempts: ${lastError}`,
      since,
      ageMs: Math.max(0, nowMs - since),
      jobId: job.id,
      beadId: epicBeadIdOf(job.payloadJson),
    });
  }
  return findings;
}

/**
 * The prose a human wrote when they hung the gate, collapsed to one line — a report row is one
 * line, and bd accepts a multi-line reason.
 *
 * The parse itself is {@link bdGateReason}'s (PR #205 review): bd folds the reason into the gate's
 * description rather than giving it a field, and exactly one place in anton should know that
 * format, so a bd change is fixed once instead of in two parsers that drifted apart.
 */
function gateReason(gate: Gate): string | undefined {
  return bdGateReason(gate)?.replace(/\s+/g, " ").trim() || undefined;
}

/**
 * The ticket anton stamped on the gate when it armed the ask (`<ticket> needs a human: <ask>`,
 * jobs/execute-epic.ts), split off the reason so the row can NAME it.
 *
 * It is the only way back to that ticket (PR #205 review): the gate blocks the RUN TARGET, so on a
 * feature with several children the blocked bead says nothing about which child stopped — and an
 * answer belongs on the child, whose notes the resumed session reads as binding steering. A gate a
 * person hung by hand carries no such prefix and keeps its reason whole.
 */
const ARMED_ASK = /^(\S+) needs a human:\s*/;

function askOf(reason: string | undefined): { askBeadId?: string; reason?: string } {
  const match = reason ? ARMED_ASK.exec(reason) : null;
  if (!match || !reason) return { reason };
  return { askBeadId: match[1], reason: reason.slice(match[0].length) || undefined };
}

/**
 * OPEN human gates — the one stall class that is stuck BY DESIGN. Every other detector reports work
 * that stopped by accident; a human gate is a wait somebody asked for, and precisely because bd will
 * never resolve it (`bd gate check` skips `human` entirely) it waits forever unless a person is told
 * it is waiting. Off the board it is invisible: gate beads are absent from a plain `bd list`, so
 * without this the founder's own "not until I've looked at it" outlives the looking.
 *
 * NO THRESHOLD, unlike the accidental stalls: a human gate needs a human from the instant it opens,
 * and its age is context, not a deadline (bd's own timeout is the deadline mechanism, and this
 * detector deliberately doesn't second-guess it).
 *
 * The finding names three beads, because a resume needs all three: the GATE to resolve, the bead it
 * BLOCKS (where the wait is visible on the board), and the run TARGET above that bead — the thing
 * anton actually re-enqueues, which for a gated ticket is its feature, not the ticket. A gate whose
 * blocked bead has no run target above it (pipeline plumbing, or a bead this board read doesn't
 * carry) still reports: the wait is real even when anton cannot map it to a run.
 *
 * A fourth, for ANSWERING rather than resuming: the ticket that raised the ask ({@link askOf}),
 * which none of the three above recover on a feature with several children.
 */
export function detectOpenHumanGates(
  gates: Gate[],
  board: Bead[],
  nowMs: number,
): RunHealthFinding[] {
  const findings: RunHealthFinding[] = [];
  for (const gate of gates) {
    if (gate.issue_type !== "gate" || gate.status === "closed") continue;
    if (gate.await_type !== "human") continue;
    const blocked = beadBlockedByGate(board, gate.id);
    const target = blocked ? runTargetAbove(board, blocked.id) : undefined;
    // A gate bd stamped with no readable `created_at` reports as brand new rather than as 1970 —
    // an age nobody can act on beats an age that reads as a 56-year stall.
    const created = gate.created_at ? Date.parse(gate.created_at) : NaN;
    const since = Number.isNaN(created) ? nowMs : created;
    const ageMs = Math.max(0, nowMs - since);
    const { askBeadId, reason } = askOf(gateReason(gate));
    findings.push({
      kind: "needs-human",
      // Keyed on the GATE, which is the stall: stable across sweeps (bd ids never change), so one
      // wait raises one escalation however many times the sweep runs.
      key: `needs-human:${gate.id}`,
      reason: `waiting on a human ${humanAge(ageMs)}: ${reason ?? "no reason recorded on the gate"}`,
      since,
      ageMs,
      gateId: gate.id,
      beadId: blocked?.id,
      targetBeadId: target?.id,
      askBeadId,
    });
  }
  return findings;
}

/**
 * Drop the `exhausted-job` findings that are the SAME wait an open human gate already reports.
 *
 * Two ways a job ends up as that second half:
 *
 *   • a gate hung on work whose execute-epic job was ALREADY queued poison-parks that job on the
 *     gate (execute-epic's readiness re-check) — the stall seen once as the gate, once as the job
 *     that refused to start because of it; and
 *   • a run that ARMED a human gate for its own ask parks on it (`ParkedAskError`), so the very act
 *     of asking a person a question also books a job whose park reads "permanent failure"
 *     (PR #205 review).
 *
 * Reported both ways each raises two escalations for one wait — and only the gate row is reconciled
 * when the wait ends, so the "retries spent" row survives as a false failure with a stale Abandon on
 * it long after the run resumed.
 *
 * The gate wait is the RIGHT half to keep: it names what a human actually does about it, and its
 * resolve-and-resume restarts the parked job on the way through.
 *
 * A blocked park is suppressed only when EVERY blocker it names is one of those gates — a job also
 * held back by an ordinary prerequisite outlives the gate being answered, and nothing else would
 * surface it. An armed ask names exactly one gate, its own, and the holds beside it (which keep the
 * target blocked too) are each reported as their own open gate.
 */
export function withoutGateBlockedJobs(findings: RunHealthFinding[]): RunHealthFinding[] {
  const openGateIds = new Set(
    findings.flatMap((f) => (f.kind === "needs-human" && f.gateId ? [f.gateId] : [])),
  );
  if (openGateIds.size === 0) return findings;
  return findings.filter((finding) => {
    if (finding.kind !== "exhausted-job") return true;
    const parkedOn = parkedAskGateId(finding.reason);
    if (parkedOn !== undefined) return !openGateIds.has(parkedOn);
    const blockers = poisonBlockerIds(finding.reason);
    return !blockers?.every((id) => openGateIds.has(id));
  });
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

    // Two board reads, because bd answers them separately: gate beads are OMITTED from every
    // ordinary listing (only `--type gate` / `bd gate list` carries them) while the `blocks` edge a
    // gate puts on the bead it gates IS carried by the plain list — so the gates come from one read
    // and the work they block from the other. Open gates only, which is `gate list`'s default.
    // NOT best-effort: a swallowed gate read reads as "no human is waiting", which is exactly the
    // false all-clear this sweep exists to prevent. A rejection retries the sweep instead.
    const [board, gates] = await Promise.all([
      beads.list(project.repoPath, ["--status", "all"]),
      beads.gateList(project.repoPath),
    ]);
    const [parkedRuns, settledJobs, activeEpicKeys] = await Promise.all([
      listRunsByStatus(db, projectId, ["parked"]),
      listJobsByStatus(db, projectId, ["parked", "failed"]),
      activeExecuteEpicKeys(db),
    ]);

    // Deduped across detectors before anything acts on them: a job that poison-parked ON one of
    // these gates is that gate's wait, not a second stall (see {@link withoutGateBlockedJobs}).
    const findings: RunHealthFinding[] = withoutGateBlockedJobs([
      ...detectParkedRuns(
        parkedRuns,
        nowMs,
        thresholds.parkedRunMinutes * 60_000,
        settledExecuteEpicJobsByEpic(settledJobs),
      ),
      ...detectDeadLeases(board, activeEpicKeys, {
        projectId,
        nowMs,
        graceMs: thresholds.deadLeaseMinutes * 60_000,
      }),
      ...detectExhaustedJobs(settledJobs, maxAttempts, nowMs),
      ...detectOpenHumanGates(gates, board, nowMs),
    ]);

    await ctx.heartbeat();
    findings.push(
      ...detectStalePrs(
        await readInReviewPrs(board, project.repoPath, readPrActivity, ctx),
        nowMs,
        thresholds.stalePrHours * 3_600_000,
      ),
    );

    // The report is upserted per project, so saving a partial sweep REPLACES the last good one with
    // something indistinguishable from a clean bill of health. Nothing above is guaranteed to notice
    // a cancel — `heartbeat` doesn't inspect the signal, the board and db reads aren't abortable, and
    // the PR loop only re-throws an abort that surfaced as a rejected `gh` call — so the write is
    // gated here explicitly. A cancelled sweep must leave the previous report standing.
    ctx.signal.throwIfAborted();
    await saveRunHealthReport(db, clock, { projectId, jobId: ctx.jobId, findings });
  };
}

/**
 * Read each in-review target's PR activity. A per-PR failure is logged and skipped rather than
 * failing the sweep: one unreachable PR (a deleted repo, a rate-limited token) must not cost the
 * operator the parked-run and dead-lease findings that were already computed. The skip is loud in
 * the logs precisely because a silently under-reported PR class would read as "all clear".
 *
 * An ABORT is the one failure that isn't per-PR: the job itself is being cancelled or has timed out,
 * so every remaining read would fail the same way and the report saved at the end would be a partial
 * one indistinguishable from a clean sweep (`heartbeat` doesn't inspect the signal, so nothing else
 * stops the loop). It propagates instead, and the job settles as the cancellation it is.
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
      ctx.signal.throwIfAborted();
      console.error(`[run-health] could not read PR #${prNumber} for ${bead.id}; skipping`, e);
    }
    await ctx.heartbeat();
  }
  return prs;
}
