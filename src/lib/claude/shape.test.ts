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
