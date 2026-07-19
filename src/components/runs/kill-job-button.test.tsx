// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { JobList } from "@/components/runs/job-list";
import { KillJobButton } from "@/components/runs/kill-job-button";
import type { JobStatus, JobSummary } from "@/lib/jobs-view";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

function job(status: JobStatus): JobSummary {
  return {
    id: `job-${status}`,
    type: "execute-epic",
    status,
    attempts: 1,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_060,
    epicBeadId: "anton-6jni",
  } as JobSummary;
}

/** Arms the two-step confirm and clicks through it. */
function killIt() {
  fireEvent.click(screen.getByRole("button", { name: /force kill/i }));
  fireEvent.click(screen.getByRole("button", { name: /confirm kill/i }));
}

beforeEach(() => {
  refresh.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("JobList kill affordance", () => {
  it.each<JobStatus>(["queued", "running", "parked"])("offers Force kill on a %s job", (status) => {
    render(<JobList jobs={[job(status)]} slug="anton" />);
    expect(screen.getByRole("button", { name: /force kill/i })).toBeDefined();
  });

  it.each<JobStatus>(["done", "failed", "cancelled"])(
    "offers no kill action on a terminal %s job",
    (status) => {
      render(<JobList jobs={[job(status)]} slug="anton" />);
      expect(screen.queryByRole("button", { name: /force kill/i })).toBeNull();
    },
  );

  it("shows the terminal cancelled state and drops the kill action once the kill succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ cancelled: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<JobList jobs={[job("running")]} slug="anton" />);
    expect(screen.getByText("running")).toBeDefined();

    killIt();

    await waitFor(() => expect(screen.getByText("cancelled")).toBeDefined());
    expect(screen.queryByText("running")).toBeNull();
    expect(screen.queryByRole("button", { name: /force kill/i })).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it("keeps a failed job resumable but still shows the row as non-killed when the kill 409s", async () => {
    // A parked job is both resumable and killable; a rejected kill must leave both facts intact.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "Job is not cancellable (already terminal)" }), {
            status: 409,
          }),
        ),
    );

    render(<JobList jobs={[job("parked")]} slug="anton" />);
    killIt();

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(screen.getByRole("alert").textContent).toContain("not cancellable");
    expect(screen.getByText("parked")).toBeDefined();
    expect(screen.queryByText("cancelled")).toBeNull();
    expect(screen.getByRole("button", { name: /resume/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /force kill/i })).toBeDefined();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("KillJobButton", () => {
  it("does not POST until the confirm step — the first click only arms it", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<KillJobButton slug="anton" jobId="j1" />);
    fireEvent.click(screen.getByRole("button", { name: /force kill/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /confirm kill/i })).toBeDefined();
  });

  it("disarms without killing when the user backs out", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<KillJobButton slug="anton" jobId="j1" />);
    fireEvent.click(screen.getByRole("button", { name: /force kill/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /force kill/i })).toBeDefined();
  });

  it("POSTs the project-scoped cancel route on confirm", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ cancelled: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onKilled = vi.fn();

    render(<KillJobButton slug="anton" jobId="j1" onKilled={onKilled} />);
    killIt();

    await waitFor(() => expect(onKilled).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/anton/jobs/j1/cancel", {
      method: "POST",
    });
  });

  it("surfaces a network failure inline and reports no kill", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Failed to fetch")));
    const onKilled = vi.fn();

    render(<KillJobButton slug="anton" jobId="j1" onKilled={onKilled} />);
    killIt();

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Failed to fetch"));
    expect(onKilled).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("falls back to the status code when the error body is unreadable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 500 })));

    render(<KillJobButton slug="anton" jobId="j1" />);
    killIt();

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("500"));
  });

  it("clears a stale error when the operator re-arms for another attempt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Failed to fetch")));

    render(<KillJobButton slug="anton" jobId="j1" />);
    killIt();
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: /force kill/i }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
