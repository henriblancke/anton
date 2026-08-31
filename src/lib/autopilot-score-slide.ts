/**
 * The score-regression breaker's arithmetic (anton-cekf / R4.3).
 *
 * The review gate already watches scores WITHIN one run — K low rounds in a row park that run
 * (jobs/review-alarm.ts). This is the same question asked one level up: not "is this run converging"
 * but "is the work anton ships getting worse", over the score each finished run left on its target.
 * A project whose last three deliveries scored below the floor is not having a bad run; it is
 * producing worse work than it used to, and no fix round inside a single run can answer that.
 *
 * Detection is NOT redefined here — the streak rule (a recovery resets, the floor is exclusive) is
 * `detectScoreRegression`'s, called over the run series. What this module owns is the one rule the
 * round-level alarm has no reason to have: **a gap does not disarm**. Inside a gate, a round with no
 * score is skipped and the streak reads through it, because that round parks the run on its own
 * protocol violation anyway. Out here nothing catches it, so a series that is short of the window,
 * or has a settled run in it that left no score, yields NO verdict at all. Absence of evidence is
 * not evidence: the cost of failing open is one more run at the current quality, and the cost of
 * failing closed is a project frozen on scores nobody actually recorded.
 *
 * Pure and structural, like the two breakers it sits beside. The caller reads the runs and joins
 * each one's score off the board, so the rules stay testable without a db, a repo or a bd call.
 */
import { describeScoreRegression, detectScoreRegression, type ScoreRegression } from "./jobs/review-alarm";

/** One finished run's contribution to the project's score series. */
export interface ScoredRun {
  id: string;
  /** The run target the score is ON — what the `review-score:<n>` label was written to. */
  targetBeadId: string;
  /**
   * That target's latest review score. ABSENT is a gap, never a zero: a run that failed before the
   * review gate, or whose score write did not land, said nothing about quality.
   */
  score?: number;
}

/** The operator's floor: how low, over how many finished runs. */
export interface ScoreBreakerConfig {
  /** A run scoring BELOW this counts. 0 disables the breaker outright — no score is below zero. */
  floor: number;
  /** The window — how many consecutive scored runs must be under the floor to trip it. */
  window: number;
}

/** A tripped breaker, carrying the series the operator re-arms (or doesn't) on. */
export interface ScoreSlide {
  /** The window that tripped it, OLDEST first — the order the story reads in. */
  runs: ScoredRun[];
  /** The verdict `review-alarm.ts` returned over those runs' scores. */
  regression: ScoreRegression;
}

/**
 * The breaker's verdict over the project's recent runs, newest first — `undefined` unless the whole
 * window is present, scored, and under the floor.
 *
 * The window is taken before the streak is counted rather than after, which is what makes the gap
 * rule bite: `detectScoreRegression` reads THROUGH an unscored round, so handing it the raw series
 * would let two lows either side of a run that was never reviewed read as a streak of two.
 */
export function detectScoreSlide(
  runs: readonly ScoredRun[],
  config: ScoreBreakerConfig | undefined,
): ScoreSlide | undefined {
  if (!config || config.floor <= 0 || config.window < 1) return undefined;
  const window = runs.slice(0, config.window);
  // Short of the window, or holding a run that left no score: a partial series is not a verdict.
  if (window.length < config.window || window.some((r) => r.score === undefined)) return undefined;

  const series = [...window].reverse();
  const regression = detectScoreRegression(
    series.map((run, i) => ({ round: i + 1, score: run.score })),
    { minScore: config.floor, rounds: config.window },
  );
  return regression ? { runs: series, regression } : undefined;
}

/** Why the breaker fired, in one sentence — the disarm's `detail`. */
export function describeScoreSlide(slide: ScoreSlide): string {
  return describeScoreRegression(slide.regression, slide.runs.length === 1 ? "run" : "runs");
}

/**
 * One line per run, oldest first — which run, on what work, at what score. The operator's whole case
 * for re-arming or not, which is why it names the runs individually rather than printing the streak:
 * a slide across three different features and three attempts at one are the same numbers and
 * completely different problems.
 */
export function scoreSlideEvidence(slide: ScoreSlide): string[] {
  return slide.runs.map((run) =>
    [run.id.slice(0, 8), run.targetBeadId, `${run.score}/10`].join(" · "),
  );
}
