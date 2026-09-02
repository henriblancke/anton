/**
 * board-picker job (anton-albm). The scheduled pass that reads the board and decides what should run
 * next — eligibility, then the standing policy, then the PRIME ranking — and records that decision
 * as one plan per project.
 *
 * DECIDING is all it does below `apply` (anton-qlci): at `propose` and `shadow` nothing here writes
 * to the board and nothing starts a run — the plan is a ranking a human reads, and `execute-epic` is
 * enqueued by the approve route on an explicit click. At `apply` the pass also STARTS its top pick,
 * through `./picker-apply`, which writes `approved` + the auto-claim under the bead's claim lock and
 * enqueues the run. That step is the one thing the brakes below exist to refuse: a disarmed project
 * and a held one still get their ranking, and start nothing — and so does one whose own accept/veto
 * record has not EARNED `apply` (anton-vkp9), whatever the setting says.
 *
 * Mechanical by design — a board read, a pure decision, one row. No Claude session on the tick
 * (docs/plans/2026-08-18-002-feat-autopilot-design.md, D3: "an LLM cannot be a hash function"), which
 * is what makes a ten-minute cadence cost nothing.
 *
 * Split the way gate-check is split from gate-targets: every fact that could change the answer lives
 * in the pure decision (./picker-decision, over ./picker-targets and beads/rank), and this module
 * owns only the I/O ends — the board read, the write of the plan, and the call into ./picker-apply.
 *
 * IDEMPOTENT by construction. The plan is one row per project, replaced whole, so two overlapping
 * passes leave one row saying the same thing rather than a queue of events; and an empty plan is the
 * signal "decided, nothing to start", not "never ran".
 */
import { loadAllIssues } from "../beads/issues";
import { activeDisarm } from "../autopilot-disarm";
import { describeFailureStreak } from "../autopilot-failure-streak";
import { describeScoreSlide } from "../autopilot-score-slide";
import { describeWipHold } from "../autopilot-wip";
import { saveBoardPickerPlan } from "../board-picker-plan";
import { activeDeferrals, pickerTrackRecord } from "../picker-veto";
import { earnedPickerAutonomy } from "../gardener/autonomy";
import {
  getProjectById,
  getProjectSettings,
  resolvePickerAutonomy,
  resolvePickerPolicy,
} from "../projects";
import { PoisonError } from "./errors";
import { applyPickerPlan, type PickerApplyInput, type PickerApplyOutcome } from "./picker-apply";
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
    // still recorded, because it is a ranking and not a start, and the latch is what the apply step
    // below refuses on.
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
    // Derived, never latched: it is re-asked on every pass — including the one that would start the
    // work — so nothing here has to persist an answer that the next merge invalidates.
    const hold = await checkWipLimit(db, {
      projectId,
      repoPath: project.repoPath,
      board,
      signal: ctx.signal,
      ...(deps.readPrActivity ? { readPrActivity: deps.readPrActivity } : {}),
    });
    if (hold) console.info(`[board-picker] ${projectId}: holding — ${describeWipHold(hold)}`);

    // Whether the project is FROZEN, asked of the disarm table rather than of the two checks above:
    // both answer `undefined` on an already-disarmed project (a latch does not re-latch), so reading
    // their verdicts alone would treat every pass after the first as armed again.
    const disarm = await activeDisarm(db, projectId);

    // The policy the operator accepted in settings, applied to the plan this pass records: a panel
    // that says a policy is armed while the plan admits everything is advertising a boundary anton
    // does not keep. An unarmed project keeps the structural default — the pass starts nothing, so
    // an unnarrowed plan is a ranking, not an autopilot.
    const settings = await getProjectSettings(db, projectId);
    const armed = resolvePickerPolicy(settings);
    // How far this pass may go with what it decides. Resolved here, before the decision, so the one
    // fact that turns a ranking into a start is read from the same settings snapshot the policy is.
    //
    // The record is the second half of that resolution (anton-vkp9): `apply` is floored by what this
    // project's own releases and vetoes have EARNED, not by the setting alone. Re-read every pass —
    // the window rolls, so a record that degrades after arming returns the picker to `shadow` on the
    // next tick rather than the next time somebody looks at settings.
    const record = await pickerTrackRecord(db, projectId);
    const autonomy = resolvePickerAutonomy(settings, record);
    // Said out loud, because a setting the pass silently ignores is the unexplained state this whole
    // floor exists to avoid: the operator asked for `apply` and is getting `shadow`, and the counts
    // are the only thing that tells them why, and what would lift it.
    if (settings.pickerAutonomy === "apply" && autonomy !== "apply" && settings.pickerPolicy) {
      console.info(
        `[board-picker] ${projectId}: apply not earned — ${earnedPickerAutonomy(record).reason}`,
      );
    }
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

    // ARM (R1.5). Everything above decided; this is the only branch that writes to the board. The
    // three refusals are the brakes, in the order an operator would ask about them: a frozen project
    // needs a human to re-arm, a held one releases itself on the next merge, and a project below
    // `apply` never asked for this at all.
    let applied: PickerApplyOutcome | undefined;
    if (autonomy === "apply" && !disarm && !hold) {
      // Re-gated on the signal, like the plan write above and for a sharper reason: `abortProject`
      // aborts this pass AND deletes the project's queued/running rows, so a start that slipped
      // through after the abort would write `approved` + a claim to the real board and insert a
      // fresh execute-epic row — tripping the abort's own leftover guard and leaving an
      // anton-claimed target on the board of a project being torn down.
      ctx.signal.throwIfAborted();
      applied = await startTopPick(ctx, {
        db,
        clock,
        projectId,
        repoPath: project.repoPath,
        entries: decision.entries,
      });
    }

    // The pass always writes a row, so "changed" is about the RANKING, not the write: a board with
    // nothing claimable produces an empty plan, and calling that a result would make every idle slot
    // look like work. A START outranks that reading — it is the one outcome of this pass that moved
    // something outside anton.
    const ranked = decision.entries.length;
    if (applied && "started" in applied) {
      const { beadId, rank } = applied.started;
      return { changed: true, note: `started ${beadId} (rank ${rank} of ${ranked})` };
    }
    return ranked > 0
      ? { changed: true, note: `ranked ${ranked} target(s)` }
      : { changed: false, note: "nothing claimable to rank" };
  };
}

/**
 * Start the plan's top pick and say so in the log, whichever way it went.
 *
 * Heartbeats first: the apply spawns several `bd` calls (a pull, a board read, the claim, the label,
 * the note) behind the Dolt lock, and the pass has already spent its no-progress budget on the board
 * read above — a start killed halfway is the one shape of this pass that leaves board state behind.
 *
 * A skip is logged at info and NOT an error: a target claimed since the plan was decided, a run
 * already covering it, a board that would not refresh — each is the guard working, and drawing them
 * as faults would teach an operator to discount the band a real failure needs.
 */
async function startTopPick(
  ctx: JobContext,
  input: PickerApplyInput,
): Promise<PickerApplyOutcome> {
  await ctx.heartbeat();
  const outcome = await applyPickerPlan(input);
  if ("started" in outcome) {
    const { beadId, rank, rule, jobId } = outcome.started;
    console.info(
      `[board-picker] ${input.projectId}: started ${beadId} (rank ${rank}, ${rule}) as job ${jobId}`,
    );
  } else {
    const { beadId, reason } = outcome.skipped;
    console.info(
      `[board-picker] ${input.projectId}: started nothing${beadId ? ` (${beadId})` : ""} — ${reason}`,
    );
  }
  return outcome;
}
