/**
 * What a step is HANDED and what it speaks for — the contract every handler in this directory takes.
 *
 * It lives apart from the handlers so a step module depends on the shape of a run, never on its
 * sibling steps: `steps/git.ts` and `steps/gates.ts` share this file and know nothing of each other.
 */
import type { Bead, CookedStep } from "../../beads/bd";
import type { ClaudeResult, RunClaudeOptions } from "../../claude/driver";
import type { ProjectSettings } from "../../projects";
import { startJobSession, type JobSession } from "../../sessions";
import type { ReviewFinding } from "../review-context";
import type { ReviewRound } from "../review-gate";
import type { AntonDb, Clock } from "../queue";
import type { JobContext } from "../runner";

/**
 * A step as the cooked formula carries it, re-exported from the bd seam (anton-brdg) so the registry
 * and the loader (anton-hrql) read ONE definition of a step rather than two that can drift. `labels`
 * is where the step names its handler (`step:<name>`) and, for `step:claude`, its prompt
 * (`prompt:<id>` / `skill:<id>`) — labels, not a custom TOML key, because `bd cook` silently DROPS
 * non-standard step keys, so a step's configuration has to ride somewhere that survives the cook.
 */
export type { CookedStep };

/**
 * Machinery a caller may swap. Production passes none; the unit tests pass a fake claude driver, the
 * same seam the review gate already exposes.
 */
export interface StepDeps {
  /**
   * The claude driver every dispatching step goes through. Defaults to the bare {@link runClaude};
   * the walker passes the run's resume-aware wrapper so a transient mid-stream death continues
   * in-session (anton-juar) instead of re-running the step from scratch.
   */
  runClaude?: (options: RunClaudeOptions) => Promise<ClaudeResult>;
}

/**
 * Everything a step needs to do its work — the same state execute-epic's numbered steps close over
 * today, passed explicitly so a handler is callable (and testable) on its own.
 */
export interface StepContext {
  db: AntonDb;
  clock: Clock;
  /** The runner's job context: cancellation, heartbeats, and the live-session handle. */
  ctx: Pick<JobContext, "signal" | "heartbeat" | "report">;
  projectId: string;
  runId: string;
  /** The project repo — where bd and gh run. Never the worktree. */
  repoPath: string;
  /** The run's worktree — where every step's work happens. */
  worktreePath: string;
  /** The run's branch. */
  branch: string;
  /** The base branch the PR targets — a plain branch name, which is what `gh` needs. */
  baseBranch: string;
  /**
   * The ref the run actually forked from (`origin/<base>` when the fetch landed): the accurate fork
   * point to diff against even when the local base has drifted. The review step reads it; the PR
   * step must NOT, since `gh` takes a branch and not a remote-tracking ref.
   */
  baseRef: string;
  /** The run target — the epic, or the single bead of a standalone run. */
  target: Bead;
  /** The ticket(s) this step covers, in execution order. */
  tickets: Bead[];
  settings: ProjectSettings;
  /** The formula step being executed. Absent for a caller invoking a handler directly. */
  step?: CookedStep;
  /**
   * An already-open session the caller owns. A step that dispatches an agent or shells out records
   * into it (and leaves closing it to the caller) instead of opening its own, so a caller that keeps
   * ONE session across several steps — as execute-epic does per ticket — keeps doing so.
   */
  session?: JobSession;
  /**
   * The worktree's HEAD when THIS ticket started, read before any of its steps ran.
   *
   * `step:commit` needs it to tell the two states an empty index can mean apart: an agent that
   * changed nothing, and an agent that committed its own work. Only HEAD separates them, and only a
   * per-ticket anchor makes the question answerable — on a multi-ticket run the branch already
   * carries earlier tickets' commits, so "HEAD is ahead of the base" is true whether or not THIS
   * ticket did anything.
   *
   * Absent when the caller could not read it (or invoked a handler directly): `step:commit` then
   * falls back to the index alone, which is exactly the behaviour that predates this field.
   */
  ticketStartHead?: string;
  /** Re-assert the cross-machine run-lease; throws when it has lapsed (anton-jz1). */
  assertLeaseHeld?: () => void;
  /**
   * Advisory findings an earlier `review` step left open. `pr` carries them into the PR body, and a
   * SECOND `review` is seeded with them so its own verdict speaks for the whole open set.
   */
  advisories?: ReviewFinding[];
  /**
   * Where a step records progress the caller still needs when the step THROWS. The review gate's
   * completed rounds are the only user: a gate that dies mid-flight returns nothing, but the founder
   * is still owed the rounds it finished.
   */
  rounds?: ReviewRound[];
  deps?: StepDeps;
}

/**
 * Which bead a step SPEAKS FOR — the one its commit message names and its session is filed under:
 * the single ticket in scope, else the run target.
 *
 * The distinction is the walk's two phases (anton-lnkt). A ticket-phase step is handed exactly one
 * ticket and speaks for it; a run-phase step is handed every live ticket and speaks for the run as a
 * whole, so filing its record under `tickets[0]` would send anyone diagnosing it to one arbitrary
 * bead's log for work that covered all of them.
 */
export function stepSubject(ctx: Pick<StepContext, "tickets" | "target">): Bead {
  return (ctx.tickets.length === 1 ? ctx.tickets[0] : undefined) ?? ctx.target;
}

/**
 * The session a step records into: the caller's when it handed one in (`owned: false` — the caller
 * closes it), else one this step opens and closes itself. One rule for every step that produces
 * output, so a run never leaks a `running` session and never splits one ticket's record in two.
 */
export async function stepSession(
  ctx: StepContext,
  beadId: string,
): Promise<{ session: JobSession; owned: boolean }> {
  if (ctx.session) return { session: ctx.session, owned: false };
  const session = await startJobSession(ctx.db, ctx.clock, {
    projectId: ctx.projectId,
    runId: ctx.runId,
    kind: "execute",
    beadId,
  });
  return { session, owned: true };
}

