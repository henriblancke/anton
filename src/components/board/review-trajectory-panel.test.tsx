import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { Bead } from "@/lib/beads/types";
import { reviewTrajectory } from "@/lib/review-trajectory";
import { ReviewTrajectoryPanel } from "@/components/board/review-trajectory-panel";

/** Built from beads, the way the board builds it — the panel and its source stay one pipeline. */
const scored = (id: string, score: number, at: string): Bead =>
  ({
    id,
    title: `${id} title`,
    status: "closed",
    issue_type: "feature",
    labels: [`review-score:${score}`],
    updated_at: at,
  }) as Bead;

const render = (targets: Bead[]) =>
  renderToStaticMarkup(
    <ReviewTrajectoryPanel slug="anton" trajectory={reviewTrajectory(targets)} />,
  );

describe("ReviewTrajectoryPanel", () => {
  it("states the average over the window and links the worst target in it", () => {
    const html = render([
      scored("anton-a", 9, "2026-08-03T00:00:00Z"),
      scored("anton-b", 3, "2026-08-02T00:00:00Z"),
      scored("anton-c", 6, "2026-08-01T00:00:00Z"),
    ]);

    expect(html).toContain("6.0"); // (9 + 3 + 6) / 3, one decimal — never "6"
    expect(html).toContain("over the last 3 scored runs");
    expect(html).toContain("/projects/anton/epics/anton-b"); // the worst one, one click away
    expect(html).toContain("review 3/10");
  });

  it("reads the trend oldest → newest, whichever order the window arrives in", () => {
    const html = render([
      scored("anton-old", 2, "2026-08-01T00:00:00Z"),
      scored("anton-new", 9, "2026-08-09T00:00:00Z"),
    ]);

    expect(html).toContain(
      'aria-label="anton-old (anton-old title): 2 out of 10, anton-new (anton-new title): 9 out of 10"',
    );
  });

  it("says how large the sample was when the window dropped older runs", () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      scored(`anton-${i}`, 7, `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
    );

    expect(render(many)).toContain("11 targets scored in all");
    // …and stays quiet when the window IS everything.
    expect(render(many.slice(0, 3))).not.toContain("targets scored in all");
  });

  it("renders nothing for a project no run has scored — an empty board is not an average of zero", () => {
    expect(render([])).toBe("");
    expect(
      renderToStaticMarkup(<ReviewTrajectoryPanel slug="anton" trajectory={undefined} />),
    ).toBe("");
  });
});
