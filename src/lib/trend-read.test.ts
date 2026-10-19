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

    expect(recordedWeek?.threads).toEqual({
      total: 2,
      byReviewer: { alice: 2 },
      byPr: { 42: 2 },
      complete: true,
    });
    expect(priorWeek?.threads).toBeUndefined();
  });

  it("marks a week's threads incomplete when a round's GitHub thread read degraded", async () => {
    fakeBoard([]);
    await t.db.insert(schema.reviewRounds).values({
      id: randomUUID(),
      projectId: t.projectId,
      prNumber: 42,
      round: 1,
      threadsActionable: 2,
      byAuthorJson: JSON.stringify({ alice: 2 }),
      threadsComplete: false,
      recordedAt: new Date(WEEK_MONDAY),
    });

    const points = await trendQuality(t.db, t.projectId, 1, { nowMs: NOW_MS });
    const week = points?.find((p) => p.week === WEEK_KEY);
    expect(week?.threads?.complete).toBe(false);
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
    expect(week?.cost).toEqual({ delivered: 1, usd: 0.003, usdPerFeature: 0.003, unpricedRows: 0 });
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
    // feat-1 must be on the board for cohortFeatures to admit it as a candidate — reviewLoop is now
    // restricted to the selected cohort (P1, PR #348 review), so an id the board does not recognize
    // would never reach it.
    fakeBoard([bead({ id: "feat-1", issue_type: "feature" })]);
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

  it("keeps a feature with only implement invocations in the review-loop cohort, as a genuine zero", async () => {
    // feat-1 never entered self-review or PR-fix at all — its only invocation is an `implement`
    // row. Dropping it from the fold entirely (rather than giving it a zero-count bucket) would
    // exclude a legitimate zero-PR-fix observation from the cohort's median (P2, PR #348 review).
    // feat-1 must be on the board for cohortFeatures to admit it into the cohort in the first place.
    fakeBoard([bead({ id: "feat-1", issue_type: "feature" })]);
    await t.db.insert(schema.claudeInvocations).values({
      id: "inv-implement-only",
      projectId: t.projectId,
      jobType: "execute-epic",
      step: "implement",
      stepHandler: "implement",
      runId: "r1",
      beadId: "feat-1",
      modelRequested: "sonnet-5",
      modelReported: "sonnet-5",
      outcome: "ok",
      recordedAt: new Date(WEEK_MONDAY),
    });

    const series = await trendSeries(t.db, t.projectId, 1, { nowMs: NOW_MS });
    expect(series?.reviewLoop.find((p) => p.beadId === "feat-1")).toEqual({
      beadId: "feat-1",
      selfReviewInvocations: 0,
      prFixInvocations: 0,
      loopInvocations: 0,
      runaway: false,
    });
  });

  it("groups a sidecar row into its real invocation before counting change markers and the review loop", async () => {
    // feat-1 must be on the board for cohortFeatures to admit it as a candidate.
    fakeBoard([bead({ id: "feat-1", issue_type: "feature" })]);
    const weekTwoKey = isoWeekKey(WEEK_MONDAY + 7 * DAY);

    // Essentially every real invocation also writes a haiku sidecar row under the same
    // `invocationId` — one real self-review per (invocationId, week), never two. `modelRequested`
    // matches the primary row's reported model, never the sidecar's, so the switch below is a
    // genuine served-model change rather than a divergence off a stale request.
    const sidecarPair = (opts: {
      invocationId: string;
      runId: string;
      modelRequested: string;
      modelReported: string;
      recordedAt: Date;
    }) => [
      {
        id: `${opts.invocationId}-primary`,
        invocationId: opts.invocationId,
        projectId: t.projectId,
        jobType: "execute-epic",
        step: "implement",
        stepHandler: "review",
        runId: opts.runId,
        beadId: "feat-1",
        modelRequested: opts.modelRequested,
        modelReported: opts.modelReported,
        outcome: "ok",
        recordedAt: opts.recordedAt,
      },
      {
        id: `${opts.invocationId}-sidecar`,
        invocationId: opts.invocationId,
        projectId: t.projectId,
        jobType: "execute-epic",
        step: "implement",
        stepHandler: "review",
        runId: opts.runId,
        beadId: "feat-1",
        modelRequested: opts.modelRequested,
        modelReported: "claude-haiku-4-5",
        outcome: "ok",
        recordedAt: opts.recordedAt,
      },
    ];

    await t.db.insert(schema.claudeInvocations).values([
      ...sidecarPair({
        invocationId: "w1-a",
        runId: "r1",
        modelRequested: "claude-opus-5",
        modelReported: "claude-opus-5-20260101",
        recordedAt: new Date(WEEK_MONDAY),
      }),
      ...sidecarPair({
        invocationId: "w1-b",
        runId: "r2",
        modelRequested: "claude-opus-5",
        modelReported: "claude-opus-5-20260101",
        recordedAt: new Date(WEEK_MONDAY),
      }),
      ...sidecarPair({
        invocationId: "w2-a",
        runId: "r3",
        modelRequested: "claude-sonnet-5",
        modelReported: "claude-sonnet-5",
        recordedAt: new Date(WEEK_MONDAY + 7 * DAY),
      }),
      ...sidecarPair({
        invocationId: "w2-b",
        runId: "r4",
        modelRequested: "claude-sonnet-5",
        modelReported: "claude-sonnet-5",
        recordedAt: new Date(WEEK_MONDAY + 7 * DAY),
      }),
    ]);

    const series = await trendSeries(t.db, t.projectId, 2, { nowMs: NOW_MS + 7 * DAY });

    // A per-row fold would split each week 50/50 between the primary model and the haiku sidecar and
    // never clear the 50% majority `modelChangeMarkers` requires, so the marker below only appears
    // once rows are grouped into real invocations first.
    expect(series?.changeMarkers).toEqual([
      { kind: "model", week: weekTwoKey, before: "claude-opus-5-20260101", after: "claude-sonnet-5" },
    ]);
    // Four real invocations ran against feat-1 (two self-review per week) — eight rows, not eight
    // invocations.
    expect(series?.reviewLoop.find((p) => p.beadId === "feat-1")).toEqual({
      beadId: "feat-1",
      selfReviewInvocations: 4,
      prFixInvocations: 0,
      loopInvocations: 4,
      runaway: false,
    });
  });

  it("picks the primary row's substituted model, not the haiku sidecar's, when a gateway diverges outright", async () => {
    // feat-1 must be on the board for cohortFeatures to admit it as a candidate.
    fakeBoard([bead({ id: "feat-1", issue_type: "feature" })]);
    const weekTwoKey = isoWeekKey(WEEK_MONDAY + 7 * DAY);

    const sidecarPair = (opts: {
      invocationId: string;
      runId: string;
      modelRequested: string;
      modelReported: string;
      recordedAt: Date;
    }) => [
      {
        id: `${opts.invocationId}-primary`,
        invocationId: opts.invocationId,
        projectId: t.projectId,
        jobType: "execute-epic",
        step: "implement",
        stepHandler: "review",
        runId: opts.runId,
        beadId: "feat-1",
        modelRequested: opts.modelRequested,
        modelReported: opts.modelReported,
        outcome: "ok",
        recordedAt: opts.recordedAt,
      },
      {
        id: `${opts.invocationId}-sidecar`,
        invocationId: opts.invocationId,
        projectId: t.projectId,
        jobType: "execute-epic",
        step: "implement",
        stepHandler: "review",
        runId: opts.runId,
        beadId: "feat-1",
        modelRequested: opts.modelRequested,
        modelReported: "claude-haiku-4-5",
        outcome: "ok",
        recordedAt: opts.recordedAt,
      },
    ];

    await t.db.insert(schema.claudeInvocations).values([
      // Week 1: served as requested — a clean claude-opus-5 majority.
      ...sidecarPair({
        invocationId: "w1-a",
        runId: "r1",
        modelRequested: "claude-opus-5",
        modelReported: "claude-opus-5-20260101",
        recordedAt: new Date(WEEK_MONDAY),
      }),
      ...sidecarPair({
        invocationId: "w1-b",
        runId: "r2",
        modelRequested: "claude-opus-5",
        modelReported: "claude-opus-5-20260101",
        recordedAt: new Date(WEEK_MONDAY),
      }),
      // Week 2: the gateway silently substitutes the primary to claude-sonnet-5 — neither it nor the
      // haiku sidecar matches the claude-opus-5 request, so this is a full divergence. The change
      // marker must read the PRIMARY's substituted model, never the untouched sidecar's.
      ...sidecarPair({
        invocationId: "w2-a",
        runId: "r3",
        modelRequested: "claude-opus-5",
        modelReported: "claude-sonnet-5",
        recordedAt: new Date(WEEK_MONDAY + 7 * DAY),
      }),
      ...sidecarPair({
        invocationId: "w2-b",
        runId: "r4",
        modelRequested: "claude-opus-5",
        modelReported: "claude-sonnet-5",
        recordedAt: new Date(WEEK_MONDAY + 7 * DAY),
      }),
    ]);

    const series = await trendSeries(t.db, t.projectId, 2, { nowMs: NOW_MS + 7 * DAY });

    expect(series?.changeMarkers).toEqual([
      { kind: "model", week: weekTwoKey, before: "claude-opus-5-20260101", after: "claude-sonnet-5" },
    ]);
  });

  it("normalizes a ticket-phase invocation and a self-review invocation onto the same feature before counting the review loop", async () => {
    // A real epic/ticket pair: `task-1`'s nearest run target is `feat-1`. `execute-epic-ticket.ts`
    // stamps a ticket-phase invocation with the child ticket's own id, while `review-gate.ts` stamps
    // self-review with the run TARGET's id — without `currentRunTargetOf` normalizing both onto
    // `feat-1`, this would split into two buckets and manufacture an artificial zero-loop observation
    // for `task-1` (P1, PR #348 review).
    fakeBoard([bead({ id: "feat-1", issue_type: "feature" }), bead({ id: "task-1", parent: "feat-1" })]);
    await t.db.insert(schema.claudeInvocations).values([
      {
        id: "inv-ticket",
        projectId: t.projectId,
        jobType: "execute-epic",
        step: "implement",
        stepHandler: "implement",
        runId: "r1",
        beadId: "task-1",
        modelRequested: "sonnet-5",
        modelReported: "sonnet-5",
        outcome: "ok",
        recordedAt: new Date(WEEK_MONDAY),
      },
      {
        id: "inv-self-review",
        projectId: t.projectId,
        jobType: "execute-epic",
        step: "implement",
        stepHandler: "review",
        runId: "r1",
        beadId: "feat-1",
        modelRequested: "sonnet-5",
        modelReported: "sonnet-5",
        outcome: "ok",
        recordedAt: new Date(WEEK_MONDAY),
      },
    ]);

    const series = await trendSeries(t.db, t.projectId, 1, { nowMs: NOW_MS });
    expect(series?.reviewLoop).toEqual([
      { beadId: "feat-1", selfReviewInvocations: 1, prFixInvocations: 0, loopInvocations: 1, runaway: false },
    ]);
  });

  it("folds a feature's review loop over its WHOLE life, never truncated to the requested window", async () => {
    // feat-1's self-review ran 10 weeks before the 1-week window, but it DELIVERED inside the
    // window — cohortFeatures admits it on delivery alone, and its review loop must still count the
    // old self-review rather than a `since`-bound read silently dropping it (P1, PR #348 review).
    fakeBoard([bead({ id: "feat-1", issue_type: "feature" })]);
    await t.db.insert(schema.claudeInvocations).values({
      id: "inv-old-review",
      projectId: t.projectId,
      jobType: "execute-epic",
      step: "implement",
      stepHandler: "review",
      runId: "r0",
      beadId: "feat-1",
      modelRequested: "sonnet-5",
      modelReported: "sonnet-5",
      outcome: "ok",
      recordedAt: new Date(WEEK_MONDAY - 10 * 7 * DAY),
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
    expect(series?.reviewLoop.find((p) => p.beadId === "feat-1")).toEqual({
      beadId: "feat-1",
      selfReviewInvocations: 1,
      prFixInvocations: 0,
      loopInvocations: 1,
      runaway: false,
    });
  });

  it("excludes a feature's review loop once neither its activity nor its delivery falls in the requested window", async () => {
    // Every invocation AND the only recorded run for feat-old predate the 1-week window by 10 weeks —
    // cohortFeatures will not admit it, so its review loop must not leak into the CURRENT cohort's
    // median/runaway verdicts (P1, PR #348 review: "restrict review loops to the selected cohort").
    fakeBoard([bead({ id: "feat-old", issue_type: "feature" })]);
    await t.db.insert(schema.claudeInvocations).values({
      id: "inv-ancient-review",
      projectId: t.projectId,
      jobType: "execute-epic",
      step: "implement",
      stepHandler: "pr-fix",
      runId: "r-old",
      beadId: "feat-old",
      modelRequested: "sonnet-5",
      modelReported: "sonnet-5",
      outcome: "ok",
      recordedAt: new Date(WEEK_MONDAY - 10 * 7 * DAY),
    });
    await t.db.insert(schema.runs).values({
      id: "run-feat-old",
      projectId: t.projectId,
      epicBeadId: "feat-old",
      branch: "anton/feat-old",
      status: "done",
      startedAt: new Date(WEEK_MONDAY - 10 * 7 * DAY),
      endedAt: new Date(WEEK_MONDAY - 10 * 7 * DAY),
      updatedAt: new Date(WEEK_MONDAY - 10 * 7 * DAY),
    });

    const series = await trendSeries(t.db, t.projectId, 1, { nowMs: NOW_MS });
    expect(series?.reviewLoop.find((p) => p.beadId === "feat-old")).toBeUndefined();
  });

  it("stays silent on an agent-tagged feature's own describe pass, whose narrower prompt is not an edit", async () => {
    fakeBoard([]);
    // `describe.ts` composes base+seed only (no agent layer), so an agent-tagged feature running
    // implement then describe records two DIFFERENT promptDigest values under the same agentTag —
    // the common delivered-feature shape, not a real prompt edit.
    await t.db.insert(schema.claudeInvocations).values([
      {
        id: "inv-implement",
        projectId: t.projectId,
        jobType: "execute-epic",
        step: "implement",
        stepHandler: "implement",
        agentTag: "nextjs",
        promptDigest: "digest-implement",
        runId: "r1",
        beadId: "feat-1",
        outcome: "ok",
        recordedAt: new Date(WEEK_MONDAY),
      },
      {
        id: "inv-describe",
        projectId: t.projectId,
        jobType: "execute-epic",
        step: "describe",
        stepHandler: "describe",
        agentTag: "nextjs",
        promptDigest: "digest-describe",
        runId: "r1",
        beadId: "feat-1",
        outcome: "ok",
        recordedAt: new Date(WEEK_MONDAY + DAY),
      },
    ]);

    const series = await trendSeries(t.db, t.projectId, 1, { nowMs: NOW_MS });
    expect(series?.changeMarkers).toEqual([]);
  });
});
