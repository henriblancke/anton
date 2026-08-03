import { describe, expect, it } from "vitest";

import type { Bead } from "./beads/bd";
import { reviewScoreOf } from "./ticket-view";
import { RECENT_SCORED_TARGETS, reviewTrajectory } from "./review-trajectory";

const bead = (over: Partial<Bead> & { id: string }): Bead =>
  ({ title: over.id, status: "open", issue_type: "feature", labels: [], ...over }) as Bead;

const scored = (id: string, score: number, updated_at?: string) =>
  bead({ id, labels: [`review-score:${score}`], ...(updated_at ? { updated_at } : {}) });

describe("reviewScoreOf", () => {
  it("reads the label a review round wrote", () => {
    expect(reviewScoreOf(scored("a", 7))).toBe(7);
    expect(reviewScoreOf(scored("a", 0))).toBe(0);
    expect(reviewScoreOf(scored("a", 10))).toBe(10);
  });

  it("reports a target with no score label as unreviewed", () => {
    expect(reviewScoreOf(bead({ id: "a", labels: ["agent:nextjs"] }))).toBeUndefined();
    expect(reviewScoreOf(bead({ id: "a" }))).toBeUndefined();
  });

  it("reads a malformed label as unreviewed, never as a zero", () => {
    // Every one of these is a label a hand-edit (or a future anton) could leave on a bead. A 0 here
    // would claim the reviewer looked at the work and found nothing usable.
    for (const label of [
      "review-score:",
      "review-score:x",
      "review-score:11",
      "review-score:-1",
      "review-score:7.5",
      "review-score:7 ",
      "review-scores:7",
    ]) {
      expect(reviewScoreOf(bead({ id: "a", labels: [label] })), label).toBeUndefined();
    }
  });

  it("takes the lowest when a failed prefix-diff left two scores behind", () => {
    // The board cannot tell which of the two is current, so it must not pick the flattering one.
    expect(reviewScoreOf(bead({ id: "a", labels: ["review-score:9", "review-score:3"] }))).toBe(3);
  });
});

describe("reviewTrajectory", () => {
  it("reports nothing at all for a project no run has scored", () => {
    expect(reviewTrajectory([])).toBeUndefined();
    expect(reviewTrajectory([bead({ id: "a" }), bead({ id: "b", labels: ["risk:low"] })])).toBeUndefined();
  });

  it("averages the recent window and names the worst target in it", () => {
    const trajectory = reviewTrajectory([
      scored("a", 8, "2026-08-01T00:00:00Z"),
      scored("b", 4, "2026-08-02T00:00:00Z"),
      scored("c", 9, "2026-08-03T00:00:00Z"),
    ]);

    expect(trajectory?.recent.map((t) => t.id)).toEqual(["c", "b", "a"]); // newest first
    expect(trajectory?.average).toBe(7); // (8 + 4 + 9) / 3
    expect(trajectory?.worst).toMatchObject({ id: "b", score: 4 });
    expect(trajectory?.scored).toBe(3);
  });

  it("rounds the average to one decimal rather than pretending to precision", () => {
    expect(reviewTrajectory([scored("a", 7), scored("b", 8)])?.average).toBe(7.5);
    expect(reviewTrajectory([scored("a", 7), scored("b", 8), scored("c", 9)])?.average).toBe(8);
    expect(reviewTrajectory([scored("a", 5), scored("b", 8), scored("c", 8)])?.average).toBe(7);
  });

  it("windows to the most recent targets, and says how many were scored in all", () => {
    const many = Array.from({ length: RECENT_SCORED_TARGETS + 3 }, (_, i) =>
      // Oldest first, so the window has to sort rather than take the head of the list.
      scored(`t-${i}`, i % 11, `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
    );

    const trajectory = reviewTrajectory(many);

    expect(trajectory?.recent).toHaveLength(RECENT_SCORED_TARGETS);
    expect(trajectory?.recent[0].id).toBe(`t-${many.length - 1}`);
    expect(trajectory?.scored).toBe(many.length);
    // The dropped targets are outside the window — they can neither move the average nor be "worst".
    expect(trajectory?.recent.map((t) => t.id)).not.toContain("t-0");
  });

  it("falls back to creation time, then sorts undated targets last", () => {
    const trajectory = reviewTrajectory([
      bead({ id: "undated", labels: ["review-score:2"] }),
      bead({ id: "created", labels: ["review-score:6"], created_at: "2026-07-01T00:00:00Z" }),
      scored("updated", 9, "2026-08-01T00:00:00Z"),
    ]);

    expect(trajectory?.recent.map((t) => t.id)).toEqual(["updated", "created", "undated"]);
    expect(trajectory?.recent[0].at).toBe("2026-08-01T00:00:00Z");
    expect(trajectory?.recent[2].at).toBeUndefined();
  });

  it("ignores targets whose score label is unreadable instead of scoring them zero", () => {
    const trajectory = reviewTrajectory([
      scored("good", 8, "2026-08-02T00:00:00Z"),
      bead({ id: "broken", labels: ["review-score:not-a-number"] }),
    ]);

    expect(trajectory?.recent.map((t) => t.id)).toEqual(["good"]);
    expect(trajectory?.average).toBe(8);
    expect(trajectory?.scored).toBe(1);
  });
});
