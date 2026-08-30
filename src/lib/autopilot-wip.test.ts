/**
 * The WIP hold's rules (anton-wy9y / R4.2). The boundary is the whole test: N-1 PRs still start
 * work, N holds — and the copy is pinned, because a flow limit that reads as a fault is the one way
 * this feature can do damage.
 */
import { describe, expect, it } from "vitest";
import {
  describeWipHold,
  detectWipHold,
  toAutopilotHold,
  type ReviewSlot,
} from "./autopilot-wip";
import { BREAKER_REASON_LABEL, clearingCondition } from "./autopilot-breaker";

/** `n` PRs in review, numbered from 100. */
function slots(n: number): ReviewSlot[] {
  return Array.from({ length: n }, (_, i) => ({ beadId: `anton-${i}`, prNumber: 100 + i }));
}

describe("detectWipHold", () => {
  it("does not hold one PR short of the limit", () => {
    expect(detectWipHold(slots(2), { limit: 3 })).toBeUndefined();
  });

  it("holds at the limit", () => {
    expect(detectWipHold(slots(3), { limit: 3 })?.slots).toHaveLength(3);
  });

  it("holds past the limit — a queue that ran over is still a full queue", () => {
    expect(detectWipHold(slots(5), { limit: 3 })?.slots).toHaveLength(5);
  });

  it("carries the caller's truncation, so a bounded sample is never read as a total", () => {
    expect(detectWipHold(slots(3), { limit: 3 }, true)?.truncated).toBe(true);
    expect(detectWipHold(slots(3), { limit: 3 })?.truncated).toBeUndefined();
  });

  it("never holds an empty review queue, whatever the limit", () => {
    expect(detectWipHold([], { limit: 1 })).toBeUndefined();
  });

  it("stays off when the operator turned it off with a limit of 0", () => {
    expect(detectWipHold(slots(9), { limit: 0 })).toBeUndefined();
  });

  it("stays off when no limit resolves at all", () => {
    expect(detectWipHold(slots(9), undefined)).toBeUndefined();
  });

  it("orders the slots by PR number, so two passes over one queue read identically", () => {
    const hold = detectWipHold(
      [
        { beadId: "c", prNumber: 30 },
        { beadId: "a", prNumber: 10 },
        { beadId: "b", prNumber: 20 },
      ],
      { limit: 3 },
    );
    expect(hold?.slots.map((s) => s.prNumber)).toEqual([10, 20, 30]);
  });
});

describe("describeWipHold", () => {
  it("names the count, the limit and the PRs", () => {
    expect(describeWipHold(detectWipHold(slots(3), { limit: 3 })!)).toBe(
      "3 open PRs are waiting on review — this project pauses new work at 3 (#100, #101, #102)",
    );
  });

  it("reads correctly when the queue is OVER the limit", () => {
    // A merge gate that resolves slower than runs finish can leave more PRs open than the limit.
    // "4 of 3" would read as a bug in anton rather than as the count it is.
    expect(describeWipHold(detectWipHold(slots(4), { limit: 3 })!)).toBe(
      "4 open PRs are waiting on review — this project pauses new work at 3 (#100, #101, #102, #103)",
    );
  });

  it("says AT LEAST when the sample stopped short of the whole queue", () => {
    // The confirmation stops at the limit, so a fourteen-PR backlog arrives here as four slots.
    // Naming four would misdescribe the operator's own queue back to them.
    expect(describeWipHold(detectWipHold(slots(4), { limit: 3 }, true)!)).toBe(
      "at least 4 open PRs are waiting on review — this project pauses new work at 3 (#100, #101, #102, #103)",
    );
  });

  it("agrees with itself in the singular", () => {
    expect(describeWipHold(detectWipHold(slots(1), { limit: 1 })!)).toBe(
      "1 open PR is waiting on review — this project pauses new work at 1 (#100)",
    );
  });
});

describe("toAutopilotHold", () => {
  it("is a HOLD — self-clearing, and never phrased as a failure", () => {
    const breaker = toAutopilotHold(detectWipHold(slots(3), { limit: 3 })!);

    expect(breaker.kind).toBe("hold");
    expect(breaker.reason).toBe("wip-limit");
    // The two sentences the operator actually acts on: the band says a limit is being respected and
    // promises the release needs nothing from them.
    expect(BREAKER_REASON_LABEL[breaker.reason]).toBe("Review queue is full");
    expect(clearingCondition(breaker)).toContain("Releases itself when one PR merges or closes");
    expect(breaker.detail).not.toMatch(/error|fail|broke/i);
  });
});
