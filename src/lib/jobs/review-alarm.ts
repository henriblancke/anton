/**
 * The score-regression alarm (anton-i98r): when the reviewer keeps scoring a run low, the converge
 * loop stops and the founder decides, instead of anton grinding out fix rounds against a verdict
 * that isn't moving.
 *
 * A blocking finding says "this specific thing is wrong" and a fix round can answer it. A low SCORE
 * says the work as a whole isn't good enough, which no bounded fix loop can be trusted to repair —
 * so K consecutive rounds below the threshold park the run with the score series attached.
 *
 * Deliberately pure and structural: the alarm reads nothing but each round's score, so the converge
 * loop and the call-site evaluate the same function over the same rounds, and the streak rules are
 * testable without a repo, an agent, or a gate.
 */

/** The only thing the alarm reads from a review round — `ReviewRound` satisfies it structurally. */
export interface ScoredRound {
  round: number;
  /** Absent when that round's reviewer broke the report protocol (no usable score). */
  score?: number;
}

/** The operator's threshold: how low, for how many rounds in a row. */
export interface ScoreAlarm {
  /** A round scoring BELOW this counts toward the streak. 0 disables the alarm (no score is < 0). */
  minScore: number;
  /** K — how many consecutive low rounds trip it. */
  rounds: number;
}

/** A tripped alarm, carrying the evidence the park surfaces. */
export interface ScoreRegression {
  /** The consecutive low scores that tripped it, oldest first. */
  streak: number[];
  /** The threshold they fell below — the series is meaningless without it. */
  minScore: number;
}

/**
 * The run of consecutive low scores ending at the most recent SCORED round.
 *
 * A round at or above the threshold zeroes the streak: the alarm is for SUSTAINED lows, and a
 * reviewer that recovers has said the work moved, whatever it scored before. A round with no score
 * (a protocol violation) is neither — it never judged the work, so it can neither extend the streak
 * nor clear it; that round parks the run on its own violation anyway.
 */
export function lowScoreStreak(rounds: ScoredRound[], minScore: number): number[] {
  const streak: number[] = [];
  for (const r of rounds) {
    if (r.score === undefined) continue;
    if (r.score >= minScore) streak.length = 0;
    else streak.push(r.score);
  }
  return streak;
}

/** The alarm's verdict over the rounds so far — `undefined` while the streak is short of K. */
export function detectScoreRegression(
  rounds: ScoredRound[],
  alarm: ScoreAlarm | undefined,
): ScoreRegression | undefined {
  if (!alarm || alarm.minScore <= 0 || alarm.rounds < 1) return undefined;
  const streak = lowScoreStreak(rounds, alarm.minScore);
  return streak.length >= alarm.rounds ? { streak, minScore: alarm.minScore } : undefined;
}

/**
 * The score series as a founder reads it — every round, in order, including the ones that recovered
 * or never reported. The whole series, not just the streak: "7, 3, 3" and "3, 3" are the same alarm
 * but a different story, and the park view is where that difference has to be visible.
 */
export function formatScoreSeries(rounds: ScoredRound[]): string {
  if (rounds.length === 0) return "no rounds";
  return rounds
    .map((r) => `round ${r.round}: ${r.score === undefined ? "no score" : `${r.score}/10`}`)
    .join(" · ");
}

/** Why the alarm fired, in one clause — shared by the park note and the run row's error. */
export function describeScoreRegression(regression: ScoreRegression): string {
  return (
    `${regression.streak.length} consecutive review round(s) scored below ` +
    `${regression.minScore}/10 (${regression.streak.join(", ")})`
  );
}
