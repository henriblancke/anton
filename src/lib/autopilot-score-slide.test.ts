/**
 * The score-regression breaker's arithmetic (anton-cekf / R4.3).
 *
 * The streak rule itself is review-alarm.test.ts's — what is pinned HERE is the one thing this level
 * adds: a series that is short, or holds a run that left no score, yields no verdict at all. That
 * asymmetry is the feature. Inside a gate an unscored round is read through; out here it voids the
 * window, because nothing downstream would catch a project frozen on evidence nobody recorded.
 */
import { describe, expect, it } from "vitest";
import {
  describeScoreSlide,
  detectScoreSlide,
  scoreSlideEvidence,
  type ScoredRun,
} from "./autopilot-score-slide";

const FLOOR = { floor: 7, window: 3 };

/** A series NEWEST first, as the breaker reads it; `null` is a run that left no score. */
function series(...scores: (number | null)[]): ScoredRun[] {
  return scores.map((score, i) => ({
    id: `run-${i}-abcdefgh`,
    targetBeadId: `anton-t${i}`,
    ...(score === null ? {} : { score }),
  }));
}

describe("detectScoreSlide", () => {
  it("does not disarm on a clean series", () => {
    expect(detectScoreSlide(series(9, 8, 9, 8), FLOOR)).toBeUndefined();
  });

  it("disarms when the whole window is under the floor", () => {
    const slide = detectScoreSlide(series(4, 5, 6, 9), FLOOR);
    expect(slide?.regression).toEqual({ streak: [6, 5, 4], minScore: 7 });
    // Oldest first — the order the slide reads in, not the order the runs were read in.
    expect(slide?.runs.map((r) => r.score)).toEqual([6, 5, 4]);
  });

  it("treats the floor as exclusive, so acceptable work never counts", () => {
    // 7 is "acceptable work a reviewer would still ask to improve" on the anchored scale.
    expect(detectScoreSlide(series(7, 7, 7), FLOOR)).toBeUndefined();
    expect(detectScoreSlide(series(6, 7, 6), FLOOR)).toBeUndefined();
  });

  it("does not disarm on a series with a gap in the window", () => {
    // The two 4s bracket a run that was never scored. `detectScoreRegression` would read through it;
    // the window must not, or a failed run would silently splice two unrelated lows together.
    expect(detectScoreSlide(series(4, null, 4), FLOOR)).toBeUndefined();
    expect(detectScoreSlide(series(null, 4, 4), FLOOR)).toBeUndefined();
    expect(detectScoreSlide(series(4, 4, null), FLOOR)).toBeUndefined();
  });

  it("does not disarm on a partial series", () => {
    expect(detectScoreSlide(series(4, 4), FLOOR)).toBeUndefined();
    expect(detectScoreSlide([], FLOOR)).toBeUndefined();
  });

  it("ignores everything older than the window", () => {
    // A gap or a recovery behind the window is history: the window it judged is intact.
    expect(detectScoreSlide(series(4, 5, 6, null, 9), FLOOR)?.runs).toHaveLength(3);
  });

  it("is off when the operator zeroes the floor, or the window is meaningless", () => {
    expect(detectScoreSlide(series(0, 0, 0), { floor: 0, window: 3 })).toBeUndefined();
    expect(detectScoreSlide(series(0, 0, 0), { floor: 7, window: 0 })).toBeUndefined();
    expect(detectScoreSlide(series(0, 0, 0), undefined)).toBeUndefined();
  });

  it("honours a window of one", () => {
    expect(detectScoreSlide(series(4, 9, 9), { floor: 7, window: 1 })?.runs).toHaveLength(1);
  });
});

describe("the operator's case", () => {
  it("names the streak, the floor and the scores", () => {
    const slide = detectScoreSlide(series(4, 5, 6), FLOOR)!;
    expect(describeScoreSlide(slide)).toBe("3 consecutive runs scored below 7/10 (6, 5, 4)");
  });

  it("reads as one run for a window of one", () => {
    const slide = detectScoreSlide(series(4), { floor: 7, window: 1 })!;
    expect(describeScoreSlide(slide)).toBe("1 consecutive run scored below 7/10 (4)");
  });

  it("carries the series that triggered it — one line per run, oldest first", () => {
    const slide = detectScoreSlide(series(4, 5, 6), FLOOR)!;
    expect(scoreSlideEvidence(slide)).toEqual([
      "run-2-ab · anton-t2 · 6/10",
      "run-1-ab · anton-t1 · 5/10",
      "run-0-ab · anton-t0 · 4/10",
    ]);
  });
});
