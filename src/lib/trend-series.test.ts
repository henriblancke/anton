import { describe, expect, it } from "vitest";

import {
  isoWeekKey,
  qualityWeekPoints,
  scoreDistributionByWeek,
  threadsByWeek,
  weekKeysBack,
  windowStartMs,
  zeroTouchByWeek,
  type DeliveredFeaturePoint,
  type ReviewRoundPoint,
  type ScoredRunPoint,
} from "./trend-series";

const DAY = 86_400_000;
// Monday 2026-09-28, a clean mid-week anchor with no boundary weirdness.
const WEEK_1_MONDAY = Date.UTC(2026, 8, 28);
const WEEK_1 = isoWeekKey(WEEK_1_MONDAY);
const WEEK_2 = isoWeekKey(WEEK_1_MONDAY + 7 * DAY);
const WEEK_3 = isoWeekKey(WEEK_1_MONDAY + 14 * DAY);

describe("isoWeekKey", () => {
  it("names a week by its own year even when the week starts in the prior calendar year", () => {
    // 2025-12-29 is a Monday, and ISO 8601 places it in 2026's first week (its Thursday, 2026-01-01,
    // decides the year) — the exact case `trendSeries` must bucket correctly across the boundary.
    expect(isoWeekKey(Date.UTC(2025, 11, 29))).toBe("2026-W01");
  });

  it("names the last days of December as the prior year's final week when its Thursday falls there", () => {
    // 2026-12-28 is a Monday whose Thursday (2026-12-31) is still in 2026, so this week is 2026's,
    // not 2027's, even though it runs into the next calendar year.
    expect(isoWeekKey(Date.UTC(2026, 11, 28))).toBe("2026-W53");
  });

  it("is stable across every day of the same ISO week", () => {
    for (let i = 0; i < 7; i++) {
      expect(isoWeekKey(WEEK_1_MONDAY + i * DAY + 3 * 60 * 60 * 1000)).toBe(WEEK_1);
    }
  });
});

describe("weekKeysBack / windowStartMs", () => {
  it("returns the last N ISO weeks, oldest first, ending at the week containing nowMs", () => {
    const nowMs = WEEK_1_MONDAY + 14 * DAY + 2 * DAY; // Wednesday of WEEK_3
    expect(weekKeysBack(3, nowMs)).toEqual([WEEK_1, WEEK_2, WEEK_3]);
  });

  it("spans a year boundary without a gap or a duplicate", () => {
    const nowMs = Date.UTC(2026, 0, 5); // first week of January 2026
    const keys = weekKeysBack(4, nowMs);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
    expect(keys[keys.length - 1]).toBe(isoWeekKey(nowMs));
  });

  it("windowStartMs names the Monday that starts the oldest included week", () => {
    const nowMs = WEEK_1_MONDAY + 14 * DAY + 2 * DAY;
    expect(windowStartMs(3, nowMs)).toBe(WEEK_1_MONDAY);
  });
});

describe("scoreDistributionByWeek", () => {
  const run = (atMs: number, score: number): ScoredRunPoint => ({ atMs, score });

  it("reports shares per band, never an average", () => {
    const runs = [
      run(WEEK_1_MONDAY, 10),
      run(WEEK_1_MONDAY + DAY, 10),
      run(WEEK_1_MONDAY + 2 * DAY, 9),
      run(WEEK_1_MONDAY + 3 * DAY, 8),
      run(WEEK_1_MONDAY + 4 * DAY, 4), // a real low score, not averaged away
    ];
    const byWeek = scoreDistributionByWeek(runs, [WEEK_1]);
    const week1 = byWeek.get(WEEK_1);
    expect(week1?.n).toBe(5);
    expect(week1?.shares["10"]).toBeCloseTo(0.4);
    expect(week1?.shares["9"]).toBeCloseTo(0.2);
    expect(week1?.shares["8"]).toBeCloseTo(0.2);
    expect(week1?.shares["7-and-below"]).toBeCloseTo(0.2);
    // Shares sum to 1 — the distribution is a full partition, not a filtered subset.
    const total = Object.values(week1?.shares ?? {}).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1);
    // Nothing on this type can even express a mean — only band shares exist.
    expect(week1).not.toHaveProperty("mean");
    expect(week1).not.toHaveProperty("average");
  });

  it("is absent for a week with no scored run, not a zero-filled distribution", () => {
    const byWeek = scoreDistributionByWeek([run(WEEK_1_MONDAY, 10)], [WEEK_1, WEEK_2]);
    expect(byWeek.has(WEEK_1)).toBe(true);
    expect(byWeek.has(WEEK_2)).toBe(false);
  });

  it("ignores a run outside the requested weeks", () => {
    const byWeek = scoreDistributionByWeek([run(WEEK_1_MONDAY - 30 * DAY, 10)], [WEEK_1]);
    expect(byWeek.has(WEEK_1)).toBe(false);
  });
});

describe("threadsByWeek", () => {
  const round = (atMs: number, threadsActionable: number, byAuthor: Record<string, number>): ReviewRoundPoint => ({
    atMs,
    threadsActionable,
    byAuthor,
  });

  it("totals threads and splits them per reviewer, from the review-round record", () => {
    const rounds = [
      round(WEEK_1_MONDAY, 3, { alice: 2, bob: 1 }),
      round(WEEK_1_MONDAY + DAY, 1, { alice: 1 }),
    ];
    const byWeek = threadsByWeek(rounds, [WEEK_1], WEEK_1_MONDAY);
    expect(byWeek.get(WEEK_1)).toEqual({ total: 4, byReviewer: { alice: 3, bob: 1 } });
  });

  it("reports a real zero for a week after recording started that simply saw no rounds", () => {
    const byWeek = threadsByWeek([], [WEEK_1, WEEK_2], WEEK_1_MONDAY);
    expect(byWeek.get(WEEK_2)).toEqual({ total: 0, byReviewer: {} });
  });

  it("reports a week predating the review-round record as absent, not zero", () => {
    // Recording only started in WEEK_2; WEEK_1 predates the table entirely.
    const byWeek = threadsByWeek([], [WEEK_1, WEEK_2], WEEK_1_MONDAY + 7 * DAY);
    expect(byWeek.has(WEEK_1)).toBe(false);
    expect(byWeek.has(WEEK_2)).toBe(true);
    expect(byWeek.get(WEEK_2)).toEqual({ total: 0, byReviewer: {} });
  });

  it("reports every requested week as absent when the project has no review-round record at all", () => {
    const byWeek = threadsByWeek([], [WEEK_1, WEEK_2, WEEK_3], undefined);
    expect(byWeek.size).toBe(0);
  });
});

describe("zeroTouchByWeek", () => {
  const feature = (deliveredAtMs: number, humanTouches?: number): DeliveredFeaturePoint => ({
    deliveredAtMs,
    humanTouches,
  });

  it("is the share of delivered features with zero human touches, over a mixed fixture", () => {
    const features = [
      feature(WEEK_1_MONDAY, 0),
      feature(WEEK_1_MONDAY + DAY, 0),
      feature(WEEK_1_MONDAY + 2 * DAY, 3),
      feature(WEEK_1_MONDAY + 3 * DAY), // absent humanTouches reads as 0
    ];
    const byWeek = zeroTouchByWeek(features, [WEEK_1]);
    expect(byWeek.get(WEEK_1)).toEqual({ delivered: 4, zeroTouch: 3, share: 0.75 });
  });

  it("is absent for a week with no delivery, not a share of zero", () => {
    const byWeek = zeroTouchByWeek([feature(WEEK_1_MONDAY, 0)], [WEEK_1, WEEK_2]);
    expect(byWeek.has(WEEK_1)).toBe(true);
    expect(byWeek.has(WEEK_2)).toBe(false);
  });
});

describe("qualityWeekPoints", () => {
  it("composes one point per week, each metric independently present or absent", () => {
    const nowMs = WEEK_1_MONDAY + 7 * DAY + 2 * DAY; // mid WEEK_2
    const points = qualityWeekPoints(
      {
        scoredRuns: [{ atMs: WEEK_1_MONDAY, score: 10 }],
        reviewRounds: [{ atMs: WEEK_1_MONDAY + 7 * DAY, threadsActionable: 2, byAuthor: { alice: 2 } }],
        deliveredFeatures: [{ deliveredAtMs: WEEK_1_MONDAY, humanTouches: 0 }],
        recordingStartedAtMs: WEEK_1_MONDAY + 7 * DAY, // recording starts in WEEK_2
      },
      2,
      { nowMs },
    );

    expect(points).toHaveLength(2);
    const [week1, week2] = points;
    expect(week1.week).toBe(WEEK_1);
    expect(week1.scoreDistribution?.n).toBe(1);
    expect(week1.zeroTouch).toEqual({ delivered: 1, zeroTouch: 1, share: 1 });
    // WEEK_1 predates the review-round record — threads absent even though WEEK_1 has other data.
    expect(week1.threads).toBeUndefined();

    expect(week2.week).toBe(WEEK_2);
    expect(week2.scoreDistribution).toBeUndefined();
    expect(week2.zeroTouch).toBeUndefined();
    expect(week2.threads).toEqual({ total: 2, byReviewer: { alice: 2 } });
  });
});
