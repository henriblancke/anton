/**
 * The Add-work submit gate (anton-8mnr). It exists so the epic that lands is contract-shaped by
 * construction — these pin the four fields it insists on and the label shape it accepts.
 */
import { describe, expect, it } from "vitest";

import { canSubmitDraft, draftGaps, isAreaValid, submitHint } from "./shape-draft";

const FULL = {
  title: "Reports are shareable outside the app",
  goal: "Every report view leaves the app in a format a customer can open.",
  successCriteria: "- [ ] every report view exports",
  area: "reports",
};

describe("draftGaps", () => {
  it("is empty once the whole epic contract is filled", () => {
    expect(draftGaps(FULL)).toEqual([]);
    expect(canSubmitDraft(FULL)).toBe(true);
  });

  it("names each missing piece the way the panel labels it", () => {
    expect(draftGaps({ title: "", goal: "", successCriteria: "", area: "" })).toEqual([
      "a title",
      "an outcome",
      "success criteria",
      "an area",
    ]);
  });

  it("treats whitespace as missing — the contract needs content, not a filled-looking box", () => {
    expect(draftGaps({ ...FULL, successCriteria: "   " })).toEqual(["success criteria"]);
    expect(canSubmitDraft({ ...FULL, area: "  " })).toBe(false);
  });
});

describe("isAreaValid", () => {
  it("accepts label-safe surfaces and the not-yet-typed empty state", () => {
    for (const area of ["reports", "billing.core", "data_ingest", "v2-api", ""]) {
      expect(isAreaValid(area), area).toBe(true);
    }
  });

  it("rejects values bd could not round-trip through area:<value>", () => {
    for (const area of ["two words", "area:reports", "-leading"]) {
      expect(isAreaValid(area), area).toBe(false);
    }
  });

  // A malformed area is a validation error, not a missing field: the panel must say WHY, not just
  // stay disabled with the gap list empty.
  it("blocks submit without adding a gap", () => {
    const draft = { ...FULL, area: "two words" };
    expect(draftGaps(draft)).toEqual([]);
    expect(canSubmitDraft(draft)).toBe(false);
  });
});

describe("submitHint", () => {
  it("names the gaps while any field is empty", () => {
    expect(submitHint(["an outcome", "an area"], true)).toBe("Needs an outcome, an area");
  });

  it("explains a malformed area, which is a gap-less refusal", () => {
    expect(submitHint([], false)).toContain("label-safe");
  });

  it("reads as ready once the draft is complete", () => {
    expect(submitHint([], true)).toContain("unapproved");
  });
});
