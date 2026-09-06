// @vitest-environment jsdom
/**
 * The vitals rail is the one block of the Health page that always renders, so it carries the
 * clean-vs-never-checked distinction for the whole report: a project that has never been patrolled
 * or scanned says so here, in the same words every time, rather than the page just going quiet.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { HealthRail } from "@/components/health/health-rail";
import type { ProjectHealth } from "@/lib/health";

afterEach(cleanup);

function baseHealth(over: Partial<ProjectHealth> = {}): ProjectHealth {
  return {
    worthALook: [],
    housekeeping: [],
    hygiene: undefined,
    scanHealth: undefined,
    trajectory: undefined,
    stoppedCount: 0,
    staleServers: [],
    pickerLog: [],
    ...over,
  };
}

describe("HealthRail", () => {
  it("says never patrolled / never scanned / no runs scored for an untouched project", () => {
    render(<HealthRail slug="anton" health={baseHealth()} />);
    expect(screen.getByText("never patrolled")).toBeTruthy();
    // "never scanned" is said twice — once in the trend block, once in "Last checked" — both
    // honestly true of the same untouched project.
    expect(screen.getAllByText("never scanned")).toHaveLength(2);
    expect(screen.getByText("no runs scored yet")).toBeTruthy();
  });

  it("names when the patrol and the scan last ran once either has", () => {
    render(
      <HealthRail
        slug="anton"
        health={baseHealth({
          hygiene: {
            id: "h-1",
            projectId: "p1",
            generatedAt: Math.floor(Date.now() / 1000) - 6 * 3600,
            actions: { closedEpics: [], rowsRecomputed: 0 },
            findings: [],
            counts: {
              lint: 0,
              "stale-open": 0,
              "stale-in-progress": 0,
              orphan: 0,
              "dep-cycle": 0,
              duplicate: 0,
            },
          },
        })}
      />,
    );
    expect(screen.queryByText("never patrolled")).toBeNull();
    expect(screen.getByText(/6h ago/)).toBeTruthy();
  });

  it("names the worst target and the sample size once runs have been scored", () => {
    render(
      <HealthRail
        slug="anton"
        health={baseHealth({
          trajectory: {
            recent: [{ id: "anton-a", title: "A", score: 8 }],
            average: 8,
            worst: { id: "anton-a", title: "A", score: 8 },
            scored: 3,
          },
        })}
      />,
    );
    expect(screen.getByRole("heading", { name: "Review average" })).toBeTruthy();
    expect(screen.getByText("8.0")).toBeTruthy();
    expect(screen.getByText(/3 scored in all/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "anton-a" }).getAttribute("href")).toBe(
      "/projects/anton/epics/anton-a",
    );
  });

  it("names the count of stopped runs and links back to the board", () => {
    render(<HealthRail slug="anton" health={baseHealth({ stoppedCount: 2 })} />);
    expect(screen.getByText(/2 stopped runs/)).toBeTruthy();
    expect(screen.getByText(/answered on the board, not/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to board" }).getAttribute("href")).toBe(
      "/projects/anton",
    );
  });

  it("drops the redirection clause when nothing is stopped", () => {
    render(<HealthRail slug="anton" health={baseHealth({ stoppedCount: 0 })} />);
    // The block still renders — this rail always does — but "answered on the board, not here"
    // would imply work is waiting there, which is the opposite of what a zero count means.
    expect(screen.getByText("No stopped runs.")).toBeTruthy();
    expect(screen.queryByText(/answered on the board/)).toBeNull();
    expect(screen.getByRole("link", { name: "Back to board" })).toBeTruthy();
  });
});
