// @vitest-environment jsdom
/**
 * The Health page's own view of the latest scan (anton-bz1w / anton-ue90.1 split). What matters here
 * — moved over from the old board panel's coverage: the two zero-states stay different claims
 * ("never scanned" renders nothing; "scanned, found nothing" says so), a first scan doesn't claim a
 * comparison it never made, and a collector outage keeps a zero-result scan from reading as clean.
 * The chart itself (baseline outlines, incomplete columns, the delta direction) is covered in
 * scan-trend.test.tsx now that {@link ScanTrend} is shared.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { CodebaseSignalsSection } from "@/components/health/codebase-signals-section";
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

describe("CodebaseSignalsSection", () => {
  it("renders nothing for a project that has never been scanned", () => {
    const { container } = render(<CodebaseSignalsSection scanHealth={undefined} />);
    expect(container.innerHTML).toBe("");
  });

  it("names the latest scan's count and severity split", () => {
    render(
      <CodebaseSignalsSection
        scanHealth={health({
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
    render(
      <CodebaseSignalsSection scanHealth={health({ points: [point("a", 1_700_000_000, { low: 4 })] })} />,
    );
    expect(screen.getByText(/signals found/)).toBeTruthy();
    expect(screen.queryByText(/since the previous scan/)).toBeNull();
  });

  it("says a clean scan is clean — never an empty panel", () => {
    render(<CodebaseSignalsSection scanHealth={health({ points: [point("a", 1_700_000_000, {})] })} />);
    expect(screen.getByText(/clean scan/)).toBeTruthy();
  });

  it("does not call a zero-result scan clean when a collector died on it", () => {
    render(
      <CodebaseSignalsSection
        scanHealth={health({ points: [point("a", 1_700_000_000, {})], collectorFailures: 1 })}
      />,
    );
    expect(screen.getByText(/nothing found — incomplete scan/)).toBeTruthy();
    expect(screen.queryByText(/clean scan/)).toBeNull();
  });

  it("says the latest scan is a baseline rather than calling its total new", () => {
    const points = [{ ...point("a", 1_700_000_000, { low: 100 }), baseline: true }];
    render(<CodebaseSignalsSection scanHealth={health({ points })} />);
    expect(screen.getByText(/in the repo — baseline scan/)).toBeTruthy();
    expect(screen.queryByText(/signals found/)).toBeNull();
  });

  it("reports what triage did with the scan, when triage reported it", () => {
    const points = [{ ...point("a", 1_700_000_000, { low: 3 }), triage: { created: 2, deduped: 1 } }];
    render(<CodebaseSignalsSection scanHealth={health({ points })} />);
    expect(screen.getByText(/triaged into 2 beads · 1 deduped/)).toBeTruthy();
  });

  it("names the tree the scan measured, abbreviated with the full sha on hover", () => {
    const sha = "a338176aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const points = [{ ...point("a", 1_700_000_000, { low: 3 }), sha }];
    render(<CodebaseSignalsSection scanHealth={health({ points })} />);
    expect(screen.getByText("a338176a")).toBeTruthy();
    expect(screen.getByTitle(`commit ${sha}`)).toBeTruthy();
  });

  it("claims no tree for a scan recorded before anton knew which one it measured", () => {
    render(<CodebaseSignalsSection scanHealth={health()} />);
    // Naming a commit is the whole point of the label — an absent sha must not render an empty one.
    expect(screen.queryByTitle(/^commit /)).toBeNull();
  });

  it("flags a scan whose collectors died — its counts are an undercount", () => {
    render(<CodebaseSignalsSection scanHealth={health({ collectorFailures: 1 })} />);
    expect(screen.getByText("1 collector failed")).toBeTruthy();
    expect(screen.getByTitle(/collector\(s\) failed during this scan/)).toBeTruthy();
  });
});
