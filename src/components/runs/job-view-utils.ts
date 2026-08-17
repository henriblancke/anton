/**
 * The jobs list's shared vocabulary and pure helpers (anton-domt). Status styling, the in-flight
 * predicate, time formatting and the per-row affordance derivation live here so the row renders as
 * composition over named parts and every branch behind it is decidable without a DOM.
 *
 * Type-only import: pulling the runtime `isActiveJob`/`listJobs` from jobs-view would drag its
 * better-sqlite3 (server-only) dependency into this client bundle. Types are erased at build, so
 * this is safe; the active-status check is inlined below.
 */
import type { JobStatus, JobSummary } from "@/lib/jobs-view";
// Type-only for the same reason: runner.ts is server-only, but its LiveJobInfo shape is exactly
// what the page resolves per running job.
import type { LiveJobInfo } from "@/lib/jobs/runner";
import { DISPLAY_LOCALE } from "@/lib/time";

export const JOB_STATUS_STYLE: Record<JobStatus, { dot: string; text: string; pulse?: boolean }> = {
  running: { dot: "bg-stage-implementing", text: "text-stage-implementing", pulse: true },
  queued: { dot: "bg-stage-backlog", text: "text-muted-foreground" },
  parked: { dot: "bg-risk-med", text: "text-risk-med" },
  failed: { dot: "bg-risk-high", text: "text-risk-high" },
  cancelled: { dot: "bg-muted-foreground", text: "text-muted-foreground" },
  done: { dot: "bg-stage-done", text: "text-stage-done" },
};

/** Job statuses still in flight — mirrors jobs-view.isActiveJob, inlined to keep this bundle server-free. */
export const ACTIVE_JOB_STATUSES = new Set<JobStatus>(["queued", "running", "parked"]);

export function isActiveJobStatus(status: JobStatus): boolean {
  return ACTIVE_JOB_STATUSES.has(status);
}

/** Compact "3m ago" / "2h ago" for the activity column. */
export function relativeTime(epoch?: number): string {
  if (!epoch) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epoch);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Absolute timestamp for the detail panel, in the host's timezone but anton's canonical locale.
 * Hydration-sensitive: the Jobs page is a Server Component that hands this client list its rows, so
 * these strings are server-rendered before the browser ever formats them.
 */
export function absTime(epoch?: number): string {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleString(DISPLAY_LOCALE);
}

/**
 * The page's one grouping rule: selectable === killable, exactly the rows that render a per-row
 * Force kill. A confirmed kill leaves the group at once rather than waiting for the server's status
 * to catch up, so the bulk bar can never act on a job that is already gone.
 */
export function selectableJobIds(jobs: JobSummary[], killedIds: ReadonlySet<string>): string[] {
  return jobs
    .filter((job) => isActiveJobStatus(job.status) && !killedIds.has(job.id))
    .map((job) => job.id);
}

/** What one row may show and offer, given the job and what this instance knows about it. */
export interface JobRowAffordances {
  /** What the row displays — a confirmed kill reads as `cancelled` before the server catches up. */
  status: JobStatus;
  active: boolean;
  /** Parked/failed jobs are recoverable but not self-healing — offer a manual resume (anton-ner.4). */
  resumable: boolean;
  /** Investigate needs a job still running here with a reported cwd; a local kill drops it at once. */
  investigable: boolean;
  /** Output needs a session to read. A killed row shows the kill first — its log is one refresh away. */
  observable: boolean;
  /** The log the output panel opens — see `jobLogSession`. */
  sessionId?: string;
  /** A running job is still writing to its log; a settled one's is a replay. */
  following: boolean;
  /** Where Investigate attaches — present only while the job runs on this instance. */
  liveCwd?: string;
}

/**
 * Which log the viewer opens. The live handle answers only while the job runs here; the durable
 * link answers afterwards, so a nightly gardener/product-master pass an operator reads at 09:00 is
 * as inspectable as one caught mid-flight.
 */
export function jobLogSession(
  job: JobSummary,
  live?: LiveJobInfo,
  loggedSessionId?: string,
): string | undefined {
  return (job.status === "running" ? live?.sessionId : undefined) ?? loggedSessionId;
}

export function jobRowAffordances({
  job,
  live,
  loggedSessionId,
  killed,
}: {
  job: JobSummary;
  live?: LiveJobInfo;
  /** The session this job durably recorded — the only handle a settled job has (anton-lmps). */
  loggedSessionId?: string;
  /** Confirmed cancelled by the server (per-row or bulk). */
  killed: boolean;
}): JobRowAffordances {
  const status: JobStatus = killed ? "cancelled" : job.status;
  const running = job.status === "running";
  const sessionId = jobLogSession(job, live, loggedSessionId);
  const active = isActiveJobStatus(status);
  const resumable = !killed && (job.status === "parked" || job.status === "failed");
  const observable = !killed && Boolean(sessionId);

  return {
    status,
    active,
    resumable,
    investigable: !killed && running && Boolean(live?.cwd),
    observable,
    sessionId,
    following: running,
    liveCwd: live?.cwd,
  };
}

/** Anything to offer at all — a settled job with no log to read gets no action cluster. */
export function isActionable(a: JobRowAffordances): boolean {
  return a.resumable || a.active || a.observable;
}
