// @vitest-environment jsdom
/**
 * The shared scan-history bar chart (anton-bz1w), extracted so the board toolbar's mini pill and the
 * Health page's fuller panel read one series the same way. What matters here: a scan that found
 * nothing still draws a point, a baseline is set apart from the incremental scale rather than
 * charted as new arrivals, and an incomplete column carries its own undercount mark.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ScanTrend } from "@/components/health/scan-trend";
import type { ScanHealthPoint, SeverityCounts } from "@/lib/types";

afterEach(cleanup);

function severities(split: Partial<SeverityCounts> = {}): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, ...split };
}

function point(id: string, at: number, split: Partial<SeverityCounts>): ScanHealthPoint {
  const bySeverity = severities(split);
  const total = Object.values(bySeverity).reduce((sum, n) => sum + n, 0);
  return { id, at, total, bySeverity };
}

describe("ScanTrend", () => {
  it("renders nothing for an empty series", () => {
    const { container } = render(<ScanTrend points={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("takes its height from className rather than a fixed size", () => {
    const { container } = render(
      <ScanTrend points={[point("a", 1_700_000_000, { low: 1 })]} className="h-4 w-8" />,
    );
    const chart = container.firstElementChild as HTMLElement;
    expect(chart.className).toContain("h-4");
    expect(chart.className).not.toContain("h-9");
  });

  it("charts every scan in the window, announced oldest → newest", () => {
    render(
      <ScanTrend
        points={[
          point("a", 1_700_000_000, { low: 6 }),
          point("b", 1_700_086_400, { critical: 1, low: 1 }),
          point("c", 1_700_172_800, {}),
        ]}
      />,
    );
    const chart = screen.getByRole("img");
    const label = chart.getAttribute("aria-label")!;
    expect(label).toMatch(/oldest to newest/);
    expect(label).toContain("6 (6 low)");
    expect(label).toContain("2 (1 critical, 1 low)");
    // The clean scan is a point on the chart, not a gap in it.
    expect(label).toContain("0 (no new signals)");
  });

  // A baseline scan counts every signal already in the repo. Charted as a column it both reads as
  // the worst night the repo ever had and squashes the real arrivals after it against a total they
  // were never measured against — 100 then 2 then 3 would look like debt collapsing.
  it("sets a baseline scan apart instead of charting it as new arrivals", () => {
    const points: ScanHealthPoint[] = [
      { ...point("a", 1_700_000_000, { low: 100 }), baseline: true },
      point("b", 1_700_086_400, { low: 2 }),
      point("c", 1_700_172_800, { low: 3 }),
    ];
    render(<ScanTrend points={points} />);

    const label = screen.getByRole("img").getAttribute("aria-label")!;
    expect(label).toContain("baseline scan: 100 signals already in the repo");
    expect(label).not.toContain("100 (100 low)");
    expect(label).not.toMatch(/new signals per scan/i);

    // Scaled to the noisiest INCREMENTAL scan (3), not to the baseline's 100.
    const bar = screen.getByTitle(/2 new signals/).firstElementChild as HTMLElement;
    expect(Number.parseFloat(bar.style.height)).toBeCloseTo(66.7, 0);
  });

  // A scan that lost a collector measured a floor, not the repo. Drawn like a whole scan, its
  // zero-result column becomes the green clean-pass tick — the best night the chart can show — and
  // the honest scan after it reads as the regression from an improvement that never happened.
  it("marks an incomplete column instead of drawing it as a clean pass", () => {
    const points: ScanHealthPoint[] = [
      point("a", 1_700_000_000, { low: 4 }),
      { ...point("b", 1_700_086_400, {}), incomplete: true },
      point("c", 1_700_172_800, { low: 3 }),
    ];
    render(<ScanTrend points={points} />);

    const label = screen.getByRole("img").getAttribute("aria-label")!;
    expect(label).toContain("incomplete scan: every collector that ran found nothing");
    expect(label).not.toContain("0 (no new signals)");

    const column = screen.getByTitle(/incomplete scan/);
    expect(column.innerHTML).toContain("bg-risk-med/70");
    expect(column.innerHTML).not.toContain("bg-stage-done");
  });

  it("dims an incomplete column that did find signals — its counts are a floor", () => {
    const points: ScanHealthPoint[] = [
      { ...point("a", 1_700_000_000, { critical: 1, low: 1 }), incomplete: true },
      point("b", 1_700_086_400, { low: 3 }),
    ];
    render(<ScanTrend points={points} />);

    const label = screen.getByRole("img").getAttribute("aria-label")!;
    expect(label).toContain("2 (1 critical, 1 low) from the collectors that ran");

    const column = screen.getByTitle(/from the collectors that ran/);
    expect(column.innerHTML).toContain("opacity-40");
    expect(column.innerHTML).toContain("bg-risk-med/70");
  });

  it("keeps the collector failure visible on a baseline column", () => {
    const points: ScanHealthPoint[] = [
      { ...point("a", 1_700_000_000, { low: 100 }), baseline: true, incomplete: true },
      point("b", 1_700_086_400, { low: 2 }),
    ];
    render(<ScanTrend points={points} />);

    const label = screen.getByRole("img").getAttribute("aria-label")!;
    expect(label).toContain("baseline scan: 100 signals already in the repo");
    expect(label).toContain("at least one collector failed");

    const column = screen.getByTitle(/baseline scan/);
    expect(column.innerHTML).toContain("bg-risk-med/70");
    expect(column.innerHTML).toContain("opacity-40");
  });
});
