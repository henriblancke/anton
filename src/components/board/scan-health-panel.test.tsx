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

  it("says a first scan has no trend rather than showing a zero delta", () => {
    render(<ScanHealthPanel health={health()} />);
    expect(screen.getByText(/first scan — no trend yet/)).toBeTruthy();
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
