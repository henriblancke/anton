/**
 * Unit tests for how a gate result becomes board state (anton-omum): the per-round entries, the
 * comment text a founder reads and a UI parses, and the label/comment writes persistReviewScores
 * makes. bd is faked here — that these commands actually land on a bead is the integration suite's
 * job (execute-epic.review-gate.integration.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beads, type Bead } from "../beads/bd";
import type { ReviewGateResult } from "./review-gate";
import {
  formatReviewScoreComment,
  partialReviewScoreEntries,
  persistPartialReviewScores,
  persistReviewScores,
  reviewScoreEntries,
  REVIEW_SCORE_KIND,
} from "./review-score";

const result = (over: Partial<ReviewGateResult> = {}): ReviewGateResult => ({
  outcome: "clean",
  rounds: [{ round: 1, reviewSessionId: "s1", score: 9, blocking: 0, advisory: 0 }],
  unresolved: [],
  reviewer: { kind: "default" },
  ...over,
});

describe("reviewScoreEntries", () => {
  it("gives the gate's outcome to the LAST round only — earlier rounds were fixed and re-reviewed", () => {
    const entries = reviewScoreEntries(
      result({
        outcome: "unresolved",
        rounds: [
          { round: 1, reviewSessionId: "s1", score: 4, blocking: 2, advisory: 1, rationale: "gaps" },
          { round: 2, reviewSessionId: "s2", score: 6, blocking: 1, advisory: 1 },
        ],
      }),
    );
    expect(entries).toEqual([
      { round: 1, score: 4, blocking: 2, advisory: 1, verdict: "fixed", rationale: "gaps" },
      { round: 2, score: 6, blocking: 1, advisory: 1, verdict: "unresolved" },
    ]);
  });

  it("records a round with no usable score rather than dropping it", () => {
    const [entry] = reviewScoreEntries(
      result({
        outcome: "protocol-violation",
        rounds: [{ round: 1, reviewSessionId: "s1", violation: "no-report", blocking: 0, advisory: 0 }],
      }),
    );
    expect(entry.score).toBeUndefined();
    expect(entry.verdict).toBe("protocol-violation");
  });
});

describe("partialReviewScoreEntries", () => {
  it("marks only the round the gate DIED in, so the earlier ones still read as fixed", () => {
    expect(
      partialReviewScoreEntries([
        { round: 1, reviewSessionId: "s1", score: 4, blocking: 2, advisory: 0 },
        { round: 2, reviewSessionId: "s2", score: 6, blocking: 1, advisory: 1, rationale: "closer" },
      ]),
    ).toEqual([
      { round: 1, score: 4, blocking: 2, advisory: 0, verdict: "fixed" },
      { round: 2, score: 6, blocking: 1, advisory: 1, verdict: "interrupted", rationale: "closer" },
    ]);
  });
});

describe("formatReviewScoreComment", () => {
  it("carries a human line and a machine payload in one comment", () => {
    const text = formatReviewScoreComment({
      round: 2,
      score: 7,
      blocking: 0,
      advisory: 3,
      verdict: "clean",
      rationale: "solid, three nits",
    });
    expect(text).toContain("anton self-review · round 2 · score 7/10 · 0 blocking, 3 advisory · clean");
    expect(text).toContain("solid, three nits");
    const payload = JSON.parse(/```json\s*\n([\s\S]*?)```/.exec(text)![1]);
    expect(payload).toMatchObject({ kind: REVIEW_SCORE_KIND, round: 2, score: 7, verdict: "clean" });
  });

  it("says so plainly when the round produced no score", () => {
    const text = formatReviewScoreComment({
      round: 1,
      blocking: 0,
      advisory: 0,
      verdict: "protocol-violation",
    });
    expect(text).toContain("no valid score");
  });
});

describe("persistReviewScores", () => {
  let comment: ReturnType<typeof vi.spyOn>;
  let setReviewScore: ReturnType<typeof vi.spyOn>;
  let show: ReturnType<typeof vi.spyOn>;

  const bead = (labels: string[]): Bead => ({ id: "anton-t", title: "T", status: "open", labels });

  beforeEach(() => {
    comment = vi.spyOn(beads, "comment").mockResolvedValue("");
    setReviewScore = vi.spyOn(beads, "setReviewScore").mockResolvedValue("");
    show = vi.spyOn(beads, "show").mockResolvedValue(bead([]));
  });

  afterEach(() => vi.restoreAllMocks());

  it("appends one comment per round and labels the latest score, diffing out the previous one", async () => {
    show.mockResolvedValue(bead(["stage:implementing", "review-score:4"]));
    await persistReviewScores("/repo", "anton-t", {
      ...result({
        rounds: [
          { round: 1, reviewSessionId: "s1", score: 4, blocking: 1, advisory: 0 },
          { round: 2, reviewSessionId: "s2", score: 8, blocking: 0, advisory: 0 },
        ],
      }),
    });

    expect(comment).toHaveBeenCalledTimes(2);
    expect(comment.mock.calls[0][2]).toContain("round 1");
    expect(comment.mock.calls[1][2]).toContain("round 2");
    // The stale value goes with the same update that adds the new one — never the stage label.
    expect(setReviewScore).toHaveBeenCalledWith("/repo", "anton-t", 8, ["review-score:4"]);
  });

  it("labels the last round that HAD a score, so a trailing violation can't erase it", async () => {
    await persistReviewScores("/repo", "anton-t", {
      ...result({
        outcome: "protocol-violation",
        rounds: [
          { round: 1, reviewSessionId: "s1", score: 6, blocking: 1, advisory: 0 },
          { round: 2, reviewSessionId: "s2", violation: "invalid-score", blocking: 0, advisory: 0 },
        ],
      }),
    });
    expect(setReviewScore).toHaveBeenCalledWith("/repo", "anton-t", 6, []);
  });

  it("writes no label when no round ever reported a score", async () => {
    await persistReviewScores("/repo", "anton-t", {
      ...result({
        outcome: "protocol-violation",
        rounds: [{ round: 1, reviewSessionId: "s1", violation: "no-report", blocking: 0, advisory: 0 }],
      }),
    });
    expect(comment).toHaveBeenCalledTimes(1);
    expect(setReviewScore).not.toHaveBeenCalled();
  });

  it("still writes the rounds an interrupted gate finished, and nothing at all when it finished none", async () => {
    // A gate that THROWS returns no result, so without this path the whole series dies with the
    // stack — and a park (or a quota reschedule that restarts the gate at round 1) is exactly when
    // the founder opens the bead to see what happened.
    await persistPartialReviewScores("/repo", "anton-t", [
      { round: 1, reviewSessionId: "s1", score: 5, blocking: 2, advisory: 0 },
    ]);
    expect(comment).toHaveBeenCalledTimes(1);
    expect(comment.mock.calls[0][2]).toContain("round 1");
    expect(comment.mock.calls[0][2]).toContain("interrupted");
    expect(setReviewScore).toHaveBeenCalledWith("/repo", "anton-t", 5, []);

    vi.clearAllMocks();
    await persistPartialReviewScores("/repo", "anton-t", []);
    expect(comment).not.toHaveBeenCalled();
    expect(setReviewScore).not.toHaveBeenCalled();
  });

  it("keeps going when a board write fails — a degraded history never fails a landed run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    comment.mockRejectedValueOnce(new Error("bd locked"));
    // The score still comes back for the run row: a degraded BOARD history must not cost the
    // breaker the number this attempt actually earned.
    await expect(
      persistReviewScores("/repo", "anton-t", {
        ...result({
          rounds: [
            { round: 1, reviewSessionId: "s1", score: 4, blocking: 1, advisory: 0 },
            { round: 2, reviewSessionId: "s2", score: 8, blocking: 0, advisory: 0 },
          ],
        }),
      }),
    ).resolves.toBe(8);
    expect(comment).toHaveBeenCalledTimes(2); // round 2 still written
    expect(setReviewScore).toHaveBeenCalledWith("/repo", "anton-t", 8, []);
  });
});
