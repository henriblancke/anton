// @vitest-environment jsdom
/**
 * The review trend as a toolbar pill (anton-ue90.2). The trend itself is unchanged — what changed is
 * that it costs no vertical space, so the tests assert both what reads WITHOUT opening it and that
 * the numbers survived the move into the popover.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { Bead } from "@/lib/beads/types";
import { reviewTrajectory } from "@/lib/review-trajectory";
import { ReviewTrendPill } from "@/components/board/review-trend-pill";

afterEach(cleanup);

/** Built from beads, the way the board builds it — the pill and its source stay one pipeline. */
const scored = (id: string, score: number, at: string): Bead =>
  ({
    id,
    title: `${id} title`,
    status: "closed",
    issue_type: "feature",
    labels: [`review-score:${score}`],
    updated_at: at,
  }) as Bead;

const renderPill = (targets: Bead[]) =>
  render(<ReviewTrendPill slug="anton" trajectory={reviewTrajectory(targets)} />);

const open = () => fireEvent.click(screen.getByRole("button"));

describe("ReviewTrendPill", () => {
  it("reads the average and the shape of the series without being opened", () => {
    const { container } = renderPill([
      scored("anton-a", 9, "2026-08-03T00:00:00Z"),
      scored("anton-b", 3, "2026-08-02T00:00:00Z"),
      scored("anton-c", 6, "2026-08-01T00:00:00Z"),
    ]);

    expect(screen.getByText("6.0")).toBeTruthy(); // (9 + 3 + 6) / 3, one decimal — never "6"
    expect(container.querySelector('[role="img"]')).toBeTruthy();
    // Closed by default: a trend must not occupy the board until it is asked for.
    expect(screen.queryByRole("heading", { name: "Review scores" })).toBeNull();
  });

  it("states the window and links the worst target once opened", () => {
    renderPill([
      scored("anton-a", 9, "2026-08-03T00:00:00Z"),
      scored("anton-b", 3, "2026-08-02T00:00:00Z"),
      scored("anton-c", 6, "2026-08-01T00:00:00Z"),
    ]);
    open();

    expect(screen.getByRole("heading", { name: "Review scores" })).toBeTruthy();
    expect(screen.getByText("last 3 scored runs")).toBeTruthy();
    expect(screen.getByRole("link", { name: "anton-b" }).getAttribute("href")).toBe(
      "/projects/anton/epics/anton-b",
    );
    expect(screen.getByText("review 3/10")).toBeTruthy();
  });

  it("reads the trend oldest → newest, whichever order the window arrives in", () => {
    const { container } = renderPill([
      scored("anton-old", 2, "2026-08-01T00:00:00Z"),
      scored("anton-new", 9, "2026-08-09T00:00:00Z"),
    ]);

    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "anton-old (anton-old title): 2 out of 10, anton-new (anton-new title): 9 out of 10",
    );
  });

  it("says how large the sample was when the window dropped older runs", () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      scored(`anton-${i}`, 7, `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
    );

    const { unmount } = renderPill(many);
    open();
    expect(screen.getByText("targets scored in all")).toBeTruthy();
    expect(screen.getByText("11")).toBeTruthy();
    unmount();

    // …and stays quiet when the window IS everything.
    renderPill(many.slice(0, 3));
    open();
    expect(screen.queryByText("targets scored in all")).toBeNull();
  });

  it("closes on Escape", () => {
    renderPill([scored("anton-a", 9, "2026-08-03T00:00:00Z")]);
    open();
    expect(screen.getByRole("heading", { name: "Review scores" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("heading", { name: "Review scores" })).toBeNull();
  });

  it("renders nothing for a project no run has scored — an empty board is not an average of zero", () => {
    expect(renderPill([]).container.innerHTML).toBe("");
    expect(
      render(<ReviewTrendPill slug="anton" trajectory={undefined} />).container.innerHTML,
    ).toBe("");
  });
});
