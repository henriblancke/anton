// @vitest-environment jsdom
/**
 * anton-x10l: the View-live-output affordance. Present only on a running job whose handler
 * reported a live session (the server passes liveJobs for those alone); absent everywhere else.
 * Opening renders the read-only session-log viewer wired to that exact sessionId.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { JobList } from "@/components/runs/job-list";
import type { JobStatus, JobSummary } from "@/lib/jobs-view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

// RunTerminal drags in xterm (browser-only) and opens the SSE stream on mount — stub it and
// assert on the sessionId it was handed, which is the wiring this ticket is about.
vi.mock("@/components/runs/run-terminal", () => ({
  RunTerminal: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="run-terminal" data-session-id={sessionId ?? ""} />
  ),
}));

function job(status: JobStatus): JobSummary {
  return {
    id: `job-${status}`,
    type: "review-fix",
    status,
    attempts: 1,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_060,
  } as JobSummary;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("JobList view-live-output affordance", () => {
  it("offers View live output on a running job with a live session, wired to that sessionId", () => {
    render(
      <JobList
        jobs={[job("running")]}
        slug="anton"
        liveJobs={{ "job-running": { sessionId: "sess-42", cwd: "/worktrees/wt1" } }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /view live output/i }));

    expect(screen.getByTestId("run-terminal").getAttribute("data-session-id")).toBe("sess-42");
  });

  it("offers no View live output on a running job without a reported session", () => {
    render(
      <JobList
        jobs={[job("running")]}
        slug="anton"
        liveJobs={{ "job-running": { cwd: "/worktrees/wt1" } }}
      />,
    );
    expect(screen.queryByRole("button", { name: /view live output/i })).toBeNull();
  });

  it("offers no View live output when the job has no live handle at all", () => {
    render(<JobList jobs={[job("running")]} slug="anton" />);
    expect(screen.queryByRole("button", { name: /view live output/i })).toBeNull();
  });

  it.each<JobStatus>(["queued", "parked", "done", "failed", "cancelled"])(
    "offers no View live output on a %s job even when a session is present",
    (status) => {
      render(
        <JobList
          jobs={[job(status)]}
          slug="anton"
          liveJobs={{ [`job-${status}`]: { sessionId: "sess-42" } }}
        />,
      );
      expect(screen.queryByRole("button", { name: /view live output/i })).toBeNull();
    },
  );

  it("Close collapses the viewer and restores the action", () => {
    render(
      <JobList
        jobs={[job("running")]}
        slug="anton"
        liveJobs={{ "job-running": { sessionId: "sess-42" } }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /view live output/i }));
    expect(screen.getByTestId("run-terminal")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByTestId("run-terminal")).toBeNull();
    expect(screen.getByRole("button", { name: /view live output/i })).toBeDefined();
  });
});
