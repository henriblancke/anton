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

  describe("title", () => {
    it("accepts a non-empty title", () => {
      expect(parseEpicPatch({ title: "Reports are shareable" })).toEqual({
        patch: { title: "Reports are shareable" },
      });
    });

    it("rejects an empty or blank title rather than clearing the outcome's name", () => {
      for (const title of ["", "   ", 42, null]) {
        expect(parseEpicPatch({ title })).toEqual({
          error: "title must be a non-empty string",
        });
      }
    });
  });

  describe("area", () => {
    it("folds a label-safe area into the managed label prefix", () => {
      expect(parseEpicPatch({ area: "board" })).toEqual({ patch: { labels: { area: "board" } } });
      expect(parseEpicPatch({ area: "data-plane_v2.1" })).toEqual({
        patch: { labels: { area: "data-plane_v2.1" } },
      });
    });

    it("accepts any VALUE — the vocabulary is open and anton never validates which surfaces exist", () => {
      expect(parseEpicPatch({ area: "somethingNobodyHasUsedBefore" })).toEqual({
        patch: { labels: { area: "somethingNobodyHasUsedBefore" } },
      });
    });

    it("rejects a value that would not round-trip through the area:<value> label", () => {
      for (const area of ["two words", "has:colon", "", "-leading", 7, null]) {
        expect(parseEpicPatch({ area })).toEqual({
          error: `Invalid area: ${String(area)} (expected a label-safe value — letters, digits, . _ -)`,
        });
      }
    });
  });

  it("accepts all three fields at once", () => {
    expect(parseEpicPatch({ title: "New name", priority: 0, area: "runtime" })).toEqual({
      patch: { title: "New name", priority: 0, labels: { area: "runtime" } },
    });
  });

  it("rejects a field the epic contract does not own", () => {
    // status is derived from an epic's features, and the outcome/success criteria are shaped —
    // neither is editable from the roadmap dialog.
    expect(parseEpicPatch({ priority: 1, status: "closed" })).toEqual({
      error: "Unknown field: status",
    });
    expect(parseEpicPatch({ description: "x" })).toEqual({ error: "Unknown field: description" });
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
