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

  it("does not auto-reopen the viewer when the job settles and later resumes with a new session", () => {
    const { rerender } = render(
      <JobList
        jobs={[job("running")]}
        slug="anton"
        liveJobs={{ "job-running": { sessionId: "sess-42" } }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /view live output/i }));
    expect(screen.getByTestId("run-terminal")).toBeDefined();

    // RSC refresh after the job settled: the live handle is gone → the viewer closes.
    rerender(<JobList jobs={[job("running")]} slug="anton" />);
    expect(screen.queryByTestId("run-terminal")).toBeNull();

    // The job resumes on this instance with a fresh session. The stale open flag must not
    // silently reopen the viewer — it takes a new click, and the click wires the new session.
    rerender(
      <JobList
        jobs={[job("running")]}
        slug="anton"
        liveJobs={{ "job-running": { sessionId: "sess-43" } }}
      />,
    );
    expect(screen.queryByTestId("run-terminal")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /view live output/i }));
    expect(screen.getByTestId("run-terminal").getAttribute("data-session-id")).toBe("sess-43");
  });

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

/**
 * anton-lmps: the durable half. A gardener or product-master pass writes no run row and opens its
 * session in its final seconds — by the time a founder reads the board the next morning the job has
 * settled and the runner's live handle is gone. The jobs page is the surface those passes' output
 * (their shadow records) is promised on, so the row has to keep offering it after the job ends.
 */
describe("JobList settled-job output affordance", () => {
  it("offers View output on a settled job that recorded a session, wired to that session", () => {
    render(
      <JobList
        jobs={[job("done")]}
        slug="anton"
        jobSessions={{ "job-done": "sess-nightly" }}
      />,
    );

    // Not "live": the pass is over, and the viewer is replaying rather than following.
    expect(screen.queryByRole("button", { name: /view live output/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^view output$/i }));

    expect(screen.getByTestId("run-terminal").getAttribute("data-session-id")).toBe("sess-nightly");
  });

  it.each<JobStatus>(["queued", "parked", "failed", "cancelled"])(
    "offers the recorded session on a %s job too — a pass that ended badly is the one worth reading",
    (status) => {
      render(
        <JobList
          jobs={[job(status)]}
          slug="anton"
          jobSessions={{ [`job-${status}`]: "sess-1" }}
        />,
      );
      expect(screen.getByRole("button", { name: /^view output$/i })).toBeDefined();
    },
  );

  it("prefers the live session over the recorded one while the job is still running", () => {
    render(
      <JobList
        jobs={[job("running")]}
        slug="anton"
        liveJobs={{ "job-running": { sessionId: "sess-live" } }}
        jobSessions={{ "job-running": "sess-recorded" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /view live output/i }));
    expect(screen.getByTestId("run-terminal").getAttribute("data-session-id")).toBe("sess-live");
  });

  it("offers nothing for a job that recorded no session", () => {
    render(<JobList jobs={[job("done")]} slug="anton" jobSessions={{ other: "sess-1" }} />);
    expect(screen.queryByRole("button", { name: /view output/i })).toBeNull();
  });
});
