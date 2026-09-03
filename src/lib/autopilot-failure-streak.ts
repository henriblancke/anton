/**
 * The consecutive-failure breaker's arithmetic (anton-rgso / R4.4).
 *
 * The signal is not that a run failed — it is that N did, in a row, with nothing landing between
 * them. A hard ticket fails ALONE: the next run picks up different work in a different worktree and
 * delivers. A broken environment fails everything it touches — a toolchain that no longer installs,
 * a test command that was renamed, a base branch that won't check out — and each failure looks
 * exactly like the last. So the breaker counts the streak and, when the failures share a message,
 * says which one it is: that sentence is the difference between "anton is stuck" and "anton is
 * stuck on THIS", and it is the whole reason a human is being asked.
 *
 * Pure and structural, like the score alarm it sits beside (jobs/review-alarm.ts). The caller reads
 * the run rows and the two facts a run row cannot answer about itself — whether an operator
 * cancelled the job behind it, and whether the work it carried was abandoned — so the streak rules
 * stay testable without a db, a repo or a job queue.
 */
import type { RunStatus } from "@/components/runs/run-view-utils";

/** What one run says about the environment it ran in. */
export type RunVerdict = "delivered" | "failure" | "ignored";

/** The facts the breaker reads about one run. `RunSummary` satisfies the run-row half structurally. */
export interface RunOutcome {
  id: string;
  /** The run target — what the evidence names, since a run id means nothing to an operator. */
  epicBeadId: string;
  status: RunStatus;
  /** The run row's error. The failure point the streak is compared on; absent on a clean exit. */
  error?: string;
  /**
   * An operator force-stopped the job behind this run (`cancelled` in jobs/queue.ts). Terminal and
   * human-initiated, which is exactly why it is not evidence — see {@link verdictOf}.
   */
  cancelled?: boolean;
  /** The work this run carried was closed won't-do (`abandoned` on the bead). */
  abandoned?: boolean;
  /**
   * The ticket the run stopped inside, when it stopped inside one. A repair acts on the bead that
   * BLOCKED, and inside a grouped run that is a child — so a weigher reading only `epicBeadId`
   * would never see the repair it is meant to price.
   */
  ticketBeadId?: string;
  /**
   * Unix SECONDS the run started. Carried for the weigher alone: "a failed repair" is a failure that
   * came AFTER one, and without an instant to order against, the block that provoked the repair
   * counts as its failure too.
   */
  startedAt?: number;
}

/**
 * How much one failed run weighs against the threshold.
 *
 * A hook rather than a constant because failures are not equal evidence: a failed AUTO-REPAIR is a
 * second failure stacked on the one it was dispatched to fix, and it counts double (R5.8 —
 * gardener/repair.ts `repairedFailureWeight`). Passing the weigher in keeps that decision at the
 * call site instead of teaching this module about repairs it has no other reason to know.
 */
export type FailureWeight = (run: RunOutcome) => number;

/** The default: every failure counts once. */
export const EVEN_WEIGHT: FailureWeight = () => 1;

/** The operator's threshold, and how failures are counted against it. */
export interface FailureBreakerConfig {
  /** N — the weight that trips the breaker. Below 1 disables it. */
  threshold: number;
  /** Absent → {@link EVEN_WEIGHT}. */
  weigh?: FailureWeight;
}

/** A tripped breaker, carrying the case the operator re-arms (or doesn't) on. */
export interface FailureStreak {
  /** The consecutive failures, OLDEST first — the order the story reads in. */
  runs: RunOutcome[];
  /** What they weigh; at or above {@link threshold} is what tripped it. */
  weight: number;
  threshold: number;
  /** The failure point every run in the streak shares, when they share one. */
  commonFailure?: string;
}

/**
 * How one run counts.
 *
 * Three rules, and the order between them is the point:
 *
 *   • `done` is a DELIVERY, and a delivery ends any streak behind it — whatever was wrong, work is
 *     landing again.
 *   • an ABANDONED run counts as a failure (R4.4). Abandoning work also kills its job, so an
 *     abandoned run is a cancelled one too; the abandonment is what matters, so it is read first.
 *   • a CANCELLED run counts as nothing. jobs/queue.ts documents `cancelled` as terminally killed by
 *     an operator — a person saying stop is not evidence that anything went wrong. It is skipped
 *     rather than treated as a reset for the same reason: it says nothing about the environment, so
 *     it must not clear a streak either. The runs either side of it are still the same story.
 *
 * Everything still in flight (`queued`, `running`) has no outcome yet and is likewise skipped.
 */
export function verdictOf(run: RunOutcome): RunVerdict {
  if (run.status === "done") return "delivered";
  if (run.abandoned) return "failure";
  if (run.cancelled) return "ignored";
  if (run.status === "parked" || run.status === "failed") return "failure";
  return "ignored";
}

/** The running tally {@link detectFailureStreak} judges. */
export interface StreakTally {
  /** The unbroken failures ending at the most recent settled run, oldest first. */
  runs: RunOutcome[];
  weight: number;
}

/**
 * The failures ending at the most recent settled run. `runs` is NEWEST FIRST, as `listRecentRuns`
 * returns them; the tally is returned oldest first, the way it is read.
 */
export function failureStreak(
  runs: readonly RunOutcome[],
  weigh: FailureWeight = EVEN_WEIGHT,
): StreakTally {
  const streak: RunOutcome[] = [];
  let weight = 0;
  for (const run of runs) {
    const verdict = verdictOf(run);
    if (verdict === "delivered") break;
    if (verdict === "ignored") continue;
    streak.push(run);
    weight += weigh(run);
  }
  return { runs: streak.reverse(), weight };
}

/** The breaker's verdict over the runs so far — `undefined` while the streak is short of N. */
export function detectFailureStreak(
  runs: readonly RunOutcome[],
  config: FailureBreakerConfig | undefined,
): FailureStreak | undefined {
  if (!config || config.threshold < 1) return undefined;
  const { runs: streak, weight } = failureStreak(runs, config.weigh);
  if (weight < config.threshold) return undefined;
  return {
    runs: streak,
    weight,
    threshold: config.threshold,
    commonFailure: sharedFailurePoint(streak),
  };
}

/** Enough of the error to recognise it, short enough that a header can print N of them. */
const FAILURE_POINT_CHARS = 140;

/** The first non-empty line of the run's error — where it stopped, without the stack behind it. */
function failurePoint(run: RunOutcome): string {
  const line = run.error?.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim().slice(0, FAILURE_POINT_CHARS);
}

/**
 * Two failures are the same point once the run-specific parts are taken out: "ticket anton-a1b2
 * timed out after 45m" and "ticket anton-c3d4 timed out after 45m" are one broken environment
 * described twice, not two hard tickets. Any token carrying a digit — bead id, path, duration,
 * port — is what varies between two runs of the same break, so that is what collapses.
 */
function signatureOf(point: string): string {
  return point
    .toLowerCase()
    .replace(/[\w./:-]*\d[\w./:-]*/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The one failure point the whole streak shares, or nothing.
 *
 * Deliberately all-or-nothing: naming a point that only most of the runs hit would send an operator
 * to diagnose a break that isn't the one stopping them. A streak with a run whose error was never
 * recorded shares nothing by definition — there is no evidence it agrees with the rest.
 */
export function sharedFailurePoint(runs: readonly RunOutcome[]): string | undefined {
  const points = runs.map(failurePoint);
  if (points.length === 0 || points.some((p) => p.length === 0)) return undefined;
  const signature = signatureOf(points[0]);
  if (!signature) return undefined;
  return points.every((p) => signatureOf(p) === signature) ? points[0] : undefined;
}

/** Why the breaker fired, in one sentence — the disarm's `detail`. */
export function describeFailureStreak(streak: FailureStreak): string {
  const n = streak.runs.length;
  const opening = `${n} run${n === 1 ? "" : "s"} in a row ended without delivering`;
  return streak.commonFailure
    ? `${opening}, every one of them at the same point: ${streak.commonFailure}`
    : `${opening}, with no failure point in common.`;
}

/**
 * One line per run, oldest first — which run, on what work, how it ended, and where. The operator's
 * whole case for re-arming or not, which is why it names the runs individually rather than
 * summarising them: a streak of three timeouts on one epic and a streak across three different
 * epics are the same count and completely different problems.
 */
export function failureStreakEvidence(streak: FailureStreak): string[] {
  return streak.runs.map((run) => {
    const how = run.abandoned ? "abandoned" : run.status;
    const point = failurePoint(run);
    return [run.id.slice(0, 8), run.epicBeadId, how, point].filter(Boolean).join(" · ");
  });
}
