// @vitest-environment jsdom
/**
 * The toolbar's link to the Health page (anton-ue90.3). `@/components/health/scan-trend` is owned by
 * a concurrently-landing bead, so it's mocked here rather than imported for real — this suite only
 * has to prove the pill renders it when there's a scan and passes it the right points, not that the
 * sparkline itself draws correctly (that's `scan-trend`'s own test).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { HealthPill } from "@/components/board/health-pill";
import type { HygieneFinding, HygieneReport, ReviewTrajectory, ScanHealth, ScanHealthPoint } from "@/lib/types";

vi.mock("@/components/health/scan-trend", () => ({
  ScanTrend: ({ points }: { points: ScanHealthPoint[] }) => (
    <span data-testid="scan-trend" data-points={points.length} />
  ),
}));

afterEach(cleanup);

function finding(kind: HygieneFinding["kind"], id: string): HygieneFinding {
  return { kind, key: `${kind}:${id}`, detail: `${kind} on ${id}`, beadId: id };
}

function report(findings: HygieneFinding[], o: Partial<HygieneReport> = {}): HygieneReport {
  const counts = {
    lint: 0,
    "stale-open": 0,
    "stale-in-progress": 0,
    orphan: 0,
    "dep-cycle": 0,
    duplicate: 0,
  };
  for (const f of findings) counts[f.kind] += 1;
  return {
    id: "h-1",
    projectId: "p1",
    generatedAt: Math.floor(Date.now() / 1000) - 6 * 3600,
    actions: { closedEpics: [], rowsRecomputed: 0 },
    findings,
    counts,
    ...o,
  };
}

function point(id: string, at: number): ScanHealthPoint {
  return { id, at, total: 2, bySeverity: { critical: 0, high: 0, medium: 0, low: 2 } };
}

function scanHealth(o: Partial<ScanHealth> = {}): ScanHealth {
  const points = o.points ?? [point("s1", Math.floor(Date.now() / 1000) - 3600)];
  return {
    points,
    latest: o.latest ?? points[points.length - 1],
    byClass: { security: 0, dependencies: 0, debt: 2, risk: 0, docs: 0, other: 0 },
    collectorFailures: 0,
    ...o,
  };
}

const trajectory = (score: number): ReviewTrajectory => {
  const worst = { id: "anton-bad", title: "the bad one", score };
  return { recent: [worst], average: score, worst, scored: 1 };
};

describe("HealthPill", () => {
  it("renders nothing for a project that has never been patrolled, scanned, or scored", () => {
    const { container } = render(
      <HealthPill slug="anton" hygiene={undefined} trajectory={undefined} scanHealth={undefined} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders for a project that has been patrolled and is genuinely clean", () => {
    render(
      <HealthPill slug="anton" hygiene={report([])} trajectory={undefined} scanHealth={undefined} />,
    );
    expect(screen.getByText("Health")).toBeTruthy();
    expect(screen.getByText("0")).toBeTruthy();
  });

  it("counts attention and housekeeping items, not escalations", () => {
    render(
      <HealthPill
        slug="anton"
        hygiene={report([finding("dep-cycle", "anton-a"), finding("lint", "anton-b")])}
        trajectory={undefined}
        scanHealth={undefined}
      />,
    );
    // 1 attention (dep-cycle) + 1 housekeeping (lint) = 2.
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("links to the project's health route", () => {
    render(
      <HealthPill slug="acme" hygiene={report([])} trajectory={undefined} scanHealth={undefined} />,
    );
    expect(screen.getByRole("link").getAttribute("href")).toBe("/projects/acme/health");
  });

  it("shows the amber severity dot only when something is worth a look", () => {
    const { container: clean } = render(
      <HealthPill slug="anton" hygiene={report([])} trajectory={undefined} scanHealth={undefined} />,
    );
    expect(clean.querySelector(".bg-risk-med")).toBeNull();

    const { container: dirty } = render(
      <HealthPill
        slug="anton"
        hygiene={report([finding("dep-cycle", "anton-a")])}
        trajectory={undefined}
        scanHealth={undefined}
      />,
    );
    expect(dirty.querySelector(".bg-risk-med")).toBeTruthy();
  });

  it("promotes a rework-band worst score into the count, same as the board's old strip did", () => {
    render(
      <HealthPill
        slug="anton"
        hygiene={report([])}
        trajectory={trajectory(3)}
        scanHealth={undefined}
      />,
    );
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("renders the scan sparkline when a scan exists, and omits it otherwise", () => {
    const { rerender } = render(
      <HealthPill slug="anton" hygiene={undefined} trajectory={undefined} scanHealth={scanHealth()} />,
    );
    expect(screen.getByTestId("scan-trend")).toBeTruthy();

    rerender(
      <HealthPill slug="anton" hygiene={report([])} trajectory={undefined} scanHealth={undefined} />,
    );
    expect(screen.queryByTestId("scan-trend")).toBeNull();
  });

  it("renders for a project only a scan has ever reported on", () => {
    const { container } = render(
      <HealthPill slug="anton" hygiene={undefined} trajectory={undefined} scanHealth={scanHealth()} />,
    );
    expect(container.innerHTML).not.toBe("");
    expect(screen.getByText("0")).toBeTruthy();
  });

  it("names only what actually exists in the title", () => {
    render(
      <HealthPill
        slug="anton"
        hygiene={report([finding("dep-cycle", "anton-a")])}
        trajectory={undefined}
        scanHealth={undefined}
      />,
    );
    const title = screen.getByRole("link").getAttribute("title");
    expect(title).toContain("1 worth a look");
    expect(title).toContain("patrolled");
    expect(title).not.toContain("new signal");
  });
});
