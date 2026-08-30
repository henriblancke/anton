/**
 * The consecutive-failure breaker's I/O end (anton-rgso / R4.4): read the project's recent runs, ask
 * {@link detectFailureStreak} whether they are a broken environment, and latch the disarm if they
 * are.
 *
 * Split the way board-picker.ts is split from picker-decision.ts — the arithmetic is pure
 * (autopilot-failure-streak.ts) and everything that needs a db lives here. What this module actually
 * owns is the two facts a run row cannot answer about itself:
 *
 *   • whether an operator CANCELLED the job behind it, which jobs/queue.ts records on the job and
 *     never on the run (the run names its job, so the job id is the join);
 *   • whether the work it carried was ABANDONED, which lives on the board.
 *
 * Getting those two wrong in opposite directions is the failure mode worth the extra reads: counting
 * a cancel would disarm a project whose operator was simply tidying up, and skipping an abandon
 * would let a run of give-ups look like an idle week.
 *
 * And a third fact, off the disarm table: WHEN the operator last re-armed. Runs that settled before
 * that instant were the case they already read and overruled, so the streak starts again from the
 * re-arm — otherwise the next pass would re-latch the identical disarm off the identical runs and
 * quietly revert the human decision.
 */
import { beads } from "../beads/bd";
import type { Bead } from "../beads/types";
import {
  describeFailureStreak,
  detectFailureStreak,
  failureStreakEvidence,
  type FailureStreak,
  type FailureWeight,
  type RunOutcome,
} from "../autopilot-failure-streak";
import {
  activeDisarmForPass,
  disarmWithEscalation,
  lastReArmAt,
  settledAfterReArm,
} from "../autopilot-disarm";
import { getProjectSettings, resolveFailureBreaker } from "../projects";
import { listRecentRunOutcomes, type RunDetail } from "../runs";
import { cancelledExecuteEpicJobs, type AntonDb, type CancelledJob, type Clock } from "./queue";

/**
 * How far back the breaker looks, at minimum. Wider than any sane threshold so that cancels and
 * still-running rows interleaved with the failures cannot push the streak's oldest member out of the
 * window and quietly shorten it.
 */
const MIN_STREAK_WINDOW = 20;

/**
 * How long after a run last moved a cancel may still be its own — the LEGACY join only.
 *
 * A cancel terminalizes the JOB and the handler settles the RUN a moment later, so the two stamps
 * are close but not equal, and both are stored second-granular. The window is [run started, run last
 * moved + slack] rather than an instant for that reason.
 *
 * It is a fallback because the interval is only right for a run the cancel INTERRUPTED. A job parked
 * or queued for retry stops moving its run and then waits — for the quota window, for the operator —
 * so a cancel raised hours later, which is the ordinary case for a park, falls outside every window
 * this slack could sensibly draw. Rows carrying a `jobId` are matched on it instead; only rows
 * written before that column existed reach here.
 */
const CANCEL_MATCH_SLACK_MS = 60_000;

/**
 * Whether an operator cancelled the job behind this run.
 *
 * The join is the run's own `jobId` — the job that started or last resumed this attempt — so a
 * cancel counts as this run's however long after the run last moved the operator raised it, and a
 * cancel of some OTHER job of the same epic (a queued attempt stopped before it ever ran) counts as
 * nothing here. Exact in both directions, which the window below can only approximate.
 *
 * `nextAttemptStartMs` bounds the legacy window: it is when the SAME epic's next attempt started.
 * Without it a retry that begins inside the slack — an epic requeued seconds after the last one
 * settled — shares that instant with the attempt before it, so one cancel of the retry would also
 * silence the earlier genuine failure and shorten the streak the breaker fires on.
 */
function wasCancelled(
  run: RunDetail,
  cancels: readonly CancelledJob[] | undefined,
  nextAttemptStartMs: number | undefined,
): boolean {
  if (!cancels?.length) return false;
  if (run.jobId !== undefined) return cancels.some((cancel) => cancel.id === run.jobId);
  const from = (run.startedAt ?? run.updatedAt) * 1000;
  const until = (run.endedAt ?? run.updatedAt) * 1000 + CANCEL_MATCH_SLACK_MS;
  const beforeNextAttempt = (at: number) =>
    nextAttemptStartMs === undefined || at < nextAttemptStartMs;
  return cancels.some(({ at }) => at >= from && at <= until && beforeNextAttempt(at));
}

/** The board's won't-do beads, by id — a lookup rather than a scan per run. */
function abandonedIds(board: readonly Bead[]): Set<string> {
  return new Set(board.filter((bead) => beads.isAbandoned(bead)).map((bead) => bead.id));
}

export interface FailureBreakerInput {
  projectId: string;
  /** The board the pass just read — how an abandoned target is recognised, at no extra `bd` call. */
  board: readonly Bead[];
  /** Absent → every failure counts once. The seam a failed auto-repair later counts double through. */
  weigh?: FailureWeight;
}

export interface FailureBreakerOutcome {
  streak: FailureStreak;
  /** False when the project was already disarmed — the idempotent path. */
  latched: boolean;
  /** The disarm now freezing the project, whether this pass latched it or found it. */
  disarmId: string;
}

/**
 * Disarm the project's picker if its recent runs are a streak of failures, else do nothing.
 *
 * Returns `undefined` when the breaker is off, when the project is already disarmed (nothing to
 * decide — a latch does not clear itself, and re-deciding could only produce a second freeze the
 * operator has to clear twice), or when the streak is short of the threshold.
 */
export async function checkFailureStreak(
  db: AntonDb,
  clock: Clock,
  input: FailureBreakerInput,
): Promise<FailureBreakerOutcome | undefined> {
  const { projectId } = input;
  // Reconciled BEFORE the config is honoured, not after: this call is the only second chance either
  // half-written latch gets (see activeDisarmForPass), and both halves outlive the setting that
  // raised them. An operator who turns the breakers off while a strip row is stranded — an open
  // `autopilot-disarm` whose latch a re-arm already lifted — would otherwise leave it in "Needs you"
  // forever, since re-arming answers `not-disarmed` and dismissal refuses the kind.
  const disarmed = await activeDisarmForPass(db, clock, projectId);
  const config = resolveFailureBreaker(await getProjectSettings(db, projectId));
  if (!config || disarmed) return undefined;

  const since = await lastReArmAt(db, projectId);
  const outcomes = await readRunOutcomes(db, projectId, input.board, config.threshold, since);
  const streak = detectFailureStreak(outcomes, { ...config, weigh: input.weigh });
  if (!streak) return undefined;

  const { disarm, created } = await disarmWithEscalation(db, clock, {
    projectId,
    reason: "consecutive-failures",
    detail: describeFailureStreak(streak),
    evidence: failureStreakEvidence(streak),
  });
  return { streak, latched: created, disarmId: disarm.id };
}

/**
 * The project's recent runs as the breaker reads them, newest first — nothing from before
 * `reArmedAt`, which is the evidence the operator already adjudicated.
 */
async function readRunOutcomes(
  db: AntonDb,
  projectId: string,
  board: readonly Bead[],
  threshold: number,
  reArmedAt: number | undefined,
): Promise<RunOutcome[]> {
  const window = Math.max(MIN_STREAK_WINDOW, threshold * 3);
  const [runs, cancels] = await Promise.all([
    listRecentRunOutcomes(db, projectId, window),
    cancelledExecuteEpicJobs(db, projectId),
  ]);
  const abandoned = abandonedIds(board);
  // When each epic's next attempt started, filled in as the walk moves from newest to oldest — the
  // bound that keeps one cancel from being claimed by two attempts of the same epic.
  const nextAttemptStart = new Map<string, number>();
  // Filtered after the read, never before it: the floor only ever drops the OLDEST rows, so the
  // window still holds the newest `window` runs it was sized to hold.
  return runs
    .filter((run) => settledAfterReArm(run, reArmedAt))
    .map((run) => {
      const startedAt = run.startedAt ?? run.updatedAt;
      const nextStart = nextAttemptStart.get(run.epicBeadId);
      nextAttemptStart.set(run.epicBeadId, startedAt);
      return {
        id: run.id,
        epicBeadId: run.epicBeadId,
        status: run.status,
        error: run.error,
        // A newer row that somehow starts no later than this one is not a later attempt, so it
        // bounds nothing — `updatedAt` orders the read, and it can tie with `startedAt`.
        cancelled: wasCancelled(
          run,
          cancels.get(run.epicBeadId),
          nextStart !== undefined && nextStart > startedAt ? nextStart * 1000 : undefined,
        ),
        // The ticket counts as well as the target: abandoning a child kills the run executing it,
        // and that run ended on work somebody gave up on however its own row reads.
        abandoned:
          abandoned.has(run.epicBeadId) ||
          (run.ticketBeadId !== undefined && abandoned.has(run.ticketBeadId)),
      };
    });
}
