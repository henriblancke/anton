/**
 * Route subsumption (anton-uu7r) — the rule that decides whether a routing rule can ever fire. Both
 * the settings boundary's save-time rejection and the panel's inline warning read it, so it is
 * tested once here rather than twice through them.
 */
import { describe, expect, it } from "vitest";
import { resolveModel, subsumes } from "./model-routing";

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

describe("resolveModel", () => {
  const settings = {
    model: "fallback",
    modelRoutes: [
      { jobType: "execute-epic" as const, step: "review" as const, model: "strong" },
      { label: "risk:high", model: "safe" },
      { jobType: "nightly-stringer" as const, model: "cheap" },
    ],
  };

  it("uses the first matching job, step, and label rule", () => {
    expect(resolveModel(settings, { jobType: "execute-epic", step: "review", labels: ["risk:high"] })).toBe("strong");
    expect(resolveModel(settings, { jobType: "execute-epic", step: "implement", labels: ["risk:high"] })).toBe("safe");
    expect(resolveModel(settings, { jobType: "nightly-stringer" })).toBe("cheap");
  });

  it("falls back byte-for-byte when no rule matches or the table is absent", () => {
    expect(resolveModel(settings, { jobType: "product-master" })).toBe("fallback");
    expect(resolveModel({ model: "fallback" }, { jobType: "execute-epic", step: "review" })).toBe("fallback");
    expect(resolveModel({}, { jobType: "execute-epic" })).toBeUndefined();
  });
});
