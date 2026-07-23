// @vitest-environment jsdom
/**
 * anton-gjhu: the Investigate affordance. Present only on a running job whose live cwd resolved
 * (the server passes liveJobs for those alone); absent everywhere else. The button spawns
 * via the project-scoped interactive route with the jobId — never a client-picked directory.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { JobList } from "@/components/runs/job-list";
import { InvestigateJobButton } from "@/components/runs/investigate-job";
import type { JobStatus, JobSummary } from "@/lib/jobs-view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

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
  vi.unstubAllGlobals();
});

describe("JobList investigate affordance", () => {
  it("offers Investigate on a running job with a resolved cwd", () => {
    render(
      <JobList
        jobs={[job("running")]}
        slug="anton"
        liveJobs={{ "job-running": { cwd: "/worktrees/wt1" } }}
      />,
    );
    expect(screen.getByRole("button", { name: /investigate/i })).toBeDefined();
  });

  it("offers no Investigate on a running job without a resolvable cwd", () => {
    render(<JobList jobs={[job("running")]} slug="anton" />);
    expect(screen.queryByRole("button", { name: /investigate/i })).toBeNull();
  });

  it.each<JobStatus>(["queued", "parked", "done", "failed", "cancelled"])(
    "offers no Investigate on a %s job even when a cwd is present",
    (status) => {
      render(
        <JobList
          jobs={[job(status)]}
          slug="anton"
          liveJobs={{ [`job-${status}`]: { cwd: "/worktrees/wt1" } }}
        />,
      );
      expect(screen.queryByRole("button", { name: /investigate/i })).toBeNull();
    },
  );
});

describe("InvestigateJobButton", () => {
  it("POSTs the interactive spawn route with the jobId and reports the new session", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ sessionId: "s-new" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const onSession = vi.fn();

    render(<InvestigateJobButton slug="anton" jobId="j1" onSession={onSession} />);
    fireEvent.click(screen.getByRole("button", { name: /investigate/i }));

    await waitFor(() => expect(onSession).toHaveBeenCalledWith("s-new"));
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/anton/sessions/interactive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "j1" }),
    });
  });

  it("surfaces a 409 (job settled / no cwd) inline and opens nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "Job is not running on this instance" }), {
            status: 409,
          }),
        ),
    );
    const onSession = vi.fn();

    render(<InvestigateJobButton slug="anton" jobId="j1" onSession={onSession} />);
    fireEvent.click(screen.getByRole("button", { name: /investigate/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByRole("alert").textContent).toContain("not running");
    expect(onSession).not.toHaveBeenCalled();
  });
});
