/**
 * board-picker job (anton-albm). The scheduled pass that reads the board and decides what should run
 * next — eligibility, then the standing policy, then the PRIME ranking — and records that decision
 * as one plan per project.
 *
 * It DECIDES ONLY. Nothing here writes to the board and nothing starts a run: the `approved` write,
 * the auto-claim and the enqueue are the arming feature's (R1.5), which reads this plan rather than
 * re-deriving it. What arming an operator does today buys is the ranking, kept fresh.
 *
 * Mechanical by design — a board read, a pure decision, one row. No Claude session on the tick
 * (docs/plans/2026-08-18-002-feat-autopilot-design.md, D3: "an LLM cannot be a hash function"), which
 * is what makes a ten-minute cadence cost nothing.
 *
 * Split the way gate-check is split from gate-targets: every fact that could change the answer lives
 * in the pure decision (./picker-decision, over ./picker-targets and beads/rank), and this module
 * owns only the two I/O ends — the board read and the write of the plan.
 *
 * IDEMPOTENT by construction. The plan is one row per project, replaced whole, so two overlapping
 * passes leave one row saying the same thing rather than a queue of events; and an empty plan is the
 * signal "decided, nothing to start", not "never ran".
 */
import { loadAllIssues } from "../beads/issues";
import { describeFailureStreak } from "../autopilot-failure-streak";
import { describeScoreSlide } from "../autopilot-score-slide";
import { saveBoardPickerPlan } from "../board-picker-plan";
import { getProjectById } from "../projects";
import { PoisonError } from "./errors";
import { checkFailureStreak } from "./picker-failure-breaker";
import { checkScoreSlide } from "./picker-score-breaker";
import { ADMIT_ALL_POLICY, decideBoardPickerPlan } from "./picker-decision";
import { systemClock, type AntonDb, type Clock } from "./queue";
import type { JobContext, JobHandler } from "./runner";

/** What the scheduler enqueues for this type — the shape every scheduled job carries. */
export interface BoardPickerPayload {
  projectId: string;
  scheduleId?: string;
}

export interface BoardPickerDeps {
  db: AntonDb;
  clock?: Clock;
}

/** Build the runner handler. Register it as the "board-picker" handler. */
export function makeBoardPickerHandler(deps: BoardPickerDeps): JobHandler {
  const db = deps.db;
  const clock = deps.clock ?? systemClock;

  return async function boardPicker(ctx: JobContext): Promise<void> {
    const { projectId } = ctx.payload as BoardPickerPayload;
    const project = await getProjectById(db, projectId);
    if (!project) throw new PoisonError(`project ${projectId} not found`);

    // Stamped BEFORE the read, so a bead written while `bd` was listing counts as having changed
    // "since we looked" — the fence must err towards calling a plan stale, never towards missing a
    // move it did not see.
    const observedAtMs = clock.now();
    // Read DIRECTLY rather than through the UI snapshot, and STRICT on the gate listing: a job that
    // silently got a gate-less board would read every dangling gate edge as an open blocker and
    // record a plan that excludes half the board as `blocked`. A rejection retries the pass instead.
    const board = await loadAllIssues(project.repoPath, { strictGates: true });

    // The brake before the ranking (R4.4). A project whose last N runs all stopped without
    // delivering is disarmed here, on the same board read the plan is computed from — the plan is
    // still recorded, because it is a ranking and not a start, and the latch is what the arming
    // step (R1.5) refuses on.
    const breaker = await checkFailureStreak(db, clock, { projectId, board });
    if (breaker?.latched) {
      console.warn(
        `[board-picker] ${projectId}: disarmed — ${describeFailureStreak(breaker.streak)}`,
      );
    }

    // The second quality brake (R4.3): runs that DELIVER but keep scoring below the floor. It runs
    // after the failure breaker rather than beside it because both latch the same single disarm —
    // whichever fires first owns the freeze, and the other reads it as already-disarmed and abstains
    // rather than stacking a second thing for the operator to clear.
    const slide = await checkScoreSlide(db, clock, { projectId, board });
    if (slide?.latched) {
      console.warn(`[board-picker] ${projectId}: disarmed — ${describeScoreSlide(slide.slide)}`);
    }

    const decision = decideBoardPickerPlan({
      board,
      policy: ADMIT_ALL_POLICY,
      runtime: { observedAtMs },
    });

    // The board read is the only slow step, and it doesn't heartbeat: two `bd list` calls behind the
    // Dolt lock can outlast the per-attempt no-progress timeout on a big board, killing a pass that
    // was making progress and burning a retry attempt.
    await ctx.heartbeat();

    // The plan is one row per project, replaced whole, so a cancelled pass that still wrote would
    // overwrite the last good plan — and during `abortProject` teardown it would resurrect a row the
    // abort just deleted. Nothing above notices a cancel (the board read isn't abortable and
    // `heartbeat` doesn't inspect the signal), so the write is gated here explicitly, as the sibling
    // read-then-upsert passes do.
    ctx.signal.throwIfAborted();

    // The job id goes on the row: "which pass decided this?" is the first question asked of a plan
    // an operator disagrees with, and the job carries the logs that answer it.
    await saveBoardPickerPlan(db, clock, { projectId, jobId: ctx.jobId, ...decision });
  };
}
