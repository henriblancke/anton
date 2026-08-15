/**
 * The preamble every board PASS shares (anton-l4do): resolve the project or poison the job, pull the
 * shared board before reading it, and open the session its output lands on.
 *
 * Lifted out of gardener.ts and product-master.ts rather than invented — both hand-rolled the same
 * three moves, and the handlers are about to grow an apply loop (anton-zy7f). One copy means a fix to
 * the durable link between a job and its session (anton-lmps) reaches both passes at once.
 *
 * The session comes in two shapes because the two passes need different ones, and the difference is
 * real: product-master always has something to say (it dispatches a claude session), while the
 * gardener runs no session at all and only speaks when it shadows — so a nightly patrol over a clean
 * board must leave no empty row behind.
 */
import { beads } from "../beads/bd";
import type { NudgeTarget } from "../beads/sync-nudge";
import type { ProposalAutonomyPolicy } from "../gardener/autonomy";
import { getProjectById } from "../projects";
import {
  appendSessionLog,
  endSession,
  startJobSession,
  type JobSession,
  type SessionKind,
} from "../sessions";
import type { Project } from "../types";
import { PoisonError } from "./errors";
import type { AntonDb, Clock } from "./queue";
import type { JobContext } from "./runner";

/** One-line error text for a pass's log. */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * What every step of a pass shares: where it runs, when it runs, and how it speaks. Assembled once
 * by the handler and threaded through its steps, so a step's own signature carries only what makes
 * it that step.
 *
 * `policy` rides here because it is read ONCE per pass on purpose — an operator editing autonomy
 * mid-pass must not have one proposal shadowed under a rule the next one is not.
 */
export interface PassScope {
  /** The pass's project: its id names the log lines, its repo is where every verb runs. */
  project: NudgeTarget;
  /** The project slug, for the console lines an operator greps. */
  slug: string;
  /** How far this project lets a filed proposal go, per kind (anton-nbyy). */
  policy: ProposalAutonomyPolicy;
  clock: Clock;
  ctx: JobContext;
  /** Propagate a board write to the other machines. */
  nudge: (project: NudgeTarget) => void;
  /** Append to the pass's session log. */
  log: (chunk: string) => Promise<void>;
}

/**
 * The project this pass runs for. A pass for a project that is gone can never succeed, so it parks
 * for a human instead of burning the runner's retries.
 */
export async function passProject(db: AntonDb, projectId: string): Promise<Project> {
  const project = await getProjectById(db, projectId);
  if (!project) throw new PoisonError(`project ${projectId} not found`);
  return project;
}

/**
 * Pull the shared board before the pass reads it: this checkout's Dolt working set can be a sync
 * heartbeat behind, and a pass judges — and writes — from what it reads.
 *
 * Best-effort, and the caller says how to report a failure: an unreachable remote costs a pass its
 * freshness, never its whole run, and every verb downstream is still correct against the local board.
 */
export async function pullBoard(
  repo: string,
  onFailure: (e: unknown) => void | Promise<void>,
): Promise<void> {
  await beads.pull(repo).catch(onFailure);
}

export interface PassSessionInput {
  ctx: JobContext;
  projectId: string;
  kind: SessionKind;
  /** Reported alongside the live handle for a pass that runs claude somewhere (anton-susu). */
  cwd?: string;
}

/** A pass's session log, whether or not the row behind it exists yet. */
export interface PassSession {
  log: (chunk: string) => Promise<void>;
  /** Settle the row. A no-op for a pass that never opened one. */
  end: (status: "done" | "failed") => Promise<void>;
}

export interface OpenPassSession extends PassSession {
  sessionId: string;
  /** Streams claude events to the log as `[type] text` lines. */
  onEvent: JobSession["onEvent"];
}

/**
 * Open the row and report the live handle. `jobId` is the durable half of the link: these passes
 * write no run row, so once one settles the jobs page is the only route to its log.
 */
async function openRow(db: AntonDb, clock: Clock, input: PassSessionInput): Promise<JobSession> {
  const session = await startJobSession(db, clock, {
    projectId: input.projectId,
    kind: input.kind,
    jobId: input.ctx.jobId,
  });
  input.ctx.report(
    input.cwd ? { sessionId: session.sessionId, cwd: input.cwd } : { sessionId: session.sessionId },
  );
  return session;
}

/** The session of a pass that is going to have output regardless — opened up front. */
export async function openPassSession(
  db: AntonDb,
  clock: Clock,
  input: PassSessionInput,
): Promise<OpenPassSession> {
  const session = await openRow(db, clock, input);
  return {
    sessionId: session.sessionId,
    onEvent: session.onEvent,
    log: (chunk) => appendSessionLog(session.logPath, chunk),
    end: (status) => endSession(db, clock, session.sessionId, status),
  };
}

/**
 * The session of a pass that may have nothing to say — opened on its FIRST write, so a patrol over a
 * clean board leaves no empty session behind.
 */
export function deferPassSession(db: AntonDb, clock: Clock, input: PassSessionInput): PassSession {
  let session: JobSession | undefined;
  return {
    log: async (chunk) => {
      if (!session) session = await openRow(db, clock, input);
      await appendSessionLog(session.logPath, chunk);
    },
    end: async (status) => {
      if (session) await endSession(db, clock, session.sessionId, status);
    },
  };
}
