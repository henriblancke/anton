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
// xterm touches window APIs jsdom lacks; the pty lifecycle under test lives in JobRow, not here.
vi.mock("@/components/pty/pty-terminal", () => ({
  PtyTerminal: () => <div data-testid="pty-terminal" />,
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

describe("investigate pty lifecycle", () => {
  /** 201 with a sessionId for the spawn POST; bare 200 for the teardown DELETE. */
  function lifecycleFetch() {
    return vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "POST"
          ? new Response(JSON.stringify({ sessionId: "s-live" }), { status: 201 })
          : new Response(null, { status: 200 }),
      ),
    );
  }

  async function openTerminal(fetchMock: ReturnType<typeof lifecycleFetch>) {
    vi.stubGlobal("fetch", fetchMock);
    const view = render(
      <JobList
        jobs={[job("running")]}
        slug="anton"
        liveJobs={{ "job-running": { cwd: "/worktrees/wt1" } }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /investigate/i }));
    await waitFor(() => expect(screen.getByTestId("pty-terminal")).toBeDefined());
    return view;
  }

  it("kills the pty when the job settles while the terminal is open", async () => {
    const fetchMock = lifecycleFetch();
    const { rerender } = await openTerminal(fetchMock);

    // RSC refresh after the job settled (e.g. a confirmed kill): the live handle is gone. The
    // render guard unmounts the panel — the pty must still be torn down, not leaked (PR #75).
    rerender(<JobList jobs={[job("running")]} slug="anton" />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/anton/sessions/s-live/pty",
        expect.objectContaining({ method: "DELETE", keepalive: true }),
      ),
    );
    expect(screen.queryByTestId("pty-terminal")).toBeNull();
  });

  it("kills the pty when the operator closes the terminal", async () => {
    const fetchMock = lifecycleFetch();
    await openTerminal(fetchMock);

    fireEvent.click(screen.getByRole("button", { name: /close/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/anton/sessions/s-live/pty",
        expect.objectContaining({ method: "DELETE", keepalive: true }),
      ),
    );
    expect(screen.queryByTestId("pty-terminal")).toBeNull();
  });
});
