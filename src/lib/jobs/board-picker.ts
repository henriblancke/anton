/**
 * board-picker job (anton-albm). The scheduled pass that reads the board and decides what should run
 * next — eligibility, then the standing policy, then the PRIME ranking — and records that decision
 * as one plan per project.
 *
 * It DECIDES ONLY. Nothing here writes to the board and nothing starts a run: the `approved` write,
 * the auto-claim and the enqueue are the arming feature's (R1.5, anton-vspi — which is what reads
 * the brakes below and refuses on them), which reads this plan rather than re-deriving it. Until it
 * lands, nothing starts an epic unattended at all: `execute-epic` is enqueued by the approve route,
 * on an explicit human click. What arming an operator does today buys is the ranking, kept fresh.
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
import { describeWipHold } from "../autopilot-wip";
import { saveBoardPickerPlan } from "../board-picker-plan";
import { activeDeferrals } from "../picker-veto";
import { getProjectById, getProjectSettings, resolvePickerPolicy } from "../projects";
import { PoisonError } from "./errors";
import { checkFailureStreak } from "./picker-failure-breaker";
import { checkScoreSlide } from "./picker-score-breaker";
import { checkWipLimit, type ReadPrActivity } from "./picker-wip-hold";
import { ADMIT_ALL_POLICY, decideBoardPickerPlan } from "./picker-decision";
import { armedPickerPolicy } from "./picker-policy";
import { systemClock, type AntonDb, type Clock } from "./queue";
import type { JobContext, JobEffect, JobHandler } from "./runner";

/** What the scheduler enqueues for this type — the shape every scheduled job carries. */
export interface BoardPickerPayload {
  projectId: string;
  scheduleId?: string;
}

export interface BoardPickerDeps {
  db: AntonDb;
  clock?: Clock;
  /**
   * How the WIP hold learns a PR's state. Injectable so tests (and any future non-GitHub forge)
   * don't need `gh`; the default is the real read-only `gh pr view`, as run-health uses.
   */
  readPrActivity?: ReadPrActivity;
}

/** Build the runner handler. Register it as the "board-picker" handler. */
export function makeBoardPickerHandler(deps: BoardPickerDeps): JobHandler {
  const db = deps.db;
  const clock = deps.clock ?? systemClock;

  return async function boardPicker(ctx: JobContext): Promise<JobEffect> {
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
    // step (R1.5, anton-vspi) refuses on.
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
    const slide = await checkScoreSlide(db, clock, { projectId });
    if (slide?.latched) {
      console.warn(`[board-picker] ${projectId}: disarmed — ${describeScoreSlide(slide.slide)}`);
    }

    // The FLOW brake (R4.2), and the only one that clears itself: while the operator's review queue
    // is full, anton stops starting work and the next merge or close releases it. Reported at info
    // rather than warn, and worded as a limit rather than a fault, because that is what it is — a
    // hold drawn like a failure teaches an operator to discount the band the disarms need.
    //
    // Derived, never latched: the arming step (R1.5, anton-vspi) re-asks this on the pass that
    // would start the work, so nothing here has to persist an answer that the next merge
    // invalidates.
    const hold = await checkWipLimit(db, {
      projectId,
      repoPath: project.repoPath,
      board,
      signal: ctx.signal,
      ...(deps.readPrActivity ? { readPrActivity: deps.readPrActivity } : {}),
    });
    if (hold) console.info(`[board-picker] ${projectId}: holding — ${describeWipHold(hold)}`);

    // The policy the operator accepted in settings, applied to the plan this pass records: a panel
    // that says a policy is armed while the plan admits everything is advertising a boundary anton
    // does not keep. An unarmed project keeps the structural default — the pass starts nothing, so
    // an unnarrowed plan is a ranking, not an autopilot.
    const armed = resolvePickerPolicy(await getProjectSettings(db, projectId));
    // What the operator vetoed and has not un-vetoed by waiting (anton-jqvy). Judged against the
    // OBSERVATION instant, like the age criterion beside it, so one pass answers "is this still
    // deferred?" the same way for every target it ranks.
    const deferrals = await activeDeferrals(db, projectId, new Date(observedAtMs));
    const decision = decideBoardPickerPlan({
      board,
      policy: armed ? armedPickerPolicy(armed, board, new Date(observedAtMs)) : ADMIT_ALL_POLICY,
      // Stamped into the plan's freshness fence, so a settings edit that admits or excludes a target
      // invalidates this plan the moment it lands rather than a cadence later.
      ...(armed ? { armedPolicy: armed } : {}),
      runtime: { observedAtMs, deferrals },
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

    // The pass always writes a row, so "changed" is about the RANKING, not the write: a board with
    // nothing claimable produces an empty plan, and calling that a result would make every idle slot
    // look like work.
    const ranked = decision.entries.length;
    return ranked > 0
      ? { changed: true, note: `ranked ${ranked} target(s)` }
      : { changed: false, note: "nothing claimable to rank" };
  };
}
