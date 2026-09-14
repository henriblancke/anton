import { describe, expect, it } from "vitest";

import { buildShapeArgs, buildShapeSystemPrompt, SHAPE_UI_FRAMING } from "./shape";

describe("buildShapeSystemPrompt", () => {
  it("puts the UI framing first, then the skill body", () => {
    const prompt = buildShapeSystemPrompt("SKILL BODY");
    expect(prompt.startsWith(SHAPE_UI_FRAMING)).toBe(true);
    expect(prompt.endsWith("SKILL BODY")).toBe(true);
    expect(prompt.indexOf(SHAPE_UI_FRAMING)).toBeLessThan(prompt.indexOf("SKILL BODY"));
  });

  it("tells the assistant not to create beads itself", () => {
    expect(buildShapeSystemPrompt("x").toLowerCase()).toContain("do not run `bd`".toLowerCase());
  });
});

describe("SHAPE_UI_FRAMING", () => {
  // The framing leads the prompt, so it outranks the skill body: while it described the panel as
  // committing an epic, the UI producer and the /shape CLI producer disagreed about what a run
  // target is (anton-h1ds).
  it("frames the draft as a feature under an epic, the tier anton runs", () => {
    expect(SHAPE_UI_FRAMING).toContain("**feature**");
    expect(SHAPE_UI_FRAMING).toContain("**epic**");
    expect(SHAPE_UI_FRAMING).toContain("one reviewable PR");
    expect(SHAPE_UI_FRAMING).not.toMatch(/draft epic|single-PR-scoped epic/i);
  });

  it("names every section the panel commits, so the assistant proposes text for each", () => {
    for (const field of ["Goal", "Acceptance criteria", "Context", "Out of scope", "Verify"]) {
      expect(SHAPE_UI_FRAMING).toContain(`**${field}**`);
    }
  });

  it("refuses a parentless feature rather than inventing an epic to silence the question", () => {
    expect(SHAPE_UI_FRAMING).toContain("Never leave the feature without an epic");
    expect(SHAPE_UI_FRAMING).toContain("one-feature epic");
  });
});

describe("buildShapeArgs", () => {
  it("seeds the skill via --append-system-prompt", () => {
    const args = buildShapeArgs("SKILL BODY");
    expect(args[0]).toBe("--append-system-prompt");
    expect(args[1]).toContain("SKILL BODY");
    expect(args).toHaveLength(2);
  });

  it("appends the description as the initial message when present", () => {
    const args = buildShapeArgs("SKILL", "  build a thing  ");
    expect(args).toHaveLength(3);
    expect(args[2]).toBe("build a thing");
  });

  it("omits an empty/whitespace description", () => {
    expect(buildShapeArgs("SKILL", "   ")).toHaveLength(2);
    expect(buildShapeArgs("SKILL")).toHaveLength(2);
  });
});
