/**
 * Unit tests for the pure PR helpers (anton-3t2.2): ref parsing, the actionable classifier, and
 * the re-request reviewer set. No `gh` — these are the decision functions the job relies on.
 */
import { describe, expect, it } from "vitest";
import {
  ANTON_MARK,
  classifyReview,
  prNumberFromRef,
  reviewersRequestingChanges,
  threadsNeedingAttention,
  type PrReview,
  type ReviewThread,
} from "./pr";

function pr(overrides: Partial<PrReview> = {}): PrReview {
  return {
    number: 7,
    state: "OPEN",
    reviewDecision: null,
    mergeable: null,
    headRefName: "anton/epic-1",
    url: "https://github.com/o/r/pull/7",
    reviews: [],
    failingChecks: [],
    pendingChecks: 0,
    threads: [],
    ...overrides,
  };
}

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: "RT_1",
    isResolved: false,
    isOutdated: false,
    path: "src/a.ts",
    line: 3,
    comments: [{ id: 100, author: "alice", body: "rename foo to bar" }],
    ...overrides,
  };
}

describe("prNumberFromRef", () => {
  it("parses gh-<n> and pull urls", () => {
    expect(prNumberFromRef("gh-123")).toBe(123);
    expect(prNumberFromRef("https://github.com/o/r/pull/45")).toBe(45);
  });
  it("returns undefined for missing / non-PR refs", () => {
    expect(prNumberFromRef(undefined)).toBeUndefined();
    expect(prNumberFromRef("some-url")).toBeUndefined();
  });
});

describe("classifyReview", () => {
  it("is actionable when changes are requested", () => {
    const v = classifyReview(pr({ reviewDecision: "CHANGES_REQUESTED" }));
    expect(v.actionable).toBe(true);
    expect(v.reasons.join()).toMatch(/changes requested/);
  });

  it("is actionable when a check is failing", () => {
    const v = classifyReview(pr({ failingChecks: ["build", "lint"] }));
    expect(v.actionable).toBe(true);
    expect(v.reasons.join()).toMatch(/build, lint/);
  });

  it("is actionable when the branch conflicts with its base", () => {
    const v = classifyReview(pr({ mergeable: "CONFLICTING" }));
    expect(v.actionable).toBe(true);
    expect(v.reasons.join()).toMatch(/merge conflicts/);
  });

  it("is actionable when an unresolved thread awaits anton (even without CHANGES_REQUESTED)", () => {
    const v = classifyReview(pr({ threads: [thread()] }));
    expect(v.actionable).toBe(true);
    expect(v.reasons.join()).toMatch(/unresolved review thread/);
  });

  it("is NOT actionable when approved / clean / only pending", () => {
    expect(classifyReview(pr({ reviewDecision: "APPROVED" })).actionable).toBe(false);
    expect(classifyReview(pr({ pendingChecks: 3 })).actionable).toBe(false);
    expect(classifyReview(pr({ mergeable: "MERGEABLE" })).actionable).toBe(false);
    expect(classifyReview(pr()).actionable).toBe(false);
  });

  it("is NOT actionable for resolved threads or threads anton already replied to", () => {
    expect(classifyReview(pr({ threads: [thread({ isResolved: true })] })).actionable).toBe(false);
    const replied = thread({
      comments: [
        { id: 100, author: "alice", body: "rename foo to bar" },
        { id: 101, author: "anton", body: `${ANTON_MARK} left as-is: churn` },
      ],
    });
    expect(classifyReview(pr({ threads: [replied] })).actionable).toBe(false);
  });

  it("is NOT actionable when the PR is not open", () => {
    const v = classifyReview(pr({ state: "MERGED", reviewDecision: "CHANGES_REQUESTED" }));
    expect(v.actionable).toBe(false);
  });
});

describe("threadsNeedingAttention", () => {
  it("keeps unresolved threads and re-activates when a human replies after anton", () => {
    const backAndForth = thread({
      id: "RT_2",
      comments: [
        { id: 1, author: "alice", body: "fix this" },
        { id: 2, author: "anton", body: `${ANTON_MARK} left as-is` },
        { id: 3, author: "alice", body: "no, really fix it" },
      ],
    });
    const p = pr({ threads: [thread(), thread({ id: "RT_3", isResolved: true }), backAndForth] });
    expect(threadsNeedingAttention(p).map((t) => t.id)).toEqual(["RT_1", "RT_2"]);
  });
});

describe("reviewersRequestingChanges", () => {
  it("returns only reviewers whose latest state is CHANGES_REQUESTED", () => {
    const p = pr({
      reviews: [
        { author: "alice", state: "CHANGES_REQUESTED", body: "fix" },
        { author: "bob", state: "APPROVED", body: "" },
      ],
    });
    expect(reviewersRequestingChanges(p)).toEqual(["alice"]);
  });

  it("uses the latest review per author (approval supersedes earlier changes)", () => {
    const p = pr({
      reviews: [
        { author: "alice", state: "CHANGES_REQUESTED", body: "fix" },
        { author: "alice", state: "APPROVED", body: "lgtm now" },
      ],
    });
    expect(reviewersRequestingChanges(p)).toEqual([]);
  });
});
