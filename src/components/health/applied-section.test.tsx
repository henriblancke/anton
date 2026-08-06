// @vitest-environment jsdom
/**
 * "Applied this pass": what the gardener patrol changed on its own authority. Names the epics it
 * closed rather than just counting them (the retired hygiene panel's own affordance), and renders
 * nothing when the patrol neither closed anything nor repaired a blocked row.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { AppliedSection } from "@/components/health/applied-section";
import type { HygieneReport } from "@/lib/types";

afterEach(cleanup);

function report(over: Partial<HygieneReport["actions"]> = {}): HygieneReport {
  return {
    id: "h-1",
    projectId: "p1",
    generatedAt: Math.floor(Date.now() / 1000),
    actions: { closedEpics: [], rowsRecomputed: 0, ...over },
    findings: [],
    counts: {
      lint: 0,
      "stale-open": 0,
      "stale-in-progress": 0,
      orphan: 0,
      "dep-cycle": 0,
      duplicate: 0,
    },
  };
}

describe("AppliedSection", () => {
  it("renders nothing for a never-patrolled project", () => {
    const { container } = render(<AppliedSection hygiene={undefined} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when the patrol applied nothing", () => {
    const { container } = render(<AppliedSection hygiene={report()} />);
    expect(container.innerHTML).toBe("");
  });

  it("names the epics it closed, not just how many", () => {
    render(<AppliedSection hygiene={report({ closedEpics: ["anton-e1", "anton-e2"] })} />);
    expect(screen.getByText("anton-e1")).toBeTruthy();
    expect(screen.getByText("anton-e2")).toBeTruthy();
  });

  it("names how many is_blocked rows it repaired, with the explanatory title", () => {
    render(<AppliedSection hygiene={report({ rowsRecomputed: 4 })} />);
    expect(screen.getByText(/repaired 4 blocked rows/)).toBeTruthy();
    expect(screen.getByText(/repaired 4 blocked rows/).getAttribute("title")).toContain(
      "bd ready trusts that flag",
    );
  });
});
