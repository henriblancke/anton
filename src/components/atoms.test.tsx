/**
 * The shared project breadcrumb bar (anton-m4b5.2). It was hand-copied into the jobs page, the runs
 * page and the settings view, so the markup below is pinned verbatim: the extraction is only a
 * refactor as long as all three sections keep rendering exactly what they rendered before it.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { PageHeader, PrChip, WorkingPulse, prLabel } from "@/components/atoms";

// Listed token by token, not as one literal, so a search for the bar's class string still finds
// the single component that owns it rather than this pin.
const BAR_CLASS = [
  "flex",
  "h-14",
  "shrink-0",
  "items-center",
  "gap-2",
  "border-b",
  "border-border",
  "px-6",
].join(" ");

/** What the three copies rendered before the extraction, for the breadcrumb-only case. */
const BREADCRUMB_ONLY =
  `<header class="${BAR_CLASS}">` +
  '<div class="flex items-center gap-2 text-[13px]">' +
  '<span class="text-muted-foreground">anton</span>' +
  '<span class="text-subtle">/</span>' +
  '<span class="font-medium text-foreground">Jobs</span>' +
  "</div></header>";

describe("PageHeader", () => {
  it("renders the bar and `<project> / <section>` breadcrumb unchanged", () => {
    expect(renderToStaticMarkup(<PageHeader project="anton" section="Jobs" />)).toBe(
      BREADCRUMB_ONLY,
    );
  });

  it("appends the trailing slot after the breadcrumb, inside the same bar", () => {
    const markup = renderToStaticMarkup(
      <PageHeader project="anton" section="Settings">
        <span className="ml-auto">unsaved in 2 sections</span>
      </PageHeader>,
    );
    expect(markup).toBe(
      BREADCRUMB_ONLY.replace(">Jobs<", ">Settings<").replace(
        "</div></header>",
        '</div><span class="ml-auto">unsaved in 2 sections</span></header>',
      ),
    );
  });
});

describe("prLabel", () => {
  it("shortens a bead external-ref to its PR number", () => {
    expect(prLabel("gh-218")).toBe("#218");
    expect(prLabel("https://github.com/o/r/pull/42")).toBe("#42");
  });

  it("falls back to the raw ref when no trailing number is there to shorten", () => {
    expect(prLabel("gh-main")).toBe("gh-main");
  });
});

describe("PrChip", () => {
  it("links a known PR out to a new tab and tints it as under review", () => {
    const html = renderToStaticMarkup(
      <PrChip href="https://github.com/o/r/pull/218">{prLabel("gh-218")}</PrChip>,
    );
    expect(html).toContain('href="https://github.com/o/r/pull/218"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("text-stage-in-review");
    expect(html).toContain("#218");
    expect(html).toContain("<svg"); // the pull-request glyph
  });

  it("stays inert — no link at all — when the ref maps to no url", () => {
    const html = renderToStaticMarkup(<PrChip>{prLabel("gh-218")}</PrChip>);
    expect(html).not.toContain("<a");
    expect(html).toContain("#218");
  });

  it("tints a merged PR as done and drops the glyph where the label already says so", () => {
    const html = renderToStaticMarkup(
      <PrChip href="https://x/1" tone="done" icon={false}>
        merged #1
      </PrChip>,
    );
    expect(html).toContain("text-stage-done");
    expect(html).toContain("merged #1");
    expect(html).not.toContain("<svg");
  });
});

describe("WorkingPulse", () => {
  it("says a run is moving right now, in the implementing hue", () => {
    const html = renderToStaticMarkup(<WorkingPulse />);
    expect(html).toContain("working");
    expect(html).toContain("anton-pulse");
    expect(html).toContain("text-stage-implementing");
  });
});
