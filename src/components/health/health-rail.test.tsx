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
    escalations: [],
    dismissed: [],
    breaker: undefined,
    parks: undefined,
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

  it("counts the open alerts and jumps to the list, which is on this page now", () => {
    render(<HealthRail slug="anton" health={baseHealth({ stoppedCount: 2 })} />);
    expect(screen.getByText(/2/)).toBeTruthy();
    expect(screen.getByText(/needing a decision/)).toBeTruthy();
    // The rows moved here from the board (anton-7gxs), so the rail's pointer moved with them: it
    // jumps DOWN the page rather than redirecting to a board that no longer lists them.
    expect(screen.getByRole("link", { name: "Jump to Needs you" }).getAttribute("href")).toBe(
      "#needs-you",
    );
    expect(screen.getByRole("link", { name: "Back to board" }).getAttribute("href")).toBe(
      "/projects/anton",
    );
  });

  it("says how many are dismissed, and that they come back if the stall changes", () => {
    const dismissed = [
      { id: "esc-9", findingKey: "k", kind: "exhausted-job", reason: "r", ageMs: 0, status: "resolved", noted: true, raisedAt: 0 },
    ] as ProjectHealth["dismissed"];
    render(<HealthRail slug="anton" health={baseHealth({ dismissed })} />);
    expect(screen.getByText(/1 dismissed/)).toBeTruthy();
  });

  it("drops the jump when nothing is stopped, and never claims a dismissal nobody made", () => {
    render(<HealthRail slug="anton" health={baseHealth({ stoppedCount: 0 })} />);
    // The block still renders — this rail always does — but an anchor to an absent section, or a
    // dismissed count of zero, would each point at something that isn't there.
    expect(screen.getByText("Nothing is stopped.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Jump to Needs you" })).toBeNull();
    expect(screen.queryByText(/dismissed/)).toBeNull();
    expect(screen.getByRole("link", { name: "Back to board" })).toBeTruthy();
  });
});
