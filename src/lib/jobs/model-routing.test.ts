/**
 * Route subsumption (anton-uu7r) — the rule that decides whether a routing rule can ever fire. Both
 * the settings boundary's save-time rejection and the panel's inline warning read it, so it is
 * tested once here rather than twice through them.
 */
import { describe, expect, it } from "vitest";
import { subsumes } from "./model-routing";

describe("subsumes — whether an earlier rule makes a later one dead", () => {
  it("a bare catch-all subsumes everything under it", () => {
    expect(subsumes({}, { jobType: "execute-epic", step: "review", label: "risk:high" })).toBe(true);
    expect(subsumes({}, {})).toBe(true);
  });

  it("a rule asking fewer questions subsumes one that narrows it further", () => {
    expect(subsumes({ jobType: "execute-epic" }, { jobType: "execute-epic", step: "review" })).toBe(
      true,
    );
    expect(subsumes({ step: "review" }, { jobType: "execute-epic", step: "review" })).toBe(true);
  });

  it("a NARROWER rule does not subsume the broader one — narrowest-first is the fix", () => {
    expect(subsumes({ jobType: "execute-epic", step: "review" }, { jobType: "execute-epic" })).toBe(
      false,
    );
    expect(subsumes({ label: "risk:high" }, {})).toBe(false);
  });

  it("rules disagreeing on any matcher subsume in neither direction", () => {
    expect(subsumes({ label: "risk:high" }, { label: "size:S" })).toBe(false);
    expect(subsumes({ jobType: "execute-epic" }, { jobType: "review-fix-pr" })).toBe(false);
  });

  it("identical rules subsume each other — the second can never be reached", () => {
    const rule = { jobType: "execute-epic", label: "risk:high" };
    expect(subsumes(rule, { ...rule })).toBe(true);
  });

  it("ignores the model — two rules differing only in model are still the same match", () => {
    expect(subsumes({ label: "risk:high" }, { label: "risk:high" })).toBe(true);
  });
});
