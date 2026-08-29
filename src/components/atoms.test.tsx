/**
 * The shared project breadcrumb bar (anton-m4b5.2). It was hand-copied into the jobs page, the runs
 * page and the settings view, so the markup below is pinned verbatim: the extraction is only a
 * refactor as long as all three sections keep rendering exactly what they rendered before it.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { PageHeader } from "@/components/atoms";

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
