/**
 * The policy revision the picker's freshness fence is built on. What these pin is the one property
 * the fence needs: two reads of the SAME policy digest identically however the settings blob was
 * keyed, and any edit an operator can make in the panel moves it — otherwise a plan survives a
 * policy that no longer admits its targets.
 */
import { describe, expect, it } from "vitest";
import { policyDigest, UNARMED_POLICY_DIGEST } from "./digest";
import type { Policy } from "./types";

const armed: Policy = {
  types: ["feature", "bug"],
  maxPriority: 2,
  minAgeDays: 1,
  requireUnblocked: true,
  labels: [
    { namespace: "domain", values: ["eng", "ops"] },
    { namespace: "size", values: ["S", "M", "L"], ranked: true, compare: { op: "lte", value: "M" } },
  ],
};

describe("policyDigest", () => {
  it("says an unarmed project is unarmed, not an empty policy", () => {
    expect(policyDigest()).toBe(UNARMED_POLICY_DIGEST);
    expect(policyDigest({})).not.toBe(UNARMED_POLICY_DIGEST);
  });

  it("holds still across the same policy written in another order", () => {
    const reordered: Policy = {
      requireUnblocked: true,
      labels: [armed.labels![1], armed.labels![0]],
      minAgeDays: 1,
      types: ["bug", "feature"],
      maxPriority: 2,
    };

    expect(policyDigest(reordered)).toBe(policyDigest(armed));
  });

  it.each<[string, Policy]>([
    ["a narrower type set", { ...armed, types: ["feature"] }],
    ["a priority floor", { ...armed, maxPriority: 1 }],
    ["a priority ceiling", { ...armed, minPriority: 1 }],
    ["a parentage bound", { ...armed, maxParentDepth: 0 }],
    ["a soak", { ...armed, minAgeDays: 3 }],
    ["a staleness ceiling", { ...armed, maxAgeDays: 90 }],
    ["the blocker rule", { ...armed, requireUnblocked: false }],
    ["a namespace criterion dropped", { ...armed, labels: [armed.labels![0]] }],
    [
      "a value removed from a criterion",
      { ...armed, labels: [{ namespace: "domain", values: ["eng"] }, armed.labels![1]] },
    ],
    [
      "the bound moved on a hand-ranked scale",
      {
        ...armed,
        labels: [
          armed.labels![0],
          { ...armed.labels![1], compare: { op: "lte" as const, value: "L" } },
        ],
      },
    ],
  ])("moves when the operator saves %s", (_what, edited) => {
    expect(policyDigest(edited)).not.toBe(policyDigest(armed));
  });

  it("moves when a hand-ranked scale is reordered — the order is what it admits", () => {
    const rescaled: Policy = {
      ...armed,
      labels: [armed.labels![0], { ...armed.labels![1], values: ["L", "M", "S"] }],
    };

    expect(policyDigest(rescaled)).not.toBe(policyDigest(armed));
  });

  it("holds still when an UNranked criterion's values arrive in another order", () => {
    const shuffled: Policy = {
      ...armed,
      labels: [{ namespace: "domain", values: ["ops", "eng"] }, armed.labels![1]],
    };

    expect(policyDigest(shuffled)).toBe(policyDigest(armed));
  });

  it("keeps an absent bound distinct from one asserted at zero", () => {
    expect(policyDigest({ maxParentDepth: 0 })).not.toBe(policyDigest({}));
  });

  // Every value in a policy is a string off the operator's own board, so no separator this digest
  // picks is unavailable to them — and two policies that admit different labels must never agree
  // (PR #212 review).
  it.each<[string, Policy, Policy]>([
    [
      "a value containing the value separator",
      { labels: [{ namespace: "domain", values: ["a,b"] }] },
      { labels: [{ namespace: "domain", values: ["a", "b"] }] },
    ],
    [
      "a type containing the value separator",
      { types: ["a,b"] },
      { types: ["a", "b"] },
    ],
    [
      "a namespace containing the field separators",
      { labels: [{ namespace: "domain=eng/", values: [] }] },
      { labels: [{ namespace: "domain", values: ["eng"] }] },
    ],
  ])("does not collide on %s", (_what, left, right) => {
    expect(policyDigest(left)).not.toBe(policyDigest(right));
  });
});
