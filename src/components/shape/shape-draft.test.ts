/**
 * The Add-work submit gate (anton-8mnr, anton-h1ds). It exists so what lands is a contract-shaped
 * `feature` under an epic — these pin the sections it insists on, the epic it refuses to go without,
 * and the label shape it accepts for a new epic's area.
 */
import { describe, expect, it } from "vitest";

import {
  canSubmitDraft,
  draftAreaValid,
  draftBody,
  draftGaps,
  isAreaValid,
  NEW_EPIC,
  submitHint,
  type ShapeDraftFields,
} from "./shape-draft";

const FEATURE = {
  title: "Export a report view to CSV",
  goal: "A customer can take a report out of the app as CSV.",
  acceptance: "- [ ] every report view has a working CSV export button",
  context: "touches: src/app/reports; follow src/lib/export.ts",
  outOfScope: "- PDF export",
  verify: "unit test on the serializer",
};

const EPIC = {
  title: "Reports are shareable outside the app",
  goal: "Every report view leaves the app in a format a customer can open.",
  successCriteria: "- [ ] every report view exports",
  area: "reports",
};

const EMPTY_EPIC = { title: "", goal: "", successCriteria: "", area: "" };

/** A draft attached to an epic already on the board — the common case. */
const FULL: ShapeDraftFields = { feature: FEATURE, epicId: "anton-1", epic: EMPTY_EPIC };
/** The same feature, shaping its own epic in the panel. */
const FULL_NEW_EPIC: ShapeDraftFields = { feature: FEATURE, epicId: NEW_EPIC, epic: EPIC };

describe("draftGaps", () => {
  it("is empty once the feature contract is filled and an epic is chosen", () => {
    expect(draftGaps(FULL)).toEqual([]);
    expect(canSubmitDraft(FULL)).toBe(true);
  });

  it("is empty for a draft that shapes its own epic", () => {
    expect(draftGaps(FULL_NEW_EPIC)).toEqual([]);
    expect(canSubmitDraft(FULL_NEW_EPIC)).toBe(true);
  });

  // The gap this ticket exists to close: without an epic the feature would land parentless, so it
  // is a gap like any missing section — not something the route discovers after the click.
  it("names the missing epic first, before the feature's own sections", () => {
    expect(draftGaps({ ...FULL, epicId: "" })).toEqual(["an epic"]);
    expect(canSubmitDraft({ ...FULL, epicId: "" })).toBe(false);
  });

  it("names each missing piece the way the panel labels it", () => {
    expect(
      draftGaps({
        feature: { title: "", goal: "", acceptance: "", context: "", outOfScope: "", verify: "" },
        epicId: "anton-1",
        epic: EMPTY_EPIC,
      }),
    ).toEqual(["a title", "a goal", "acceptance criteria", "context", "out of scope", "verify"]);
  });

  it("asks for the new epic's own contract only while one is being created", () => {
    expect(draftGaps({ ...FULL, epicId: NEW_EPIC, epic: EMPTY_EPIC })).toEqual([
      "an epic title",
      "an epic outcome",
      "epic success criteria",
      "an area",
    ]);
    // Picking an existing epic drops those — the panel no longer collects them.
    expect(draftGaps({ ...FULL, epic: EMPTY_EPIC })).toEqual([]);
  });

  it("treats whitespace as missing — the contract needs content, not a filled-looking box", () => {
    expect(draftGaps({ ...FULL, feature: { ...FEATURE, verify: "   " } })).toEqual(["verify"]);
    expect(canSubmitDraft({ ...FULL, epicId: "  " })).toBe(false);
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
    const draft = { ...FULL_NEW_EPIC, epic: { ...EPIC, area: "two words" } };
    expect(draftGaps(draft)).toEqual([]);
    expect(canSubmitDraft(draft)).toBe(false);
  });

  // An area typed for a new epic and then abandoned for an existing one is never sent, so it must
  // not keep Send disabled forever.
  it("is not judged at all once an existing epic is chosen", () => {
    expect(draftAreaValid({ ...FULL, epic: { ...EPIC, area: "two words" } })).toBe(true);
  });
});

describe("submitHint", () => {
  it("names the gaps while any field is empty", () => {
    expect(submitHint(["a goal", "verify"], true)).toBe("Needs a goal, verify");
  });

  it("clips a long list — the footer is one line, not the whole checklist", () => {
    expect(submitHint(["an epic", "a title", "a goal", "context", "verify"], true)).toBe(
      "Needs an epic, a title, a goal + 2 more",
    );
  });

  it("explains a malformed area, which is a gap-less refusal", () => {
    expect(submitHint([], false)).toContain("label-safe");
  });

  it("reads as ready once the draft is complete", () => {
    expect(submitHint([], true)).toContain("feature");
    expect(submitHint([], true)).toContain("unapproved");
  });
});

describe("draftBody", () => {
  it("sends the trimmed feature and the epic it attaches to", () => {
    expect(
      draftBody({
        ...FULL,
        feature: { ...FEATURE, goal: `  ${FEATURE.goal}  ` },
        epicId: " anton-1 ",
      }),
    ).toEqual({ feature: FEATURE, epic: { kind: "existing", id: "anton-1" } });
  });

  it("sends the new epic's contract instead when the panel is creating one", () => {
    expect(draftBody({ ...FULL_NEW_EPIC, epic: { ...EPIC, area: " reports " } })).toEqual({
      feature: FEATURE,
      epic: { kind: "new", epic: EPIC },
    });
  });
});
