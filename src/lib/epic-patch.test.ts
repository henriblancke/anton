import { describe, expect, it } from "vitest";
import { parseEpicPatch } from "./epic-patch";

describe("parseEpicPatch", () => {
  describe("priority", () => {
    it("accepts the integer range 0-4", () => {
      for (const priority of [0, 1, 2, 3, 4]) {
        expect(parseEpicPatch({ priority })).toEqual({ patch: { priority } });
      }
    });

    it("rejects out-of-range, non-integer, or non-number priorities", () => {
      for (const priority of [-1, 5, 1.5, "2", null]) {
        expect(parseEpicPatch({ priority })).toEqual({
          error: `Invalid priority: ${String(priority)} (expected integer 0-4)`,
        });
      }
    });
  });

  it("rejects an unknown field", () => {
    expect(parseEpicPatch({ priority: 1, title: "New" })).toEqual({ error: "Unknown field: title" });
  });

  it("rejects an unknown field before validating priority's value", () => {
    // A bad known value must not mask an unknown key — the unknown check runs first.
    expect(parseEpicPatch({ priority: 9, surprise: 1 })).toEqual({
      error: "Unknown field: surprise",
    });
  });

  it("rejects non-object bodies with a single message", () => {
    for (const body of [null, [1], "x", 42, true, undefined]) {
      expect(parseEpicPatch(body)).toEqual({ error: "Body must be a JSON object" });
    }
  });

  it("treats an empty patch as valid (no-op)", () => {
    expect(parseEpicPatch({})).toEqual({ patch: {} });
  });
});
