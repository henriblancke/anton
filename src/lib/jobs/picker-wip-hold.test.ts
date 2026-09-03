/**
 * The WIP hold's I/O end (anton-wy9y / R4.2).
 *
 * The rules are pinned in autopilot-wip.test.ts. What is pinned HERE is the join the count is built
 * from — an in-review run target off the board, confirmed unmerged against GitHub — and the three
 * ways that join decides wrongly: a merged PR that is still labelled in-review, a PR closed without
 * merging (which nothing takes off the board at all), and a `gh` that cannot answer.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../db/testing";
import { LABELS } from "../beads/bd";
import type { Bead } from "../beads/types";
import type { PrActivity } from "../git/pr";
import { describeWipHold } from "../autopilot-wip";
import { checkWipLimit, confirmWipQueue, type ReadPrActivity } from "./picker-wip-hold";
import { insertProject } from "@/lib/testing/project";

const PROJECT = "p1";
const REPO = "/repo";
const IN_REVIEW = LABELS.stage("in-review");

let t: TestDb;

function project(settings: Record<string, unknown> = {}): void {
  insertProject(t.db, {
    id: PROJECT,
    slug: "p1",
    name: "P1",
    repoPath: REPO,
    settingsJson: JSON.stringify(settings),
  });
}

/** An open run target in review, pointing at its PR — what execute-epic leaves behind. */
function inReview(id: string, prNumber: number): Bead {
  return {
    id,
    title: id,
    status: "open",
    issue_type: "feature",
    labels: [IN_REVIEW],
    metadata: { pr: `gh-${prNumber}` },
  };
}

/** A `gh pr view` stand-in: every PR OPEN unless `states` says otherwise. */
function reader(states: Record<number, string> = {}): ReadPrActivity & { calls: number[] } {
  const calls: number[] = [];
  const read = async (_repo: string, number: number): Promise<PrActivity> => {
    calls.push(number);
    return {
      number,
      state: states[number] ?? "OPEN",
      url: `https://example.test/pull/${number}`,
      updatedAtMs: 0,
      isDraft: false,
    };
  };
  return Object.assign(read, { calls });
}

beforeEach(() => {
  t = makeTestDb();
});
afterEach(() => t.close());

describe("checkWipLimit", () => {
  it("holds at the default limit, naming every PR waiting on the operator", async () => {
    project();
    const readPrActivity = reader();

    const hold = await checkWipLimit(t.db, {
      projectId: PROJECT,
      repoPath: REPO,
      board: [inReview("anton-a", 11), inReview("anton-b", 12), inReview("anton-c", 13)],
      readPrActivity,
    });

    expect(hold?.limit).toBe(3);
    expect(hold?.slots.map((s) => s.prNumber)).toEqual([11, 12, 13]);
  });

  it("does not hold one PR short of the limit, and spawns no gh to find that out", async () => {
    project();
    const readPrActivity = reader();

    const hold = await checkWipLimit(t.db, {
      projectId: PROJECT,
      repoPath: REPO,
      board: [inReview("anton-a", 11), inReview("anton-b", 12)],
      readPrActivity,
    });

    expect(hold).toBeUndefined();
    // Confirming can only SHRINK the count, so under the limit there is nothing a PR read could
    // change — and the ten-minute cadence stays free for a project keeping up with its reviews.
    expect(readPrActivity.calls).toEqual([]);
  });

  it("drops a merged PR, so the queue frees up before the board catches up", async () => {
    project();

    const hold = await checkWipLimit(t.db, {
      projectId: PROJECT,
      repoPath: REPO,
      board: [inReview("anton-a", 11), inReview("anton-b", 12), inReview("anton-c", 13)],
      readPrActivity: reader({ 12: "MERGED" }),
    });

    expect(hold).toBeUndefined();
  });

  it("drops a PR closed without merging — nothing else ever takes it off the board", async () => {
    // review-fix deliberately leaves a closed-unmerged PR's bead alone, ref and stage and all, so a
    // recovery re-run can find it. Counted off the board alone it would hold the picker forever.
    project();

    const hold = await checkWipLimit(t.db, {
      projectId: PROJECT,
      repoPath: REPO,
      board: [inReview("anton-a", 11), inReview("anton-b", 12), inReview("anton-c", 13)],
      readPrActivity: reader({ 13: "CLOSED" }),
    });

    expect(hold).toBeUndefined();
  });

  it("counts a PR gh cannot read, rather than letting a flaky gh lift the limit", async () => {
    project();
    const failing: ReadPrActivity = async (_repo, number) => {
      if (number === 12) throw new Error("gh: not authenticated");
      return { number, state: "OPEN", url: "", updatedAtMs: 0, isDraft: false };
    };

    const hold = await checkWipLimit(t.db, {
      projectId: PROJECT,
      repoPath: REPO,
      board: [inReview("anton-a", 11), inReview("anton-b", 12), inReview("anton-c", 13)],
      readPrActivity: failing,
    });

    expect(hold?.slots.map((s) => s.prNumber)).toEqual([11, 12, 13]);
  });

  it("ignores in-review beads that are not run targets or carry no PR", async () => {
    project({ autopilotWipLimit: 2 });
    const container = { ...inReview("anton-epic", 9), issue_type: "epic" };

    const hold = await checkWipLimit(t.db, {
      projectId: PROJECT,
      repoPath: REPO,
      board: [
        container,
        // The container's feature child — what actually owns the review.
        { id: "anton-f", title: "f", status: "open", issue_type: "feature", parent: "anton-epic" },
        { ...inReview("anton-b", 0), metadata: {} },
        inReview("anton-c", 13),
      ],
      readPrActivity: reader(),
    });

    expect(hold).toBeUndefined();
  });

  it("honours the project's own limit", async () => {
    project({ autopilotWipLimit: 1 });

    const hold = await checkWipLimit(t.db, {
      projectId: PROJECT,
      repoPath: REPO,
      board: [inReview("anton-a", 11)],
      readPrActivity: reader(),
    });

    expect(hold?.limit).toBe(1);
  });

  it("stays off for a project that set the limit to 0", async () => {
    project({ autopilotWipLimit: 0 });
    const readPrActivity = reader();

    const hold = await checkWipLimit(t.db, {
      projectId: PROJECT,
      repoPath: REPO,
      board: [inReview("anton-a", 11), inReview("anton-b", 12), inReview("anton-c", 13)],
      readPrActivity,
    });

    expect(hold).toBeUndefined();
    expect(readPrActivity.calls).toEqual([]);
  });

  it("releases on the next pass once one PR merges — no human act, nothing to clear", async () => {
    project();
    const board = [inReview("anton-a", 11), inReview("anton-b", 12), inReview("anton-c", 13)];
    const ask = (readPrActivity: ReadPrActivity) =>
      checkWipLimit(t.db, { projectId: PROJECT, repoPath: REPO, board, readPrActivity });

    expect(await ask(reader())).toBeDefined();

    // The operator merges #12. The bead has not been finalized yet — the board is byte-identical.
    expect(await ask(reader({ 12: "MERGED" }))).toBeUndefined();
  });

  it("stops reading once the limit is confirmed, rather than one gh per backlogged PR", async () => {
    // The project with a fourteen-PR backlog is the one this brake exists for; it must not be the
    // one that spawns fourteen processes per pass to find that out.
    project();
    const readPrActivity = reader();
    const board = Array.from({ length: 14 }, (_, i) => inReview(`anton-${i}`, 20 + i));

    const hold = await checkWipLimit(t.db, {
      projectId: PROJECT,
      repoPath: REPO,
      board,
      readPrActivity,
    });

    expect(hold).toBeDefined();
    expect(readPrActivity.calls.length).toBeLessThanOrEqual(4);
    // …and the count it reports is the sample's, flagged as the lower bound it is: ten candidates
    // were never read, and telling the operator four PRs are waiting would be wrong by ten.
    expect(hold?.truncated).toBe(true);
    expect(describeWipHold(hold!)).toMatch(/^at least 4 open PRs are waiting on review/);
  });

  it("does not flag truncation when every candidate was confirmed", async () => {
    project();
    const board = [inReview("anton-a", 11), inReview("anton-b", 12), inReview("anton-c", 13)];

    const hold = await checkWipLimit(t.db, {
      projectId: PROJECT,
      repoPath: REPO,
      board,
      readPrActivity: reader(),
    });

    expect(hold?.truncated).toBeUndefined();
    expect(describeWipHold(hold!)).toMatch(/^3 open PRs are waiting on review/);
  });

  it("keeps reading past a merged PR until the limit is confirmed", async () => {
    // Short-circuiting must not shrink the count: a batch full of merged PRs proves bandwidth, not
    // a hold, so the confirmation has to carry on into the rest of the queue.
    project();
    const readPrActivity = reader({ 20: "MERGED", 21: "MERGED", 22: "CLOSED" });
    const board = Array.from({ length: 6 }, (_, i) => inReview(`anton-${i}`, 20 + i));

    const hold = await checkWipLimit(t.db, {
      projectId: PROJECT,
      repoPath: REPO,
      board,
      readPrActivity,
    });

    expect(hold?.slots.map((s) => s.prNumber)).toEqual([23, 24, 25]);
  });

  it("re-holds by itself when the queue fills again", async () => {
    // Nothing is latched, so there is no state that could survive the release and stay stuck.
    project();
    const readPrActivity = reader();
    const ask = (board: Bead[]) =>
      checkWipLimit(t.db, { projectId: PROJECT, repoPath: REPO, board, readPrActivity });

    expect(await ask([inReview("anton-a", 11), inReview("anton-b", 12)])).toBeUndefined();
    expect(
      await ask([inReview("anton-a", 11), inReview("anton-b", 12), inReview("anton-c", 13)]),
    ).toBeDefined();
  });
});

describe("confirmWipQueue", () => {
  it("names the slots it retired, which the board goes on showing", async () => {
    // What a clearing verdict RESTS on, and the only part of it no later board read can re-check
    // (PR #218 review): #13 is closed, so it stopped counting — but nothing takes it off the board,
    // and reopening it refills the slot with the bead and PR ref unchanged.
    project();

    const verdict = await confirmWipQueue(t.db, {
      projectId: PROJECT,
      repoPath: REPO,
      board: [inReview("anton-a", 11), inReview("anton-b", 12), inReview("anton-c", 13)],
      readPrActivity: reader({ 13: "CLOSED" }),
    });

    expect(verdict.hold).toBeUndefined();
    expect(verdict.retired).toEqual([{ beadId: "anton-c", prNumber: 13 }]);
  });

  it("retires nothing when it read no PR at all", async () => {
    // Under the limit the verdict is the board's own, so there is nothing for a caller to reconcile
    // and no extra confirmation to pay for.
    project();

    const verdict = await confirmWipQueue(t.db, {
      projectId: PROJECT,
      repoPath: REPO,
      board: [inReview("anton-a", 11), inReview("anton-b", 12)],
      readPrActivity: reader(),
    });

    expect(verdict).toEqual({ retired: [] });
  });

  it("retires nothing off a full queue, since every candidate it read still counts", async () => {
    project();

    const verdict = await confirmWipQueue(t.db, {
      projectId: PROJECT,
      repoPath: REPO,
      board: [inReview("anton-a", 11), inReview("anton-b", 12), inReview("anton-c", 13)],
      readPrActivity: reader(),
    });

    expect(verdict.hold).toBeDefined();
    expect(verdict.retired).toEqual([]);
  });
});
