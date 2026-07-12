/**
 * Unit tests for the pure PR helpers (anton-3t2.2): ref parsing, the actionable classifier, and
 * the re-request reviewer set. No `gh` — these are the decision functions the job relies on.
 */
import { describe, expect, it } from "vitest";
import {
  classifyReview,
  prNumberFromRef,
  reviewersRequestingChanges,
  type PrReview,
} from "./pr";

function pr(overrides: Partial<PrReview> = {}): PrReview {
  return {
    number: 7,
    state: "OPEN",
    reviewDecision: null,
    headRefName: "anton/epic-1",
    url: "https://github.com/o/r/pull/7",
    reviews: [],
    failingChecks: [],
    pendingChecks: 0,
    comments: [],
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

  it("is NOT actionable when approved / clean / only pending", () => {
    expect(classifyReview(pr({ reviewDecision: "APPROVED" })).actionable).toBe(false);
    expect(classifyReview(pr({ pendingChecks: 3 })).actionable).toBe(false);
    expect(classifyReview(pr()).actionable).toBe(false);
  });

  it("is NOT actionable when the PR is not open", () => {
    const v = classifyReview(pr({ state: "MERGED", reviewDecision: "CHANGES_REQUESTED" }));
    expect(v.actionable).toBe(false);
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
