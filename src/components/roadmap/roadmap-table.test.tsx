import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { RoadmapRow } from "@/lib/types";
import { RoadmapTable } from "@/components/roadmap/roadmap-table";

function makeRow(over: Partial<RoadmapRow> = {}): RoadmapRow {
  return {
    id: "e-1",
    title: "Zero-touch ingestion",
    area: "ingest",
    features: 2,
    shipped: 1,
    linearRef: "LIB-124",
    ...over,
  };
}

describe("RoadmapTable", () => {
  it("renders a row per epic with its area, rollup counts and Linear ref", () => {
    const html = renderToStaticMarkup(<RoadmapTable slug="acme" rows={[makeRow()]} />);

    expect(html).toContain("Zero-touch ingestion");
    expect(html).toContain("area:ingest");
    expect(html).toContain("1 / 2");
    expect(html).toContain("LIB-124");
  });

  it("links each row through to the board filtered to that epic", () => {
    const html = renderToStaticMarkup(
      <RoadmapTable slug="acme" rows={[makeRow({ id: "anton-9pkk" })]} />,
    );

    expect(html).toContain('href="/projects/acme?epic=anton-9pkk"');
  });

  it("reads not synced, needs area: for an epic with no engine designator", () => {
    const html = renderToStaticMarkup(
      <RoadmapTable slug="acme" rows={[makeRow({ area: undefined, linearRef: undefined })]} />,
    );

    expect(html).toContain("no area");
    expect(html).toContain("not synced — needs area:");
  });

  it("says only not synced when the epic is routable but has not been pushed", () => {
    const html = renderToStaticMarkup(
      <RoadmapTable slug="acme" rows={[makeRow({ linearRef: undefined })]} />,
    );

    expect(html).toContain("not synced");
    expect(html).not.toContain("needs area:");
  });

  it("links a Linear ref only when it is a URL — an identifier has no workspace to guess", () => {
    const url = "https://linear.app/acme/issue/LIB-124";
    const linked = renderToStaticMarkup(
      <RoadmapTable slug="acme" rows={[makeRow({ linearRef: url })]} />,
    );
    const plain = renderToStaticMarkup(<RoadmapTable slug="acme" rows={[makeRow()]} />);

    expect(linked).toContain(`href="${url}"`);
    expect(plain).not.toContain("<a href=\"LIB-124\"");
  });

  it("shows a dash rather than 0 / 0 for an epic with no features yet", () => {
    const html = renderToStaticMarkup(
      <RoadmapTable slug="acme" rows={[makeRow({ features: 0, shipped: 0 })]} />,
    );

    expect(html).not.toContain("0 / 0");
    expect(html).toContain("—");
  });

  it("renders an actionable empty state instead of a headless table for an empty board", () => {
    const html = renderToStaticMarkup(<RoadmapTable slug="acme" rows={[]} />);

    expect(html).not.toContain("<table");
    expect(html).toContain("No epics yet");
    expect(html).toContain("area:");
    expect(html).toContain('href="/projects/acme"');
  });
});
