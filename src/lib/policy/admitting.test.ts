/**
 * Which criterion `Never` opens the policy editor at (anton-jqvy).
 *
 * The property under test is not "some key comes back" — it is that the key names a control the
 * operator can actually tighten to keep work like this out, and that a policy with no such control
 * says so rather than pointing at an unrelated one.
 */
import { describe, expect, it } from "vitest";
import { admittingCriterion } from "./admitting";
import type { PolicyCandidate } from "./match";
import type { Policy } from "./types";

function candidate(o: Partial<PolicyCandidate> = {}): PolicyCandidate {
  return {
    id: "anton-a",
    title: "a target",
    type: "feature",
    priority: 2,
    depth: 1,
    ageDays: 5,
    labels: ["approved", "domain:eng", "size:S"],
    ...o,
  };
}

describe("admittingCriterion", () => {
  it("prefers the repo's OWN vocabulary — the narrowest lever an operator authored", () => {
    const policy: Policy = {
      types: ["feature"],
      maxPriority: 3,
      labels: [{ namespace: "domain", values: ["eng"] }],
    };
    expect(admittingCriterion(candidate(), policy)).toBe("labels:domain");
  });

  it("falls back to the native fields, bluntest last", () => {
    expect(admittingCriterion(candidate(), { types: ["feature"], maxPriority: 3 })).toBe("types");
    expect(admittingCriterion(candidate(), { maxPriority: 3 })).toBe("priority");
    expect(admittingCriterion(candidate(), { maxParentDepth: 2 })).toBe("parentage");
    expect(admittingCriterion(candidate(), { minAgeDays: 1 })).toBe("age");
    expect(admittingCriterion(candidate(), { requireUnblocked: true })).toBe("blockers");
  });

  it("names the namespace the bead actually carries a value under", () => {
    const policy: Policy = {
      labels: [
        { namespace: "severity", values: ["high"] },
        { namespace: "domain", values: ["eng"] },
      ],
    };
    // `severity:` is asserted but this bead carries no value under it — so it did not admit it, and
    // a fail-closed criterion means nothing was admitted at all.
    expect(admittingCriterion(candidate(), policy)).toBeUndefined();
    expect(
      admittingCriterion(candidate({ labels: ["severity:high", "domain:eng"] }), policy),
    ).toBe("labels:severity");
  });

  it("has nothing to open at when the policy asserts nothing", () => {
    expect(admittingCriterion(candidate(), {})).toBeUndefined();
  });

  it("has nothing to open at when the policy REFUSES the bead — nothing let it in", () => {
    expect(admittingCriterion(candidate(), { types: ["bug"] })).toBeUndefined();
  });

  it("honours a hand-ranked bound: the criterion admits through the ranking, so it is the lever", () => {
    const policy: Policy = {
      labels: [
        {
          namespace: "size",
          values: ["S", "M", "L"],
          ranked: true,
          compare: { op: "lte", value: "M" },
        },
      ],
    };
    expect(admittingCriterion(candidate(), policy)).toBe("labels:size");
    // Outside the bound the policy refuses it, so there is no admitting criterion to open.
    expect(admittingCriterion(candidate({ labels: ["size:L"] }), policy)).toBeUndefined();
  });
});
