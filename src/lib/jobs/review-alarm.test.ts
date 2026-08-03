/**
 * Unit tests for the score-regression alarm's streak logic (anton-i98r) — the rules that decide
 * when sustained low scores stop being a fix loop's problem and become the founder's decision.
 *
 * Pure, so every case is a list of scores: no repo, no agent, no gate. The loop wiring is proved in
 * review-gate.test.ts and the park in the execute-epic review-gate integration suite.
 */
import { describe, expect, it } from "vitest";

import {
  describeScoreRegression,
  detectScoreRegression,
  formatScoreSeries,
  lowScoreStreak,
  type ScoredRound,
} from "./review-alarm";

/** Rounds shaped as the gate accumulates them; `null` is a round whose reviewer never scored. */
function rounds(...scores: (number | null)[]): ScoredRound[] {
  return scores.map((score, i) => ({
    round: i + 1,
    ...(score === null ? {} : { score }),
  }));
}

const ALARM = { minScore: 5, rounds: 2 };

describe("lowScoreStreak", () => {
  it("counts only the CONSECUTIVE lows ending at the last scored round", () => {
    expect(lowScoreStreak(rounds(3, 3), 5)).toEqual([3, 3]);
    expect(lowScoreStreak(rounds(7, 4, 3), 5)).toEqual([4, 3]);
  });

  it("resets on recovery — a round at or above the threshold zeroes the streak", () => {
    expect(lowScoreStreak(rounds(3, 3, 8), 5)).toEqual([]);
    expect(lowScoreStreak(rounds(3, 3, 8, 4), 5)).toEqual([4]);
  });

  it("treats the threshold itself as recovery, not as a low", () => {
    expect(lowScoreStreak(rounds(5, 5), 5)).toEqual([]);
    expect(lowScoreStreak(rounds(4, 5), 5)).toEqual([]);
  });

  it("leaves a round that never scored out of it entirely — it neither extends nor clears", () => {
    expect(lowScoreStreak(rounds(3, null, 3), 5)).toEqual([3, 3]);
    expect(lowScoreStreak(rounds(null, null), 5)).toEqual([]);
  });
});

describe("detectScoreRegression", () => {
  it("fires once K consecutive lows have landed, carrying them as evidence", () => {
    expect(detectScoreRegression(rounds(3), ALARM)).toBeUndefined();
    expect(detectScoreRegression(rounds(3, 3), ALARM)).toEqual({ streak: [3, 3], minScore: 5 });
  });

  it("never fires on rounds at or above the threshold, however many there are", () => {
    expect(detectScoreRegression(rounds(6, 7, 5, 8), ALARM)).toBeUndefined();
  });

  it("does not fire on a recovered streak, and re-arms after it", () => {
    expect(detectScoreRegression(rounds(3, 8, 3), ALARM)).toBeUndefined();
    expect(detectScoreRegression(rounds(3, 8, 3, 2), ALARM)).toEqual({ streak: [3, 2], minScore: 5 });
  });

  it("is off when no alarm is configured, or when the threshold is 0 (the off switch)", () => {
    expect(detectScoreRegression(rounds(0, 0, 0), undefined)).toBeUndefined();
    expect(detectScoreRegression(rounds(0, 0, 0), { minScore: 0, rounds: 2 })).toBeUndefined();
  });

  it("honors K=1 — a single low round is a park when the operator asked for that", () => {
    expect(detectScoreRegression(rounds(4), { minScore: 5, rounds: 1 })).toEqual({
      streak: [4],
      minScore: 5,
    });
  });
});

describe("evidence formatting", () => {
  it("renders the WHOLE series, including the rounds that recovered or never scored", () => {
    expect(formatScoreSeries(rounds(7, null, 3, 3))).toBe(
      "round 1: 7/10 · round 2: no score · round 3: 3/10 · round 4: 3/10",
    );
  });

  it("names the streak and the threshold it fell below", () => {
    expect(describeScoreRegression({ streak: [3, 3], minScore: 5 })).toBe(
      "2 consecutive review round(s) scored below 5/10 (3, 3)",
    );
  });
});
