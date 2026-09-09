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
import { isStaleCheckoutDeferral, poisonBlockerIds } from "./jobs/errors";

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
   * Unix SECONDS this ATTEMPT started — the run's start, or its most recent resume for a row a
   * resume reused. Carried for the weigher alone: "a failed repair" is a failure that came AFTER
   * one, and without an instant to order against, the block that provoked the repair counts as its
   * failure too. The attempt rather than the row, because a `dep-missing` repair parks the run it
   * repaired and the resume continues in place.
   */
  startedAt?: number;
  /**
   * Unix SECONDS this run SETTLED (`endedAt ?? updatedAt`, as the disarm fence reads it). Carried
   * for the weigher alongside {@link startedAt}: a repaired ticket can commit and then have a later
   * run-level step fail, so the deliveries that answer a repair are the ones before the run's
   * failure, not only those before its start.
   */
  settledAt?: number;
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
 * Four rules, and the order between them is the point:
 *
 *   • `done` is a DELIVERY, and a delivery ends any streak behind it — whatever was wrong, work is
 *     landing again.
 *   • a STALE-CHECKOUT deferral counts as nothing (PR #257 review). The row reads `failed`, but the
 *     run never started work — it refused a start because the anton PROCESS was behind its own code,
 *     took no lease/worktree/claim, and was rescheduled with its attempt refunded. That is a
 *     machine-wide condition that self-clears on restart, not the per-project broken environment
 *     this breaker latches on; counting it would disarm a project no work even ran in. Skipped, not
 *     a reset, for the cancelled reason below: the real runs either side are one story. Read BEFORE
 *     abandonment, because abandoning a target marks every row it ever had abandoned — including the
 *     never-started ones — and three such give-ups would otherwise latch the breaker on runs that
 *     attempted nothing.
 *   • an ABANDONED run counts as a failure (R4.4). Abandoning work also kills its job, so an
 *     abandoned run is a cancelled one too; the abandonment is what matters, so it outranks the
 *     cancel.
 *   • a CANCELLED run counts as nothing. jobs/queue.ts documents `cancelled` as terminally killed by
 *     an operator — a person saying stop is not evidence that anything went wrong. It is skipped
 *     rather than treated as a reset for the same reason: it says nothing about the environment, so
 *     it must not clear a streak either. The runs either side of it are still the same story.
 *
 * Everything still in flight (`queued`, `running`) has no outcome yet and is likewise skipped.
 */
export function verdictOf(run: RunOutcome): RunVerdict {
  if (run.status === "done") return "delivered";
  if (isStaleCheckoutDeferral(run.error)) return "ignored";
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

/**
 * Enough of the error to recognise it, short enough that a header can print N of them. A DISPLAY
 * budget only (anton-tyk0): comparing on the cut would let where the 140th character happens to
 * land decide whether two failures are the same story, so the signature reads the whole line.
 */
const FAILURE_POINT_CHARS = 140;

/** The whole first non-empty line of the run's error — where it stopped, without the stack. */
function failurePoint(run: RunOutcome): string {
  const line = run.error?.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim();
}

/** A failure point cut to what an operator's header can hold. */
function forDisplay(point: string): string {
  return point.slice(0, FAILURE_POINT_CHARS);
}

/** What a run-specific fragment collapses to: a bead id the row named, or a quantity it printed. */
const MASK = "#";

/**
 * The bead ids THIS run is known to name: the target it ran, the ticket it stopped inside, and the
 * blockers a blocked park spells out (jobs/errors.ts owns that clause and its parser). All three
 * arrive on the row or in the message the row already carries, so the module stays pure — nothing
 * here asks the board what a token is.
 */
function knownBeadIds(run: RunOutcome): string[] {
  const blockers = (run.error && poisonBlockerIds(run.error)) || [];
  return [run.epicBeadId, run.ticketBeadId, ...blockers].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
}

/**
 * Take the run's own ids out of its failure point.
 *
 * LONGEST FIRST, because a child id contains its parent's (`anton-287p.1` / `anton-287p`): masking
 * the parent first leaves `#.1` behind, and that leftover is exactly the difference that makes two
 * runs of one break look like two breaks.
 */
function maskBeadIds(point: string, ids: readonly string[]): string {
  return [...new Set(ids)]
    .sort((a, b) => b.length - a.length)
    .reduce((text, id) => text.replaceAll(id, MASK), point);
}

/** A number, whole or fractional — the varying half of every quantity below. */
const AMOUNT = String.raw`\d+(?:\.\d+)?`;

/**
 * Time units as an error prints them, LONGEST FIRST inside each family: alternation is
 * leftmost-first, so `m` ahead of `minutes` would match the "m" of "minutes" and leave "inutes"
 * standing.
 */
const TIME_UNIT = "milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d";

/**
 * The run-varying QUANTITIES no row can name — and the only thing this module still masks by shape.
 *
 * Each pattern matches a whole quantity: a number bound to its unit, or the number in a host's port
 * position. Never "a token that carries a digit" (anton-4mql). That is the distinction the old rule
 * lacked, and the reason it was wrong: `45m` is a duration whichever run printed it, but
 * `anton-k4qr` is an identifier whatever digits its base36 alphabet happened to deal it — the digit
 * rule masked that id and kept `anton-gsny`, so three parks with one cause scored three signatures.
 * The boundary guards are what hold the line: a quantity stands on its own, an id's digits sit
 * inside a word, so `anton-12ms` is never read as 12 milliseconds. No token's SHAPE alone can decide
 * that it varies any more — a quantity is matched for what it is, and everything else is either
 * masked because the run row named it (see {@link knownBeadIds}) or left standing.
 *
 * What went with the digit rule, and why nothing replaced it. PATHS and PIDS are recognisable only
 * BY carrying a digit — `/tmp/anton-3` varies, `/tmp/anton-b` does not — which is the unsound rule
 * back again; and the run-specific part of a worktree path is the bead id in it, which the row
 * already names. A bead id the row CANNOT name — a third bead the message mentions in passing — is
 * now left standing, so a streak differing only there reports no common point. That is the honest
 * answer rather than a worse one: nothing here knows whether that token is what varies or what
 * broke, and a wrong common point sends an operator to diagnose a break that isn't stopping them.
 *
 * Applied to an already-lowercased point, which is why no pattern carries `i`.
 */
const QUANTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  // 45m · 1500ms · 2.5 seconds · 1h30m. The compound tail is not decoration: without it `1h30m`
  // fails the trailing guard and no part of it masks at all.
  [
    new RegExp(
      `(^|[^\\w.-])${AMOUNT}\\s*(?:${TIME_UNIT})(?:\\s*${AMOUNT}\\s*(?:${TIME_UNIT}))*(?![\\w-])`,
      "g",
    ),
    `$1${MASK}`,
  ],
  // localhost:3000 · 127.0.0.1:5432 · [::1]:8080 — the host is part of the failure, only its port
  // varies, so the character before the colon is kept.
  [/([\w.\]]):\d{1,5}(?![\w-])/g, `$1:${MASK}`],
  // port 3000 · port=3000
  [/\b(port[\s=]+)\d{1,5}(?![\w-])/g, `$1${MASK}`],
];

/** Collapse every {@link QUANTITIES} match, leaving the sentence around them intact. */
function maskQuantities(point: string): string {
  return QUANTITIES.reduce((text, [pattern, mask]) => text.replace(pattern, mask), point);
}

/**
 * Two failures are the same point once the run-specific parts are taken out: "ticket anton-a1b2
 * timed out after 45m" and "ticket anton-c3d4 timed out after 45m" are one broken environment
 * described twice, not two hard tickets.
 *
 * Two rules do that, and neither guesses from characters what kind of thing a token is. The BEAD IDS
 * come off first, from what the run row already knows they are (anton-q2jw). Then the QUANTITIES
 * above — the durations and ports no row can name — each matched as a complete quantity rather than
 * as a token carrying a digit (anton-4mql); the argument for keeping exactly those two, and for
 * dropping the rest of the old heuristic, is with them.
 */
function signatureOf(run: RunOutcome, point: string): string {
  const ids = knownBeadIds(run).map((id) => id.toLowerCase());
  return maskQuantities(maskBeadIds(point.toLowerCase(), ids))
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
  const signatures = runs.map((run, i) => signatureOf(run, points[i]!));
  const signature = signatures[0]!;
  if (!signature) return undefined;
  return signatures.every((s) => s === signature) ? forDisplay(points[0]!) : undefined;
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
    const point = forDisplay(failurePoint(run));
    return [run.id.slice(0, 8), run.epicBeadId, how, point].filter(Boolean).join(" · ");
  });
}
