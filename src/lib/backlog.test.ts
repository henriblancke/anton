import { describe, expect, it } from "vitest";

import { buildEpicDescription } from "./backlog";

describe("buildEpicDescription", () => {
  it("emits a ## Goal section the board can parse", () => {
    expect(buildEpicDescription({ title: "T", goal: "Ship the thing" })).toBe(
      "## Goal\nShip the thing",
    );
  });

  it("trims the goal", () => {
    expect(buildEpicDescription({ title: "T", goal: "  Ship it  " })).toBe("## Goal\nShip it");
  });

  it("returns undefined for a missing/blank goal (title-only epic)", () => {
    expect(buildEpicDescription({ title: "T" })).toBeUndefined();
    expect(buildEpicDescription({ title: "T", goal: "   " })).toBeUndefined();
  });
});
