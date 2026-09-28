import { describe, expect, it } from "vitest";
import { parseOutcomes } from "./outcomes";

describe("parseOutcomes", () => {
  it("parses `id` — summary bullets under ## Outcomes", () => {
    const markdown = [
      "# PRODUCT",
      "",
      "## Outcomes",
      "- `no-touch-delivery` — Approved epics reach a merge-ready PR untouched.",
      "- `trustworthy-board` — Stage is always derived live from beads.",
      "",
      "## Stack",
      "Next.js.",
    ].join("\n");

    const outcomes = parseOutcomes(markdown);

    expect(outcomes).toEqual([
      expect.objectContaining({ id: "codebase-health", retired: false }),
      { id: "no-touch-delivery", summary: "Approved epics reach a merge-ready PR untouched.", retired: false },
      { id: "trustworthy-board", summary: "Stage is always derived live from beads.", retired: false },
    ]);
  });

  it("stops the section at the next heading of any level", () => {
    const markdown = ["## Outcomes", "- `a` — first", "# Not part of it", "- `b` — second"].join("\n");

    expect(parseOutcomes(markdown).map((o) => o.id)).toEqual(["codebase-health", "a"]);
  });

  it("always includes the built-in codebase-health outcome even when the file omits it", () => {
    const markdown = ["## Outcomes", "- `oriented-operator` — Every run target says why it exists."].join("\n");

    const outcomes = parseOutcomes(markdown);

    expect(outcomes.find((o) => o.id === "codebase-health")).toEqual({
      id: "codebase-health",
      summary: expect.any(String),
      retired: false,
    });
  });

  it("returns only the built-in outcome when the section is missing, and never throws", () => {
    const markdown = "# PRODUCT\n\nNo outcomes here.\n";

    expect(parseOutcomes(markdown)).toEqual([expect.objectContaining({ id: "codebase-health" })]);
    expect(() => parseOutcomes("")).not.toThrow();
    expect(parseOutcomes("").map((o) => o.id)).toEqual(["codebase-health"]);
  });

  it("marks a bullet retired and strips the marker from the summary", () => {
    const markdown = ["## Outcomes", "- `old-outcome` — No longer tracked (retired)."].join("\n");

    const outcome = parseOutcomes(markdown).find((o) => o.id === "old-outcome");

    expect(outcome).toEqual({ id: "old-outcome", summary: "No longer tracked", retired: true });
  });

  it("is case-insensitive on the retired marker", () => {
    const markdown = ["## Outcomes", "- `old` — done (Retired)"].join("\n");

    expect(parseOutcomes(markdown).find((o) => o.id === "old")).toEqual({
      id: "old",
      summary: "done",
      retired: true,
    });
  });

  it("skips malformed bullets rather than throwing", () => {
    const markdown = [
      "## Outcomes",
      "- missing backticks and dash",
      "- `no-em-dash` - uses a hyphen instead of an em dash",
      "- `empty-summary` — ",
      "not a bullet at all",
      "- `valid` — This one parses.",
    ].join("\n");

    expect(parseOutcomes(markdown)).toEqual([
      expect.objectContaining({ id: "codebase-health" }),
      { id: "valid", summary: "This one parses.", retired: false },
    ]);
  });

  it("lets a later bullet override the built-in codebase-health entry", () => {
    const markdown = ["## Outcomes", "- `codebase-health` — Custom summary for this project."].join("\n");

    expect(parseOutcomes(markdown)).toEqual([
      { id: "codebase-health", summary: "Custom summary for this project.", retired: false },
    ]);
  });
});
