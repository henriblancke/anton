// @vitest-environment jsdom
/**
 * The board's codebase-health panel (anton-bz1w). What matters here: the two zero-states stay
 * different claims ("never scanned" renders nothing; "scanned, found nothing" says so), the delta
 * reads as a DIRECTION rather than a bare number, and the chart announces every scan in the window
 * so the trend is available to a screen reader, not only to the eye.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ScanHealthPanel } from "@/components/board/scan-health-panel";
import type { ScanHealth, ScanHealthPoint, SeverityCounts } from "@/lib/types";

afterEach(cleanup);

function severities(split: Partial<SeverityCounts> = {}): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, ...split };
}

function point(id: string, at: number, split: Partial<SeverityCounts>): ScanHealthPoint {
  const bySeverity = severities(split);
  const total = Object.values(bySeverity).reduce((sum, n) => sum + n, 0);
  return { id, at, total, bySeverity };
}

function health(over: Partial<ScanHealth> = {}): ScanHealth {
  const points = over.points ?? [point("a", 1_700_000_000, { low: 4 })];
  return {
    points,
    latest: over.latest ?? points[points.length - 1],
    byClass: { security: 0, dependencies: 0, debt: 4, risk: 0, docs: 0, other: 0 },
    collectorFailures: 0,
    ...over,
  };
}

describe("ScanHealthPanel", () => {
  it("renders nothing for a project that has never been scanned", () => {
    const { container } = render(<ScanHealthPanel health={undefined} />);
    expect(container.innerHTML).toBe("");
  });

  it("names the latest scan's count and severity split", () => {
    render(
      <ScanHealthPanel
        health={health({
          points: [point("a", 1_700_000_000, { critical: 1, low: 5 })],
          delta: { total: 2, bySeverity: severities({ low: 2 }) },
        })}
      />,
    );
    expect(screen.getByText("6")).toBeTruthy();
    expect(screen.getByText(/new signals/)).toBeTruthy();
    expect(screen.getByText(/since the previous scan/)).toBeTruthy();
    expect(screen.getByText("1 critical")).toBeTruthy();
    expect(screen.getByText("5 low")).toBeTruthy();
  });

  it("does not claim a comparison on a first scan — there is no previous scan to be new since", () => {
    render(<ScanHealthPanel health={health({ points: [point("a", 1_700_000_000, { low: 4 })] })} />);
    expect(screen.getByText(/signals found/)).toBeTruthy();
    expect(screen.queryByText(/since the previous scan/)).toBeNull();
  });

  it("says a clean scan is clean — never an empty panel", () => {
    render(<ScanHealthPanel health={health({ points: [point("a", 1_700_000_000, {})] })} />);
    expect(screen.getByText(/clean scan/)).toBeTruthy();
  });

  it("does not call a zero-result scan clean when a collector died on it", () => {
    // Zero from an incomplete scan is "nothing was found by what ran", not a clean bill of health —
    // the failure chip below it would otherwise contradict the panel's own headline.
    render(
      <ScanHealthPanel
        health={health({ points: [point("a", 1_700_000_000, {})], collectorFailures: 1 })}
      />,
    );
    expect(screen.getByText(/nothing found — incomplete scan/)).toBeTruthy();
    expect(screen.queryByText(/clean scan/)).toBeNull();
  });

  it("says there is no trend rather than showing a zero delta it hasn't earned", () => {
    render(<ScanHealthPanel health={health()} />);
    expect(screen.getByText(/no trend yet/)).toBeTruthy();
  });

  it("reads a fall as the good direction and a rise as the bad one", () => {
    const falling = render(
      <ScanHealthPanel
        health={health({
          delta: { total: -3, bySeverity: severities({ low: -3 }) },
        })}
      />,
    );
    expect(screen.getByText(/−3 vs previous scan/)).toBeTruthy();
    expect(screen.getByTitle(/arriving more slowly/)).toBeTruthy();
    falling.unmount();

    render(
      <ScanHealthPanel
        health={health({ delta: { total: 2, bySeverity: severities({ low: 2 }) } })}
      />,
    );
    expect(screen.getByText(/\+2 vs previous scan/)).toBeTruthy();
    expect(screen.getByTitle(/arriving faster/)).toBeTruthy();
  });

  it("charts every scan in the window, announced oldest → newest", () => {
    render(
      <ScanHealthPanel
        health={health({
          points: [
            point("a", 1_700_000_000, { low: 6 }),
            point("b", 1_700_086_400, { critical: 1, low: 1 }),
            point("c", 1_700_172_800, {}),
          ],
        })}
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
    render(<ScanHealthPanel health={health({ points })} />);

    const label = screen.getByRole("img").getAttribute("aria-label")!;
    expect(label).toContain("baseline scan: 100 signals already in the repo");
    expect(label).not.toContain("100 (100 low)");
    // The chart-level label must not call the whole series new arrivals — a screen reader user
    // would hear it contradict the baseline point it introduces.
    expect(label).not.toMatch(/new signals per scan/i);

    // Scaled to the noisiest INCREMENTAL scan (3), not to the baseline's 100.
    const bar = screen.getByTitle(/2 new signals/).firstElementChild as HTMLElement;
    expect(Number.parseFloat(bar.style.height)).toBeCloseTo(66.7, 0);
  });

  it("says the latest scan is a baseline rather than calling its total new", () => {
    const points = [{ ...point("a", 1_700_000_000, { low: 100 }), baseline: true }];
    render(<ScanHealthPanel health={health({ points })} />);
    expect(screen.getByText(/in the repo — baseline scan/)).toBeTruthy();
    expect(screen.queryByText(/signals found/)).toBeNull();
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
    render(<ScanHealthPanel health={health({ points })} />);

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
    render(<ScanHealthPanel health={health({ points })} />);

    const label = screen.getByRole("img").getAttribute("aria-label")!;
    expect(label).toContain("2 (1 critical, 1 low) from the collectors that ran");

    const column = screen.getByTitle(/from the collectors that ran/);
    expect(column.innerHTML).toContain("opacity-40");
    expect(column.innerHTML).toContain("bg-risk-med/70");
  });

  // A baseline that also lost a collector is both things at once, and the failure is the harder one
  // to recover: once the scan is no longer latest its failure chip is gone, and every later delta is
  // measured against a total nobody said was short.
  it("keeps the collector failure visible on a baseline column", () => {
    const points: ScanHealthPoint[] = [
      { ...point("a", 1_700_000_000, { low: 100 }), baseline: true, incomplete: true },
      point("b", 1_700_086_400, { low: 2 }),
    ];
    render(<ScanHealthPanel health={health({ points })} />);

    const label = screen.getByRole("img").getAttribute("aria-label")!;
    expect(label).toContain("baseline scan: 100 signals already in the repo");
    expect(label).toContain("at least one collector failed");

    const column = screen.getByTitle(/baseline scan/);
    expect(column.innerHTML).toContain("bg-risk-med/70");
    expect(column.innerHTML).toContain("opacity-40");
  });

  it("reports what triage did with the scan, when triage reported it", () => {
    const points = [{ ...point("a", 1_700_000_000, { low: 3 }), triage: { created: 2, deduped: 1 } }];
    render(<ScanHealthPanel health={health({ points })} />);
    expect(screen.getByText(/triaged into 2 beads · 1 deduped/)).toBeTruthy();
  });

  it("flags a scan whose collectors died — its counts are an undercount", () => {
    render(<ScanHealthPanel health={health({ collectorFailures: 1 })} />);
    expect(screen.getByText("1 collector failed")).toBeTruthy();
    expect(screen.getByTitle(/undercount/)).toBeTruthy();
  });
});
