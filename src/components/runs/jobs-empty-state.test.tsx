/**
 * The Jobs page has two empty states (anton-mjdo.3): onboarding copy only when the project has
 * never queued a job, and a filter-specific state when the filter — not the project — is why the
 * list is blank.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { JobsEmptyState } from "@/components/runs/jobs-empty-state";

describe("JobsEmptyState", () => {
  it("renders the onboarding state for a project with no jobs at all", () => {
    const html = renderToStaticMarkup(<JobsEmptyState slug="anton" filtered={false} />);
    expect(html).toContain("No jobs yet");
    expect(html).not.toContain("No jobs match");
    expect(html).toContain("/projects/anton/runs");
  });

  it("renders the no-match state with a clear-filters link when jobs exist but none match", () => {
    const html = renderToStaticMarkup(<JobsEmptyState slug="anton" filtered />);
    expect(html).toContain("No jobs match these filters");
    expect(html).not.toContain("No jobs yet");
    // Straight to the unconstrained view — the default (active-only) view can be empty too.
    expect(html).toContain("/projects/anton/jobs?status=all");
  });
});
