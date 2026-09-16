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
import { SCAN_SEVERITIES } from "@/lib/scan-severity";
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
    const bar = screen.getByTitle(/2 new signals/).querySelector("span[style]") as HTMLElement;
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

  // anton-knyp round 4: the segments used to claim 100% of the column directly, so the amber
  // marker appended after them pushed total content past the column's height and flexbox shrank
  // every segment — including ones floored at 6% — right back below their floor. The segments
  // must sit in their own flex-1 wrapper so the marker's height is subtracted from what they
  // divide up, not tacked on top of it.
  it("reserves room for the incomplete marker instead of piling it onto a full column", () => {
    render(
      <ScanTrend
        points={[{ ...point("a", 1_700_000_000, { critical: 1, high: 1, low: 1 }), incomplete: true }]}
      />,
    );

    const column = screen.getByTitle(/incomplete scan/);
    const marker = column.querySelector(".bg-risk-med\\/70") as HTMLElement;
    const segments = Array.from(column.querySelectorAll<HTMLElement>("span[style]"));

    // The marker sits outside the segments' wrapper, as a flex sibling with its own footprint —
    // not nested inside it, where its height would come out of the segments' own 100% budget.
    for (const segment of segments) expect(marker.contains(segment)).toBe(false);
    // The wrapper hosting the segments is itself a flex-1 item, so the marker's fixed size is
    // subtracted from the space it divides up rather than layered on top of a full column.
    const wrapper = segments[0].parentElement!;
    expect(wrapper.className).toContain("flex-1");
    expect(wrapper).not.toBe(column);
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

  // anton-knyp: the peak column's unfloored segments already sum to exactly 100% of the track, so
  // flooring each one independently against a full 100% track asks for >100% and flexbox silently
  // shrinks every segment to fit — distorting the ratios the chart exists to show.
  it("holds a peak column's segment ratios instead of shrinking them to fit the floor", () => {
    render(<ScanTrend points={[point("a", 1_700_000_000, { critical: 34, high: 33, medium: 33 })]} />);

    const column = screen.getByTitle(/100 new signals/);
    const heights = Array.from(column.querySelectorAll<HTMLElement>("span[style]")).map((bar) =>
      Number.parseFloat(bar.style.height),
    );
    const sum = heights.reduce((a, b) => a + b, 0);

    expect(sum).toBeLessThanOrEqual(100.01);
    // No severity needed the floor here, so ratios hold to the underlying counts within a pixel.
    expect(heights[0] / heights[1]).toBeCloseTo(34 / 33, 1);
    expect(heights[1] / heights[2]).toBeCloseTo(33 / 33, 1);
  });

  // anton-knyp: a low-total column with several tiny severities can't afford `FLOOR_PCT` for all of
  // them out of its own small track — reserving it anyway starved the majority severity to 0% height.
  it("never starves a column's majority severity to 0% when siblings can't all afford the floor", () => {
    render(
      <ScanTrend
        points={[
          point("a", 1_700_000_000, { critical: 1, high: 1, medium: 100, low: 1 }),
          point("b", 1_700_086_400, { low: 1000 }),
        ]}
      />,
    );

    const column = screen.getByTitle(/103 new signals/);
    const bars = Array.from(column.querySelectorAll<HTMLElement>("span[style]"));
    const heights = bars.map((bar) => Number.parseFloat(bar.style.height));
    const sum = heights.reduce((a, b) => a + b, 0);

    // medium holds 100 of the column's 103 signals — it must dwarf every other segment, not vanish.
    const mediumIndex = SCAN_SEVERITIES.indexOf("medium");
    expect(heights[mediumIndex]).toBeGreaterThan(0);
    for (let i = 0; i < heights.length; i++) {
      if (i !== mediumIndex) expect(heights[mediumIndex]).toBeGreaterThan(heights[i]);
    }
    expect(sum).toBeLessThanOrEqual(100.01);
  });

  // anton-knyp: when every severity in a column is under the floor and together they cost more
  // than the column's own (small) track, the group must still degrade to a visible, even split —
  // not fall back to raw sub-percent shares just because the floor itself is unaffordable.
  it("splits the track evenly when no severity in the column clears the floor", () => {
    render(
      <ScanTrend
        points={[
          point("a", 1_700_000_000, { critical: 1, high: 1, medium: 1, low: 2 }),
          point("b", 1_700_086_400, { low: 500 }),
        ]}
      />,
    );

    const column = screen.getByTitle(/5 new signals/);
    const heights = Array.from(column.querySelectorAll<HTMLElement>("span[style]")).map((bar) =>
      Number.parseFloat(bar.style.height),
    );

    for (const h of heights) expect(h).toBeGreaterThan(0);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(0.01);
  });

  it("still draws a visible segment for a count of 1 against a large peak", () => {
    render(<ScanTrend points={[point("a", 1_700_000_000, { critical: 40, low: 1 })]} />);

    const column = screen.getByTitle(/41 new signals/);
    const heights = Array.from(column.querySelectorAll<HTMLElement>("span[style]")).map((bar) =>
      Number.parseFloat(bar.style.height),
    );
    const sum = heights.reduce((a, b) => a + b, 0);

    expect(sum).toBeLessThanOrEqual(100.01);
    expect(heights[1]).toBeGreaterThanOrEqual(6);
  });

  // anton-knyp round 3: a quiet column's own track can be too small to fund the floor out of
  // itself even though the container has ample room — the floor must draw against the shared 100%
  // ceiling, not get capped at whatever the column's own (tiny) proportional track allows.
  it("still floors a quiet column's segments next to a much taller peak column", () => {
    render(
      <ScanTrend
        points={[
          point("a", 1_700_000_000, { critical: 40, low: 1 }),
          point("b", 1_700_086_400, { low: 4100 }),
        ]}
      />,
    );

    const column = screen.getByTitle(/41 new signals/);
    const heights = Array.from(column.querySelectorAll<HTMLElement>("span[style]")).map((bar) =>
      Number.parseFloat(bar.style.height),
    );

    for (const h of heights) expect(h).toBeGreaterThanOrEqual(6);
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
