/**
 * The shared honesty vocabulary behind the scan-health surfaces: a baseline is a standing total, an
 * incomplete scan is an undercount, and a paused trend blames the outage rather than a missing
 * baseline. Every scan-facing component in `components/health` quotes these functions rather than
 * restating the wording, so a wording bug here is a wording bug everywhere it's read.
 */
import { describe, expect, it } from "vitest";

import {
  baselineNote,
  classSplit,
  incompleteNote,
  noTrendNote,
  pausedBy,
  pointLabel,
  pointNote,
  severitySplit,
} from "@/components/health/scan-copy";
import type { ClassCounts, ScanHealth, ScanHealthPoint, SeverityCounts } from "@/lib/types";

function severities(split: Partial<SeverityCounts> = {}): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, ...split };
}

function classCounts(split: Partial<ClassCounts> = {}): ClassCounts {
  return { security: 0, dependencies: 0, debt: 0, risk: 0, docs: 0, other: 0, ...split };
}

function point(over: Partial<ScanHealthPoint> = {}): ScanHealthPoint {
  const bySeverity = severities();
  return { id: "a", at: 1_700_000_000, total: 0, bySeverity, ...over };
}

describe("scan-copy", () => {
  it("calls a baseline a standing total, not new arrivals", () => {
    const note = baselineNote(point({ total: 100 }));
    expect(note).toContain("100 signals already in the repo");
    expect(note).toContain("not comparable");
  });

  it("marks a baseline that also lost a collector as an undercount of itself", () => {
    const note = baselineNote(point({ total: 100, incomplete: true }));
    expect(note).toContain("this baseline is itself an undercount");
  });

  it("says a zero-result incomplete scan found nothing FROM WHAT RAN, not a clean pass", () => {
    expect(incompleteNote(point({ total: 0 }))).toContain("not a clean pass");
  });

  it("carries an incomplete scan's own counts as an undercount", () => {
    const note = incompleteNote(point({ total: 2, bySeverity: severities({ low: 2 }) }));
    expect(note).toContain("2 (2 low)");
    expect(note).toContain("undercount");
  });

  it("splits nothing new as its own phrase rather than an empty string", () => {
    expect(severitySplit(point())).toBe("no new signals");
    expect(classSplit(classCounts())).toBe("nothing new");
  });

  it("labels a baseline point with its note, an incremental point with its count", () => {
    expect(pointLabel(point({ total: 100, baseline: true }))).toContain("baseline scan");
    expect(pointLabel(point({ total: 3, bySeverity: severities({ low: 3 }) }))).toContain(
      "3 (3 low)",
    );
  });

  it("pointNote prefers baseline, then incomplete, then the plain new-signal count", () => {
    expect(pointNote(point({ baseline: true, total: 5 }))).toContain("baseline scan");
    expect(pointNote(point({ incomplete: true, total: 5 }))).toContain("undercount");
    expect(pointNote(point({ total: 5, bySeverity: severities({ low: 5 }) }))).toBe(
      "5 new signals (5 low)",
    );
  });

  it("blames the latest scan's own outage when that suppressed the delta", () => {
    const health: ScanHealth = {
      points: [point()],
      latest: point(),
      byClass: classCounts(),
      collectorFailures: 1,
    };
    expect(pausedBy(health)).toBe("latest");
    expect(noTrendNote("latest")).toContain("failed on this scan");
  });

  it("blames the PREVIOUS scan's outage once a whole scan follows it", () => {
    const health: ScanHealth = {
      points: [{ ...point({ id: "a" }), incomplete: true }, point({ id: "b" })],
      latest: point({ id: "b" }),
      byClass: classCounts(),
      collectorFailures: 0,
    };
    expect(pausedBy(health)).toBe("previous");
    expect(noTrendNote("previous")).toContain("failed on the previous scan");
  });

  it("never pauses a baseline latest — nothing may be subtracted from a standing total", () => {
    const health: ScanHealth = {
      points: [{ ...point({ total: 100 }), baseline: true, incomplete: true }],
      latest: { ...point({ total: 100 }), baseline: true, incomplete: true },
      byClass: classCounts(),
      collectorFailures: 1,
    };
    expect(pausedBy(health)).toBeUndefined();
    expect(noTrendNote(undefined)).toContain("needs two scans");
  });
});
