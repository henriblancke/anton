import { describe, expect, it } from "vitest";

import type { RoadmapRow } from "@/lib/types";
import { diffEpicPatch, draftFromRow, type EpicDraft } from "@/components/roadmap/epic-dialog";

function row(over: Partial<RoadmapRow> = {}): RoadmapRow {
  return {
    id: "e-1",
    title: "Zero-touch ingestion",
    area: "ingest",
    priority: 2,
    features: 2,
    shipped: 1,
    ...over,
  };
}

describe("draftFromRow", () => {
  it("seeds the form from the row, with a missing area as an empty field", () => {
    expect(draftFromRow(row())).toEqual({ title: "Zero-touch ingestion", priority: 2, area: "ingest" });
    expect(draftFromRow(row({ area: undefined })).area).toBe("");
  });
});

describe("diffEpicPatch", () => {
  const original: EpicDraft = { title: "Zero-touch ingestion", priority: 2, area: "ingest" };

  it("returns null when nothing changed, so no request is made", () => {
    expect(diffEpicPatch({ ...original }, original)).toBeNull();
  });

  it("sends only the fields that changed", () => {
    expect(diffEpicPatch({ ...original, priority: 0 }, original)).toEqual({ priority: 0 });
    expect(diffEpicPatch({ ...original, title: "Ingestion, zero touch" }, original)).toEqual({
      title: "Ingestion, zero touch",
    });
    expect(diffEpicPatch({ ...original, area: "runtime" }, original)).toEqual({ area: "runtime" });
  });

  it("sends every changed field together", () => {
    expect(diffEpicPatch({ title: "New", priority: 1, area: "board" }, original)).toEqual({
      title: "New",
      priority: 1,
      area: "board",
    });
  });

  it("trims before comparing, so whitespace alone is not a change", () => {
    expect(diffEpicPatch({ ...original, title: "  Zero-touch ingestion  " }, original)).toBeNull();
    expect(diffEpicPatch({ ...original, area: " ingest " }, original)).toBeNull();
  });

  it("never sends an emptied title — that would be a rejected patch, not a clear", () => {
    expect(diffEpicPatch({ ...original, title: "   " }, original)).toBeNull();
  });

  it("never sends an emptied area, because buildUpdateArgs would silently no-op it", () => {
    // Clearing a managed label prefix is not expressible through a partial patch; sending "" would
    // look like a successful clear to the user while changing nothing.
    expect(diffEpicPatch({ ...original, area: "" }, original)).toBeNull();
  });

  it("treats setting an area on an epic that had none as a change", () => {
    const noArea: EpicDraft = { title: "T", priority: 4, area: "" };
    expect(diffEpicPatch({ ...noArea, area: "platform" }, noArea)).toEqual({ area: "platform" });
  });

  it("sends P0 rather than dropping it as falsy", () => {
    const low: EpicDraft = { title: "T", priority: 4, area: "x" };
    expect(diffEpicPatch({ ...low, priority: 0 }, low)).toEqual({ priority: 0 });
  });
});
