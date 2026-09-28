/**
 * The per-round review record's write path (anton-z5e3g): the counts a round derives from the PR it
 * fetched and the report its fixer produced, and the two rules that make those counts trustworthy.
 *
 * The first is that they must reconcile with the PR. `outcomes_fixed` counts fixes GitHub has a
 * record of — a "fixed" claim with nothing pushed, or one naming a thread anton never answered, is
 * counted nowhere, because those are exactly the outcomes `applyThreadOutcomes` replies to no thread
 * with. A row whose fix count exceeds the replies on the PR would make the record unusable for the
 * one question it exists to answer.
 *
 * The second is that recording must never cost a fix. Both writes swallow their own failures, so
 * these cases prove a broken db loses the counts and nothing else.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "./db/testing";
import * as schema from "./db/schema";
import type { PrReview, ReviewThread } from "./git/pr";
import { ANTON_MARK } from "./git/pr";
import type { ThreadOutcome } from "./jobs/review-fix-context";
import {
  recordPrReopened,
  recordPrTerminalState,
  recordReviewRound,
  roundCounts,
  type ReviewRoundRow,
} from "./review-rounds";
import type { AntonDb, Clock } from "./jobs/queue";

let t: TestDb;
const PROJECT = "p1";
const T0 = 1_800_000_000_000;

const clock: Clock = { now: () => T0 };

beforeEach(async () => {
  t = makeTestDb();
  await t.db
    .insert(schema.projects)
    .values({ id: PROJECT, slug: "p1", name: "P1", repoPath: "/repo" });
  return () => t.close();
});

/** An inline thread as `getReviewThreads` hands it over. `comments` is oldest-first. */
function thread(
  id: string,
  comments: Array<[author: string, body: string]>,
  over: Partial<ReviewThread> = {},
): ReviewThread {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    comments: comments.map(([author, body], i) => ({ id: i + 1, author, body })),
    ...over,
  };
}

function prWith(threads: ReviewThread[], threadsComplete = true): PrReview {
  return {
    number: 331,
    state: "OPEN",
    reviewDecision: "CHANGES_REQUESTED",
    mergeable: "MERGEABLE",
    headRefName: "anton/feat",
    headSha: "sha",
    url: "u",
    reviews: [],
    failingChecks: [],
    pendingChecks: 0,
    threads,
    threadsComplete,
  };
}

const rows = (): ReviewRoundRow[] => t.db.select().from(schema.reviewRounds).all();

/** The fixture PR the acceptance names: 3 threads from 2 reviewers, one of them already outdated. */
const FIXTURE = prWith([
  thread("RT_1", [["claude[bot]", "rename foo to bar"]]),
  thread("RT_2", [["claude[bot]", "this file is structurally broken"]], { isOutdated: true }),
  thread("RT_3", [["henri", "is this the right layer?"]]),
]);

const FIXTURE_REPORT: ThreadOutcome[] = [
  { id: "RT_1", outcome: "fixed", reply: "renamed" },
  { id: "RT_2", outcome: "left", reply: "style-only" },
  { id: "RT_3", outcome: "needs-human", reply: "product call" },
];

describe("roundCounts", () => {
  it("counts a fixture PR's threads and outcomes, split by the reviewer who opened each", () => {
    expect(roundCounts(FIXTURE, FIXTURE_REPORT, true)).toEqual({
      threadsSeen: 3,
      threadsUnresolved: 3,
      threadsOutdated: 1,
      threadsActionable: 3,
      outcomesFixed: 1,
      outcomesLeft: 1,
      outcomesNeedsHuman: 1,
      // The whole reason the record is worth keeping: a bot's volume and a human's are distinguishable.
      byAuthor: { "claude[bot]": 2, henri: 1 },
      threadsComplete: true,
    });
  });

  it("counts every thread as seen but only the waiting ones as actionable", () => {
    // The two counts diverge on every re-review, which is why both are stored: a resolved thread and
    // one anton already answered are still part of the PR's history but are not this round's work.
    const pr = prWith([
      thread("RT_done", [["henri", "nit"]], { isResolved: true }),
      thread("RT_answered", [
        ["henri", "rename this"],
        ["anton", `${ANTON_MARK} renamed`],
      ]),
      thread("RT_open", [["henri", "and this"]]),
    ]);

    expect(roundCounts(pr, [], false)).toMatchObject({
      threadsSeen: 3,
      threadsUnresolved: 2,
      threadsActionable: 1,
      byAuthor: { henri: 1 },
    });
  });

  it("counts no fix for a 'fixed' claim with nothing pushed", () => {
    // A fabrication: `applyThreadOutcomes` leaves that thread untouched, so counting it as a fix
    // would report a fix the PR has no reply, reaction or resolution for.
    const report: ThreadOutcome[] = [{ id: "RT_1", outcome: "fixed", reply: "renamed" }];
    expect(roundCounts(FIXTURE, report, false)).toMatchObject({
      outcomesFixed: 0,
      outcomesLeft: 0,
      outcomesNeedsHuman: 0,
    });
    expect(roundCounts(FIXTURE, report, true)).toMatchObject({ outcomesFixed: 1 });
  });

  it("counts no outcome for a thread that was not this round's to answer", () => {
    // A stale or invented thread id, and a thread whose last word is already anton's — both drop out
    // of `threadsNeedingAttention`, so neither was replied to and neither is counted.
    const pr = prWith([
      thread("RT_answered", [
        ["henri", "rename this"],
        ["anton", `${ANTON_MARK} done`],
      ]),
    ]);
    const report: ThreadOutcome[] = [
      { id: "RT_answered", outcome: "fixed" },
      { id: "RT_never_existed", outcome: "fixed" },
    ];

    expect(roundCounts(pr, report, true)).toMatchObject({
      threadsActionable: 0,
      outcomesFixed: 0,
    });
  });

  it("counts a reviewer whose login shadows an Object.prototype member", () => {
    // "constructor" as a plain key would read back Object.prototype.constructor instead of
    // undefined, so `?? 0` never fires and the count comes out corrupted.
    const pr = prWith([thread("RT_1", [["constructor", "nit"]])]);
    expect(roundCounts(pr, [], false)).toMatchObject({ byAuthor: { constructor: 1 } });
  });

  it("counts a round with no inline threads at all as zeros, not as nothing", () => {
    // A CI-only or merge-conflict round: real review work, over no threads. The zeros say so —
    // distinct from the no-row a polling tick leaves.
    expect(roundCounts(prWith([]), [], true)).toEqual({
      threadsSeen: 0,
      threadsUnresolved: 0,
      threadsOutdated: 0,
      threadsActionable: 0,
      outcomesFixed: 0,
      outcomesLeft: 0,
      outcomesNeedsHuman: 0,
      byAuthor: {},
      threadsComplete: true,
    });
  });

  it("flags a round as incomplete when the PR's thread read degraded (PR #335 review)", () => {
    // A GraphQL failure yields an empty or truncated `threads` indistinguishable from a genuinely
    // clean PR unless the round also carries `threadsComplete: false`.
    const pr = prWith([], false);
    expect(roundCounts(pr, [], false)).toMatchObject({ threadsSeen: 0, threadsComplete: false });
  });
});

describe("recordReviewRound", () => {
  const record = (over: Partial<Parameters<typeof recordReviewRound>[2]> = {}) =>
    recordReviewRound(t.db, clock, {
      projectId: PROJECT,
      beadId: "anton-feat",
      jobId: "job-1",
      prNumber: 331,
      pr: FIXTURE,
      report: FIXTURE_REPORT,
      pushed: true,
      ...over,
    });

  it("writes one row carrying the fixture PR's counts and its dimensions", async () => {
    await record();

    expect(rows()).toHaveLength(1);
    const [row] = rows();
    expect(row).toMatchObject({
      projectId: PROJECT,
      beadId: "anton-feat",
      // The join to the round's own spend: `claude_invocations` keys on `job_id` too.
      jobId: "job-1",
      prNumber: 331,
      round: 1,
      threadsSeen: 3,
      threadsOutdated: 1,
      threadsActionable: 3,
      outcomesFixed: 1,
      outcomesLeft: 1,
      outcomesNeedsHuman: 1,
    });
    expect(JSON.parse(row.byAuthorJson)).toEqual({ "claude[bot]": 2, henri: 1 });
    // Its PR is still open, so its fate is unknown until finalize learns it.
    expect(row.prState).toBeNull();
    expect(row.prStateAt).toBeNull();
  });

  it("numbers a PR's rounds 1..n, appending rather than revising", async () => {
    await record();
    await record({ report: [{ id: "RT_3", outcome: "fixed", reply: "did it" }] });

    // Σ over a PR's rows is its whole review history — the append-only rule. The second round's own
    // counts stand beside the first's rather than replacing them.
    expect(rows().map((r) => [r.round, r.outcomesFixed])).toEqual([
      [1, 1],
      [2, 1],
    ]);
  });

  it("keeps two PRs' rounds on their own sequences", async () => {
    await record();
    await record({ prNumber: 332 });

    expect(rows().map((r) => [r.prNumber, r.round])).toEqual([
      [331, 1],
      [332, 1],
    ]);
  });
});

describe("recordPrTerminalState", () => {
  const record = (prNumber: number) =>
    recordReviewRound(t.db, clock, {
      projectId: PROJECT,
      prNumber,
      pr: FIXTURE,
      report: FIXTURE_REPORT,
      pushed: true,
    });

  it("stamps merged across every round the PR collected", async () => {
    await record(331);
    await record(331);

    await recordPrTerminalState(t.db, clock, {
      projectId: PROJECT,
      prNumber: 331,
      state: "merged",
    });

    expect(rows().map((r) => [r.round, r.prState, r.prStateAt?.getTime()])).toEqual([
      [1, "merged", T0],
      [2, "merged", T0],
    ]);
  });

  it("stamps closed, and leaves another PR's rounds alone", async () => {
    await record(331);
    await record(332);

    await recordPrTerminalState(t.db, clock, {
      projectId: PROJECT,
      prNumber: 331,
      state: "closed",
    });

    expect(rows().map((r) => [r.prNumber, r.prState])).toEqual([
      [331, "closed"],
      [332, null],
    ]);
  });

  it("keeps the first end it observed — a re-run cannot revise a settled fact", async () => {
    await record(331);
    await recordPrTerminalState(t.db, clock, {
      projectId: PROJECT,
      prNumber: 331,
      state: "merged",
    });

    // Finalization is deliberately resumable, so it can run twice on one merged target; a merged PR
    // cannot later become closed either way.
    await recordPrTerminalState(t.db, { now: () => T0 + 9000 }, {
      projectId: PROJECT,
      prNumber: 331,
      state: "closed",
    });

    expect(rows()[0]).toMatchObject({ prState: "merged" });
    expect(rows()[0].prStateAt?.getTime()).toBe(T0);
  });

  it("lets a later merged observation supersede an earlier closed stamp — a reopened PR", async () => {
    await record(331);
    await recordPrTerminalState(t.db, clock, {
      projectId: PROJECT,
      prNumber: 331,
      state: "closed",
    });

    // GitHub allows a closed PR to be reopened and later merged; closed is not final the way
    // merged is, so the correction must land.
    await recordPrTerminalState(t.db, { now: () => T0 + 9000 }, {
      projectId: PROJECT,
      prNumber: 331,
      state: "merged",
    });

    expect(rows()[0]).toMatchObject({ prState: "merged" });
    expect(rows()[0].prStateAt?.getTime()).toBe(T0 + 9000);
  });

  it("restamps every row together when a reopened PR closes again", async () => {
    await record(331);
    await recordPrTerminalState(t.db, clock, {
      projectId: PROJECT,
      prNumber: 331,
      state: "closed",
    });

    // The PR was reopened for another round, then closed again without merging.
    await record(331);
    const laterClock: Clock = { now: () => T0 + 9000 };
    await recordPrTerminalState(t.db, laterClock, {
      projectId: PROJECT,
      prNumber: 331,
      state: "closed",
    });

    // Both rows must agree on the same, later close — not one stuck at the first close.
    expect(rows().map((r) => [r.round, r.prState, r.prStateAt?.getTime()])).toEqual([
      [1, "closed", T0 + 9000],
      [2, "closed", T0 + 9000],
    ]);
  });

  it("does not refresh prStateAt on a repeat poll of an already-settled close", async () => {
    await record(331);
    await recordPrTerminalState(t.db, clock, {
      projectId: PROJECT,
      prNumber: 331,
      state: "closed",
    });

    await recordPrTerminalState(t.db, { now: () => T0 + 9000 }, {
      projectId: PROJECT,
      prNumber: 331,
      state: "closed",
    });

    expect(rows()[0]).toMatchObject({ prState: "closed" });
    expect(rows()[0].prStateAt?.getTime()).toBe(T0);
  });

  it("writes nothing for a PR with no recorded rounds", async () => {
    // A PR whose rounds all predate this table, or one anton only ever polled. The gap reads as "not
    // measured"; a synthesized row would report a PR nobody reviewed.
    await recordPrTerminalState(t.db, clock, {
      projectId: PROJECT,
      prNumber: 999,
      state: "merged",
    });

    expect(rows()).toHaveLength(0);
  });
});

describe("recordPrReopened", () => {
  const record = (prNumber: number) =>
    recordReviewRound(t.db, clock, {
      projectId: PROJECT,
      prNumber,
      pr: FIXTURE,
      report: FIXTURE_REPORT,
      pushed: true,
    });

  it("restamps a PR reopened and closed again without another round in between (PR #335 review)", async () => {
    await record(331);
    await recordPrTerminalState(t.db, clock, { projectId: PROJECT, prNumber: 331, state: "closed" });

    // The PR reopened and stayed clean — no round dispatched, so no fresh null-state row exists for
    // `recordPrTerminalState`'s heuristic to find. `recordPrReopened` is the observation that fills
    // that gap.
    await recordPrReopened(t.db, { projectId: PROJECT, prNumber: 331 });
    const laterClock: Clock = { now: () => T0 + 9000 };
    await recordPrTerminalState(t.db, laterClock, { projectId: PROJECT, prNumber: 331, state: "closed" });

    expect(rows()[0]).toMatchObject({ prState: "closed" });
    expect(rows()[0].prStateAt?.getTime()).toBe(T0 + 9000);
  });

  it("does nothing to a PR that was never closed", async () => {
    await record(331);
    await recordPrReopened(t.db, { projectId: PROJECT, prNumber: 331 });

    expect(rows()[0]).toMatchObject({ prState: null });
  });

  it("does not disturb a merged PR — GitHub does not allow reopening one", async () => {
    await record(331);
    await recordPrTerminalState(t.db, clock, { projectId: PROJECT, prNumber: 331, state: "merged" });

    await recordPrReopened(t.db, { projectId: PROJECT, prNumber: 331 });

    expect(rows()[0]).toMatchObject({ prState: "merged" });
  });

  it("swallows a write against a broken db", async () => {
    const boom = () => {
      throw new Error("SQLITE_BUSY: database is locked");
    };
    await expect(
      recordPrReopened({ update: boom } as unknown as AntonDb, { projectId: PROJECT, prNumber: 331 }),
    ).resolves.toBeUndefined();
  });
});

describe("recording never fails the round", () => {
  /** A db whose every `review_rounds` write rejects — a locked database, a schema not yet migrated. */
  function brokenDb(): AntonDb {
    const boom = () => {
      throw new Error("SQLITE_BUSY: database is locked");
    };
    return { select: boom, insert: boom, update: boom } as unknown as AntonDb;
  }

  it("swallows a round write that throws", async () => {
    await expect(
      recordReviewRound(brokenDb(), clock, {
        projectId: PROJECT,
        prNumber: 331,
        pr: FIXTURE,
        report: FIXTURE_REPORT,
        pushed: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("swallows a terminal stamp that throws", async () => {
    await expect(
      recordPrTerminalState(brokenDb(), clock, {
        projectId: PROJECT,
        prNumber: 331,
        state: "merged",
      }),
    ).resolves.toBeUndefined();
  });

  it("swallows a write against a table that vanished underneath it", async () => {
    // The sharpest form of a write that cannot land — and the shape an un-migrated db takes.
    t.sqlite.exec("DROP TABLE review_rounds");

    await expect(
      recordReviewRound(t.db, clock, {
        projectId: PROJECT,
        prNumber: 331,
        pr: FIXTURE,
        report: FIXTURE_REPORT,
        pushed: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("swallows a PR payload whose shape it did not expect", async () => {
    // The counts are derived from a GitHub payload and a model-controlled report, so the counting
    // sits inside the same guard as the insert: a shape nobody anticipated costs the row, not the fix.
    await expect(
      recordReviewRound(t.db, clock, {
        projectId: PROJECT,
        prNumber: 331,
        pr: undefined as unknown as PrReview,
        report: FIXTURE_REPORT,
        pushed: true,
      }),
    ).resolves.toBeUndefined();
    expect(rows()).toHaveLength(0);
  });
});
