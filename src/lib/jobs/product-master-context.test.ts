/**
 * What the product-master session is handed to judge (anton-l4do), exercised DIRECTLY.
 *
 * The score SERIES is the whole reason this step exists: "three reviews at 4, 3, 2" is a case for
 * killing a bead and "currently 2" is a snapshot. It costs one `bd show` per bead, so the two things
 * that must hold are that the budget is spent on work the session will actually see, and that a
 * thread which will not load costs that bead its history and nothing more.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bead } from "../beads/bd";
import { fakeScope } from "./pass.fixture";
import { makeProjectDb, type TestProjectDb } from "@/lib/testing/project";

const showWithCommentsMock = vi.fn<(cwd: string, id: string) => Promise<Bead>>();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      showWithComments: (...a: [string, string]) => showWithCommentsMock(...a),
    },
  };
});

const { collectBoardInput, MAX_HYDRATED_SCORE_SERIES } = await import("./product-master-context");

const REPO = "/tmp/product-master-context";
const NOW = Date.parse("2026-08-04T12:00:00Z");

const bead = (id: string, o: Partial<Bead> = {}): Bead => ({
  id,
  title: id,
  status: "open",
  issue_type: "task",
  priority: 2,
  ...o,
});

/** A bead whose review thread carries the rounds anton's reviewer writes (anton-3apm). */
const reviewed = (id: string, scores: number[], o: Partial<Bead> = {}): Bead =>
  bead(id, { labels: [`review-score:${scores[scores.length - 1]}`], ...o });

const roundsOf = (scores: number[]) =>
  scores.map((score, i) => ({
    text:
      "```json\n" +
      JSON.stringify({
        kind: "anton.review-score",
        round: i + 1,
        score,
        blocking: 0,
        advisory: 0,
        verdict: "clean",
      }) +
      "\n```",
  }));

let t: TestProjectDb;
let projectId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  t = makeProjectDb({ repoPath: REPO });
  projectId = t.projectId;
  showWithCommentsMock.mockImplementation(async (_cwd, id) => bead(id, { comments: [] }));
});

afterEach(() => t.close());

const collect = (board: Bead[]) =>
  collectBoardInput(fakeScope(REPO, { project: { id: projectId, repoPath: REPO } }), {
    db: t.db,
    board,
    observedAtMs: NOW,
  });

describe("collectBoardInput", () => {
  it("carries the board and the fence the session judges against", async () => {
    const board = [bead("anton-a")];
    const input = await collect(board);

    expect(input.board).toBe(board);
    expect(input.now).toBe(NOW);
    expect(input.runs).toEqual([]);
    // Nothing reviewed is not the same as everything scoring zero: the context renders no series.
    expect(input.scores).toBeUndefined();
    expect(showWithCommentsMock).not.toHaveBeenCalled();
  });

  it("replays the round-by-round history behind a bead's score label", async () => {
    showWithCommentsMock.mockResolvedValue(bead("anton-a", { comments: roundsOf([7, 4, 3]) }));

    const input = await collect([reviewed("anton-a", [3])]);
    expect(input.scores?.get("anton-a")).toEqual([7, 4, 3]);
  });

  it("falls back to the label when the thread carries no readable round", async () => {
    // An empty series would read as "never reviewed"; the latest score is still real evidence.
    const input = await collect([reviewed("anton-a", [3])]);
    expect(input.scores?.get("anton-a")).toEqual([3]);
  });

  it("keeps its judgment — and says so — when a bead's history will not load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    showWithCommentsMock.mockRejectedValue(new Error("bd exploded"));
    const scope = fakeScope(REPO, { project: { id: projectId, repoPath: REPO } });

    const input = await collectBoardInput(scope, {
      db: t.db,
      board: [reviewed("anton-a", [3])],
      observedAtMs: NOW,
    });

    expect(input.scores?.get("anton-a")).toEqual([3]);
    expect(scope.logged.join("")).toContain("could not read anton-a's review history — bd exploded");
    warn.mockRestore();
  });

  it("spends its budget on open work only — a settled bead's series is one the session never sees", async () => {
    const board = [
      reviewed("anton-done", [2], { status: "closed" }),
      reviewed("anton-a", [3]),
    ];

    await collect(board);
    expect(showWithCommentsMock.mock.calls.map(([, id]) => id)).toEqual(["anton-a"]);
  });

  it("hydrates the most recently written first, and stops at the budget", async () => {
    // A board with a hundred reviewed targets would otherwise cost a hundred bd spawns per pass.
    const board = Array.from({ length: MAX_HYDRATED_SCORE_SERIES + 3 }, (_, i) =>
      reviewed(`anton-${i}`, [3], { updated_at: new Date(NOW - i * 60_000).toISOString() }),
    );

    await collect(board);

    const asked = showWithCommentsMock.mock.calls.map(([, id]) => id);
    expect(asked).toHaveLength(MAX_HYDRATED_SCORE_SERIES);
    expect(asked[0]).toBe("anton-0"); // newest first — where the judgment usually is
    expect(asked).not.toContain(`anton-${MAX_HYDRATED_SCORE_SERIES + 2}`);
  });
});
