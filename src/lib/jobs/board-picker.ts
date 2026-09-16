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
 *
 * And no longer the only writer (anton-f12y): the board read decides the same question from the
 * board it is already holding, and records it. So this pass writes as the FALLBACK — it decides and
 * records exactly as before, but yields rather than replace a generation derived from a strictly
 * fresher look at the board (anton-m4il). What it STARTS is untouched by that: the apply acts on the
 * decision this pass just made, never on the row.
 */
import { loadAllIssues } from "../beads/issues";
import { saveBoardPickerPlan } from "../board-picker-plan";
import { getProjectById } from "../projects";
import { PoisonError } from "./errors";
import {
  applyPickerPlan,
  type PickerApplyInput,
  pickerWipHold,
  type PickerApplyOutcome,
  type PickerRunOps,
} from "./picker-apply";
import { runBoardPickerBrakes, rankBoardPickerPlan, resolveArmedPolicy } from "./board-picker-brakes";
import type { ReadPrActivity } from "./picker-wip-hold";
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
  /**
   * How a start reaches the queue. Wired to the runner in `service.ts` so an apply racing project
   * deletion is refused by the same quiesce barrier every other enqueue path crosses; a test that
   * passes none gets the db-direct verbs. See {@link PickerRunOps}.
   */
  run?: PickerRunOps;
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
    const board = await loadAllIssues(project.repoPath, { strictGates: true, withCycles: true });

    // Every brake the pass asks before it may act on what it decides — disarm, the two failure
    // breakers behind it, the WIP hold, the operator's track record and the autonomy it earns — asked
    // in the registered order {@link BOARD_PICKER_BRAKES} pins, not inlined here (anton-7p5x).
    const brakes = await runBoardPickerBrakes({
      db,
      clock,
      projectId,
      repoPath: project.repoPath,
      board,
      signal: ctx.signal,
      ...(deps.readPrActivity ? { readPrActivity: deps.readPrActivity } : {}),
    });
    const decision = await rankBoardPickerPlan(db, {
      projectId,
      board,
      observedAtMs,
      armed: brakes.armed,
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
    //
    // And the pass yields to a fresher one (anton-m4il). The board read records the same decision
    // from the board it is holding, so this tick is the FALLBACK writer: it stamped its observation
    // before a board read that costs seconds, and an operator looking at the project in that window
    // has already written down a generation decided from a later board. Replacing it would retire
    // the generation the Release button on screen names, and the accept filed against it would be
    // refused. When no such read happened — the ordinary case, and every case on an unwatched
    // project — nothing here is different: the row can only carry an earlier observation, so the
    // pass records exactly as before.
    await saveBoardPickerPlan(db, clock, {
      projectId,
      jobId: ctx.jobId,
      yieldToFresher: true,
      ...decision,
    });

    // ARM (R1.5). Everything above decided; this is the only branch that writes to the board. The
    // three refusals are the brakes, in the order an operator would ask about them: a frozen project
    // needs a human to re-arm, a held one releases itself on the next merge, and a project below
    // `apply` never asked for this at all. The start itself, and the housekeeping that follows it, are
    // {@link applyTopPick}'s — kept out of this function so its own nesting doesn't compound here.
    const applied =
      brakes.autonomy === "apply" && !brakes.disarm && !brakes.hold
        ? await applyTopPick(ctx, { db, clock, projectId, repoPath: project.repoPath, decision, deps })
        : undefined;

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
 * Start the plan's top pick, once the brakes clear it, and settle the post-write housekeeping beside
 * it — the restamp and the teardown re-confirmation. Split out of {@link makeBoardPickerHandler} so
 * the arm gate's own nesting doesn't compound with the handler's.
 *
 * Re-gated on the signal before it starts anything, and for a sharper reason than the plan write
 * above: `abortProject` aborts this pass AND deletes the project's queued/running rows, so a start
 * that slipped through after the abort would write `approved` + a claim to the real board and insert
 * a fresh execute-epic row — tripping the abort's own leftover guard and leaving an anton-claimed
 * target on the board of a project being torn down.
 */
async function applyTopPick(
  ctx: JobContext,
  input: {
    db: AntonDb;
    clock: Clock;
    projectId: string;
    repoPath: string;
    decision: { entries: PickerApplyInput["entries"] };
    deps: BoardPickerDeps;
  },
): Promise<PickerApplyOutcome> {
  const { db, clock, projectId, repoPath, decision, deps } = input;
  ctx.signal.throwIfAborted();
  let applied = await startTopPick(ctx, {
    db,
    clock,
    projectId,
    repoPath,
    entries: decision.entries,
    // The gate above only proves the pass was live when the apply began; the apply itself spends
    // seconds on `bd`, so it re-asks at every seam and unwinds its own writes when a cancel wins
    // (PR #218 review).
    signal: ctx.signal,
    // The flow brake's re-check, built here so it re-asks through the same `gh` reader this pass's
    // entry check used — a test that never spawns `gh` must not start doing so at the apply's final
    // gate.
    held: pickerWipHold(db, {
      projectId,
      repoPath,
      signal: ctx.signal,
      ...(deps.readPrActivity ? { readPrActivity: deps.readPrActivity } : {}),
    }),
    ...(deps.run ? { run: deps.run } : {}),
  });
  // The apply rewrote the very board the plan above was stamped from — the assignee and the
  // `approved` label are both inputs to that fence (`stampBoard`) — so the row just saved now reads
  // STALE, and a stale plan withholds the whole Up Next lane (PR #218 review). Left there, apply mode
  // would never show the live preview its lower-ranked picks are vetoed from: every pass would start
  // a target and invalidate its own ranking in the same breath. So the plan is re-decided over the
  // post-write board, which drops the started target as `claimed` and leaves the survivors current.
  //
  // Keyed on the WRITES, not on the start (PR #218 review): a skip is not always a no-op on the
  // board — a target an already-live run covers keeps the approval and the claim this pass wrote,
  // which move the same fence a start does — and those passes would otherwise withhold Up Next for a
  // cadence over a board change anton made itself.
  if ("started" in applied || applied.skipped.wroteBoard) {
    await restampAfterWrites(ctx, { db, clock, projectId, repoPath });
    // That restamp is a board read long, and a cancel landing in it is `abortProject` deleting the
    // run those writes cover (PR #218 review) — the one the apply just enqueued, or the live one it
    // deferred to. Writes covering no run are not a start: they come back off and the pass reports
    // the skip it became rather than an outcome with no run behind it.
    const swept = await applied.confirmStart?.();
    if (swept) {
      logApplyOutcome(projectId, swept);
      applied = swept;
    }
  }
  return applied;
}

/**
 * Re-decide and re-record the plan over the board this pass's own writes rewrote — a start, or a
 * skip that left the approval and the claim standing (PR #218 review).
 *
 * BEST-EFFORT by construction, and that is the whole reason it is a function rather than a second
 * inline block: the run is already enqueued, so a throw here would retry the pass — and the retry,
 * reading a board whose top pick is now claimed, would start the NEXT target. A restamp that fails
 * costs one cadence of a withheld lane; a restamp that fails the pass costs a second unattended run.
 *
 * The abort gate is the plan write's, for the plan write's reason: `abortProject` deletes the row
 * this would otherwise resurrect. It bails quietly rather than throwing, so teardown is not logged
 * as a restamp failure.
 */
async function restampAfterWrites(
  ctx: JobContext,
  input: {
    db: AntonDb;
    clock: Clock;
    projectId: string;
    repoPath: string;
  },
): Promise<void> {
  const { db, clock, projectId, repoPath } = input;
  try {
    await ctx.heartbeat();
    const observedAtMs = clock.now();
    // BOTH inputs are re-read, not just the board (PR #218 review): the policy this restamp is
    // decided under is the plan's freshness fence, so restamping a fresh board under the snapshot
    // taken before the start would record survivors the current policy excludes and stamp them with
    // the superseded digest — which the next pass reads as stale, withholding Up Next for another
    // cadence, the very thing this restamp exists to prevent.
    const armed = await resolveArmedPolicy(db, projectId);
    const board = await loadAllIssues(repoPath, { strictGates: true, withCycles: true });
    const decision = await rankBoardPickerPlan(db, { projectId, board, observedAtMs, armed });
    if (ctx.signal.aborted) return;
    // Still the pass, so still the fallback writer (anton-m4il): the correction this restamp exists
    // to make is worth a cadence, never the generation a board read has since offered a start
    // against. A read fresh enough to win here re-reads within its own snapshot window and records
    // the claim itself, and the approve route's fence refuses a release the board has moved past.
    await saveBoardPickerPlan(db, clock, {
      projectId,
      jobId: ctx.jobId,
      yieldToFresher: true,
      ...decision,
    });
  } catch (err) {
    console.warn(
      `[board-picker] ${projectId}: the start landed but its plan could not be restamped — ` +
        `Up Next stays withheld until the next pass`,
      err,
    );
  }
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
  logApplyOutcome(input.projectId, outcome);
  return outcome;
}

/**
 * One line per apply outcome, whichever way it went — shared with the post-restamp re-confirmation,
 * so a start the teardown sweep took back is reported in the same band as any other stand-down
 * rather than left as a "started" line the run behind it no longer backs.
 */
function logApplyOutcome(projectId: string, outcome: PickerApplyOutcome): void {
  if ("started" in outcome) {
    const { beadId, rank, rule, jobId } = outcome.started;
    console.info(
      `[board-picker] ${projectId}: started ${beadId} (rank ${rank}, ${rule}) as job ${jobId}`,
    );
    return;
  }
  const { beadId, reason } = outcome.skipped;
  console.info(
    `[board-picker] ${projectId}: started nothing${beadId ? ` (${beadId})` : ""} — ${reason}`,
  );
}
