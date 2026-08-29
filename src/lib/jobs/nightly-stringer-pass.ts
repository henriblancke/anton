/**
 * What every step of one nightly scan pass shares (anton-xdgw): the project it runs for, the
 * settings triage is dispatched under, the session it speaks through, and the one health point it
 * is allowed to land. Assembled once by the handler and threaded through its steps, so a step's own
 * signature carries only what makes it that step.
 */
import { getProjectById, getProjectSettings, type ProjectSettings } from "../projects";
import { appendSessionLog, endSession, startJobSession, type JobSession } from "../sessions";
import type { Project } from "../types";
import { PoisonError } from "./errors";
import { makeHealthRecorder, type HealthRecorder } from "./nightly-stringer-health";
import type { AntonDb, Clock } from "./queue";
import type { JobContext } from "./runner";

export interface NightlyPass {
  project: Project;
  settings: ProjectSettings;
  sessionId: string;
  logPath: string;
  /** Streams claude events to the session log. */
  onEvent: JobSession["onEvent"];
  /** Append to the pass's session log. */
  log: (chunk: string) => Promise<void>;
  /** Settle the session row. */
  end: (status: "done" | "failed") => Promise<void>;
  /** Land this pass's point on the scan-health trend — at most once, and never fatally. */
  recordHealth: HealthRecorder;
  /**
   * True once triage has READ the scan's signals — from then the consumed `--delta` window is
   * legitimately spent, and the failure path owes it nothing (see `restoreScanWindow`).
   */
  readonly triaged: boolean;
  /** Record that triage read the signals. The only way to flip {@link NightlyPass.triaged}. */
  markTriaged: () => void;
}

/**
 * Open the pass: resolve the project or poison the job, and start the session its output lands on.
 *
 * A pass for a project that is gone can never succeed, so it parks for a human instead of burning
 * the runner's retries.
 */
export async function openPass(
  db: AntonDb,
  clock: Clock,
  ctx: JobContext,
  projectId: string,
): Promise<NightlyPass> {
  const project = await getProjectById(db, projectId);
  if (!project) throw new PoisonError(`project ${projectId} not found`);
  const settings = await getProjectSettings(db, projectId);

  const { sessionId, logPath, onEvent } = await startJobSession(db, clock, {
    projectId,
    kind: "nightly-stringer",
  });
  // Live handle (anton-susu): nightly-stringer writes no run row, so this is how observe finds
  // the in-flight session. It runs claude directly in the project repo — no worktree.
  ctx.report({ sessionId, cwd: project.repoPath });

  // Closure-held so the window rule cannot be defeated by a caller assigning the field directly.
  let triaged = false;

  return {
    project,
    settings,
    sessionId,
    logPath,
    onEvent,
    log: (chunk) => appendSessionLog(logPath, chunk),
    end: (status) => endSession(db, clock, sessionId, status),
    recordHealth: makeHealthRecorder({
      db,
      clock,
      projectId,
      jobId: ctx.jobId,
      sessionId,
      logPath,
      slug: project.slug,
    }),
    get triaged() {
      return triaged;
    },
    markTriaged: () => {
      triaged = true;
    },
  };
}
