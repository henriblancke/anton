import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { RoadmapRow } from "@/lib/types";
import { RoadmapTable } from "@/components/roadmap/roadmap-table";

// The table is a Server Component, but its per-row edit button is a client island that calls
// useRouter — which throws "expected app router to be mounted" outside a real App Router tree.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

function makeRow(over: Partial<RoadmapRow> = {}): RoadmapRow {
  return {
    id: "e-1",
    title: "Zero-touch ingestion",
    area: "ingest",
    priority: 2,
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

  it("shows each epic's priority in its own column", () => {
    const html = renderToStaticMarkup(
      <RoadmapTable slug="acme" rows={[makeRow({ priority: 0 })]} />,
    );

    expect(html).toContain("Priority");
    expect(html).toContain("P0");
    expect(html).toContain("P0 · critical"); // the title attribute spells the level out
  });

  it("renders an unprioritised epic as P4 rather than a blank cell", () => {
    // buildRoadmap defaults a missing bead priority to 4, so the column always has a value.
    const html = renderToStaticMarkup(
      <RoadmapTable slug="acme" rows={[makeRow({ priority: 4 })]} />,
    );

    expect(html).toContain("P4");
  });

  it("gives every row an edit control labelled with its epic", () => {
    const html = renderToStaticMarkup(
      <RoadmapTable slug="acme" rows={[makeRow({ title: "Zero-touch ingestion" })]} />,
    );

    expect(html).toContain('aria-label="Edit Zero-touch ingestion"');
  });

  it("keeps the title link pointing at the board, not the edit dialog", () => {
    // The row has two distinct affordances: the title navigates, the pencil edits. Collapsing them
    // would nest a button inside a link and cost the board-filter shortcut.
    const html = renderToStaticMarkup(<RoadmapTable slug="acme" rows={[makeRow()]} />);

    expect(html).toContain('href="/projects/acme?epic=e-1"');
    expect(html).toContain("aria-label=\"Edit Zero-touch ingestion\"");
  });

  it("renders an actionable empty state instead of a headless table for an empty board", () => {
    const html = renderToStaticMarkup(<RoadmapTable slug="acme" rows={[]} />);

    expect(html).not.toContain("<table");
    expect(html).toContain("No epics yet");
    expect(html).toContain("area:");
    expect(html).toContain('href="/projects/acme"');
  });
});
