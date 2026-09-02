// @vitest-environment jsdom
/**
 * The page-level honesty check: a project nothing has ever checked gets an explicit empty state
 * naming what hasn't run, rather than a blank report that could be mistaken for "nothing wrong". A
 * project that HAS been checked — even if every section came back empty — never sees that banner.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { HealthReport } from "@/components/health/health-report";
import type { ProjectHealth } from "@/lib/health";

afterEach(cleanup);

function health(over: Partial<ProjectHealth> = {}): ProjectHealth {
  return {
    worthALook: [],
    housekeeping: [],
    hygiene: undefined,
    scanHealth: undefined,
    trajectory: undefined,
    stoppedCount: 0,
    staleServers: [],
    ...over,
  };
}

describe("HealthReport", () => {
  it("says nothing has checked this project when patrol, scan, and review are all untouched", () => {
    render(<HealthReport slug="anton" health={health()} />);
    expect(screen.getByText("Nothing has checked this project yet")).toBeTruthy();
  });

  it("drops the banner once a patrol has run, even if it found nothing", () => {
    render(
      <HealthReport
        slug="anton"
        health={health({
          hygiene: {
            id: "h-1",
            projectId: "p1",
            generatedAt: Math.floor(Date.now() / 1000),
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
    expect(screen.queryByText("Nothing has checked this project yet")).toBeNull();
  });

  // The page is the surface a stale process has to reach without a CLI, so the banner rides above
  // everything else it would make untrustworthy (anton-pzfb).
  it("leads with the stale-server banner when the running build is not the one on disk", () => {
    render(
      <HealthReport
        slug="anton"
        health={health({
          staleServers: [
            {
              pid: 4242,
              self: true,
              runner: true,
              drift: {
                state: "outdated",
                running: { version: "0.3.9", revision: null },
                onDisk: { version: "0.4.0", revision: null },
                bootedAt: null,
              },
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("This anton server is older than the code on disk")).toBeTruthy();
  });

  it("shows no such banner for a server started from the current checkout", () => {
    render(<HealthReport slug="anton" health={health()} />);
    expect(screen.queryByText("This anton server is older than the code on disk")).toBeNull();
  });

  it("always renders the vitals rail, even with nothing to report", () => {
    render(<HealthReport slug="anton" health={health()} />);
    // Anchored on the rail's headings and its back-link, which render unconditionally — NOT on the
    // stopped-run copy, which varies with the count (see HealthRail's zero case).
    expect(screen.getByText("On the board")).toBeTruthy();
    expect(screen.getByText("Last checked")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to board" })).toBeTruthy();
  });
});
