/**
 * `trendQuality` (anton-6b835) — the wiring that turns real `runs`, `review_rounds` and board rows
 * into the `QualityInput` `trend-series.ts`'s pure fold reads. The fold has its own exhaustive
 * tests; this file proves the wiring: the right columns feed the right field, and "no project"
 * stays distinguishable from "a project with nothing recorded yet".
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beads, type Bead } from "./beads/bd";
import * as schema from "./db/schema";
import { resetIssueSnapshots } from "./beads/snapshot";
import { makeProjectDb, type TestProjectDb } from "./testing/project";
import { trendQuality, trendSeries } from "./trend-read";
import { isoWeekKey } from "./trend-series";

const DAY = 86_400_000;
const WEEK_MONDAY = Date.UTC(2026, 8, 28); // 2026-09-28, a clean mid-week anchor
const WEEK_KEY = isoWeekKey(WEEK_MONDAY);
const NOW_MS = WEEK_MONDAY + 3 * DAY;

const bead = (over: Partial<Bead> & { id: string }): Bead =>
  ({ title: over.id, status: "open", issue_type: "task", labels: [], ...over }) as Bead;

function fakeBoard(board: Bead[]) {
  return vi.spyOn(beads, "list").mockImplementation(async () => [...board]);
}

function fakeThread() {
  return vi
    .spyOn(beads, "showWithComments")
    .mockImplementation(async (_cwd, id) => ({ ...bead({ id }), comments: [] }));
}

let t: TestProjectDb;

beforeEach(() => {
  resetIssueSnapshots();
  t = makeProjectDb({ repoPath: "/repo" });
  fakeThread();
});
afterEach(() => vi.restoreAllMocks());

describe("trendQuality", () => {
  it("is undefined for a project id this anton.db does not carry", async () => {
    fakeBoard([]);
    expect(await trendQuality(t.db, "no-such-project", 1, { nowMs: NOW_MS })).toBeUndefined();
  });

  it("buckets a scored run's week off runs.review_score", async () => {
    fakeBoard([]);
    await t.db.insert(schema.runs).values({
      id: "run-1",
      projectId: t.projectId,
      epicBeadId: "feat-1",
      branch: "anton/feat-1",
      status: "done",
      reviewScore: 9,
      startedAt: new Date(WEEK_MONDAY),
      endedAt: new Date(WEEK_MONDAY),
      updatedAt: new Date(WEEK_MONDAY),
    });

    const points = await trendQuality(t.db, t.projectId, 1, { nowMs: NOW_MS });
    const week = points?.find((p) => p.week === WEEK_KEY);
    expect(week?.scoreDistribution).toEqual({ n: 1, shares: { "10": 0, "9": 1, "8": 0, "7-and-below": 0 } });
  });

  it("totals threads per reviewer from the review-round record, and reports a prior week as absent", async () => {
    fakeBoard([]);
    await t.db.insert(schema.reviewRounds).values({
      id: randomUUID(),
      projectId: t.projectId,
      prNumber: 42,
      round: 1,
      threadsActionable: 2,
      byAuthorJson: JSON.stringify({ alice: 2 }),
      recordedAt: new Date(WEEK_MONDAY),
    });

    const points = await trendQuality(t.db, t.projectId, 2, { nowMs: NOW_MS + 7 * DAY });
    const recordedWeek = points?.find((p) => p.week === WEEK_KEY);
    const priorWeek = points?.find((p) => p.week === isoWeekKey(WEEK_MONDAY - 7 * DAY));

    expect(recordedWeek?.threads).toEqual({ total: 2, byReviewer: { alice: 2 }, byPr: { 42: 2 } });
    expect(priorWeek?.threads).toBeUndefined();
  });

  it("buckets a delivered feature's zero-touch share off cohortFeatures", async () => {
    fakeBoard([bead({ id: "feat-1", issue_type: "feature" })]);
    await t.db.insert(schema.claudeInvocations).values({
      id: "inv-1",
      projectId: t.projectId,
      jobType: "execute-epic",
      step: "implement",
      stepHandler: "implement",
      runId: "r1",
      beadId: "feat-1",
      modelRequested: "claude-opus-5",
      modelReported: "claude-opus-5",
      inputTokens: 100,
      outputTokens: 100,
      outcome: "ok",
      recordedAt: new Date(WEEK_MONDAY),
      durationMs: 60_000,
    });
    await t.db.insert(schema.runs).values({
      id: "run-feat-1",
      projectId: t.projectId,
      epicBeadId: "feat-1",
      branch: "anton/feat-1",
      status: "done",
      startedAt: new Date(WEEK_MONDAY),
      endedAt: new Date(WEEK_MONDAY),
      updatedAt: new Date(WEEK_MONDAY),
    });

    const points = await trendQuality(t.db, t.projectId, 1, { nowMs: NOW_MS });
    const week = points?.find((p) => p.week === WEEK_KEY);
    expect(week?.zeroTouch).toEqual({ delivered: 1, zeroTouch: 1, share: 1 });
  });
});

/**
 * `trendSeries` (anton-p38kx) — the single entry point that merges quality, cost, phase spend,
 * change markers and run causes into one week-keyed series. `trendQuality`'s wiring tests above
 * already cover the quality slice in full; these prove the slices `trendQuality` does not read:
 * cost/phase-spend off `claude_invocations` + `cohortFeatures`, failure causes off `runsByCause`,
 * and change markers/review-loop off the same `claude_invocations` stamps.
 */
describe("trendSeries", () => {
  it("is undefined for a project id this anton.db does not carry", async () => {
    fakeBoard([]);
    expect(await trendSeries(t.db, "no-such-project", 1, { nowMs: NOW_MS })).toBeUndefined();
  });

  it("buckets phase spend and cost off claude_invocations and cohortFeatures, in the same week", async () => {
    fakeBoard([bead({ id: "feat-1", issue_type: "feature" })]);
    await t.db.insert(schema.claudeInvocations).values({
      id: "inv-1",
      projectId: t.projectId,
      jobType: "execute-epic",
      step: "implement",
      stepHandler: "implement",
      runId: "r1",
      beadId: "feat-1",
      modelRequested: "claude-opus-5",
      modelReported: "claude-opus-5",
      // A known billing route — a `null` endpointHost means "default transport, unknown billing
      // mode" (model-pricing.ts's own rule) and would leave this row unpriced.
      endpointHost: "api.anthropic.com",
      inputTokens: 100,
      outputTokens: 100,
      outcome: "ok",
      recordedAt: new Date(WEEK_MONDAY),
      durationMs: 60_000,
    });
    await t.db.insert(schema.runs).values({
      id: "run-feat-1",
      projectId: t.projectId,
      epicBeadId: "feat-1",
      branch: "anton/feat-1",
      status: "done",
      startedAt: new Date(WEEK_MONDAY),
      endedAt: new Date(WEEK_MONDAY),
      updatedAt: new Date(WEEK_MONDAY),
    });

    const series = await trendSeries(t.db, t.projectId, 1, { nowMs: NOW_MS });
    const week = series?.weeks.find((p) => p.week === WEEK_KEY);
    // claude-opus-5 normalizes to a known price: (100 * $5 + 100 * $25) / 1e6 = 0.003.
    expect(week?.phaseSpend).toEqual({
      implement: { invocations: 1, tokens: 200, usd: 0.003, unpricedRows: 0 },
    });
    expect(week?.cost).toEqual({ delivered: 1, usd: 0.003, usdPerFeature: 0.003 });
    // One delivered feature is well under MIN_COHORT — the clearest underpowered case there is.
    expect(week?.underpowered).toBe(true);
  });

  it("buckets a parked run's cause off runsByCause", async () => {
    fakeBoard([]);
    await t.db.insert(schema.runs).values({
      id: "run-parked",
      projectId: t.projectId,
      epicBeadId: "feat-1",
      branch: "anton/feat-1",
      status: "parked",
      error: "usage-limit",
      startedAt: new Date(WEEK_MONDAY),
      endedAt: new Date(WEEK_MONDAY),
      updatedAt: new Date(WEEK_MONDAY),
    });

    const series = await trendSeries(t.db, t.projectId, 1, { nowMs: NOW_MS });
    const week = series?.weeks.find((p) => p.week === WEEK_KEY);
    expect(week?.runCauses).toEqual({ total: 1, byCause: { quota: 1 } });
  });

  it("surfaces a model change marker, and counts self-review invocations into the review loop, off the same claude_invocations stamps", async () => {
    fakeBoard([]);
    const weekTwoKey = isoWeekKey(WEEK_MONDAY + 7 * DAY);
    await t.db.insert(schema.claudeInvocations).values([
      {
        id: "inv-week1",
        projectId: t.projectId,
        jobType: "execute-epic",
        step: "implement",
        stepHandler: "review",
        runId: "r1",
        beadId: "feat-1",
        modelRequested: "sonnet-4-5",
        modelReported: "sonnet-4-5",
        outcome: "ok",
        recordedAt: new Date(WEEK_MONDAY),
      },
      {
        id: "inv-week2",
        projectId: t.projectId,
        jobType: "execute-epic",
        step: "implement",
        stepHandler: "review",
        runId: "r2",
        beadId: "feat-1",
        modelRequested: "sonnet-5",
        modelReported: "sonnet-5",
        outcome: "ok",
        recordedAt: new Date(WEEK_MONDAY + 7 * DAY),
      },
    ]);

    const series = await trendSeries(t.db, t.projectId, 2, { nowMs: NOW_MS + 7 * DAY });
    expect(series?.changeMarkers).toEqual([
      { kind: "model", week: weekTwoKey, before: "sonnet-4-5", after: "sonnet-5" },
    ]);
    expect(series?.reviewLoop.find((p) => p.beadId === "feat-1")).toEqual({
      beadId: "feat-1",
      selfReviewInvocations: 2,
      prFixInvocations: 0,
      loopInvocations: 2,
      runaway: false,
    });
  });
});
