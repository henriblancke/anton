// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { JobList } from "@/components/runs/job-list";
import type { JobStatus, JobSummary } from "@/lib/jobs-view";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

function job(id: string, status: JobStatus): JobSummary {
  return {
    id,
    type: "execute-epic",
    status,
    attempts: 1,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_060,
    epicBeadId: "anton-mjdo",
  } as JobSummary;
}

/** Every row checkbox — the select-all lives outside the list, so it is never in here. */
function rowCheckboxes(): HTMLInputElement[] {
  return within(screen.getByRole("list")).queryAllByRole("checkbox");
}

function selectAll(): HTMLInputElement {
  return screen.getByRole("checkbox", { name: /select all/i }) as HTMLInputElement;
}

/** The row whose detail line carries this job id. */
function rowFor(jobId: string): HTMLElement {
  const row = screen
    .getAllByRole("listitem")
    .find((li) => within(li).queryByRole("checkbox")?.getAttribute("aria-label")?.includes(jobId));
  if (!row) throw new Error(`no selectable row for ${jobId}`);
  return row;
}

function selectRow(jobId: string) {
  fireEvent.click(within(rowFor(jobId)).getByRole("checkbox"));
}

/** Arms and confirms the bulk kill. */
function bulkKill() {
  fireEvent.click(screen.getByRole("button", { name: /force kill \d+ jobs?/i }));
  fireEvent.click(screen.getByRole("button", { name: /confirm kill \d+ jobs?/i }));
}

function bulkBar(): HTMLElement {
  return screen.getByRole("region", { name: /bulk job actions/i });
}

beforeEach(() => {
  refresh.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("JobList row selection", () => {
  it("offers a checkbox on every cancellable row and none on settled rows", () => {
    render(
      <JobList
        jobs={[
          job("j-queued", "queued"),
          job("j-running", "running"),
          job("j-parked", "parked"),
          job("j-done", "done"),
          job("j-failed", "failed"),
          job("j-cancelled", "cancelled"),
        ]}
        slug="anton"
      />,
    );

    const labels = rowCheckboxes().map((box) => box.getAttribute("aria-label"));
    expect(labels).toHaveLength(3);
    expect(labels.join(" ")).toContain("j-queued");
    expect(labels.join(" ")).toContain("j-running");
    expect(labels.join(" ")).toContain("j-parked");
    expect(labels.join(" ")).not.toContain("j-done");
    expect(labels.join(" ")).not.toContain("j-failed");
    expect(labels.join(" ")).not.toContain("j-cancelled");
  });

  it("offers no selection affordance at all when nothing on the page is cancellable", () => {
    render(<JobList jobs={[job("j-done", "done"), job("j-failed", "failed")]} slug="anton" />);

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByRole("region", { name: /bulk job actions/i })).toBeNull();
  });

  it("selects only the selectable rows from the header control and clears them again", () => {
    render(
      <JobList
        jobs={[job("j-running", "running"), job("j-done", "done"), job("j-queued", "queued")]}
        slug="anton"
      />,
    );

    fireEvent.click(selectAll());
    expect(rowCheckboxes().filter((box) => box.checked)).toHaveLength(2);
    expect(within(bulkBar()).getByText("2 jobs selected")).toBeDefined();

    fireEvent.click(selectAll());
    expect(rowCheckboxes().filter((box) => box.checked)).toHaveLength(0);
    expect(screen.queryByRole("region", { name: /bulk job actions/i })).toBeNull();
  });

  it("goes indeterminate on a partial selection and fully checked once every row is picked", () => {
    render(<JobList jobs={[job("j-a", "running"), job("j-b", "queued")]} slug="anton" />);
    expect(selectAll().indeterminate).toBe(false);

    selectRow("j-a");
    expect(selectAll().indeterminate).toBe(true);
    expect(selectAll().checked).toBe(false);

    selectRow("j-b");
    expect(selectAll().indeterminate).toBe(false);
    expect(selectAll().checked).toBe(true);
  });

  it("drops the selection when the rendered rows change, so a stale one can't be killed", () => {
    const { rerender } = render(
      <JobList jobs={[job("j-a", "running"), job("j-b", "running")]} slug="anton" />,
    );
    fireEvent.click(selectAll());
    expect(within(bulkBar()).getByText("2 jobs selected")).toBeDefined();

    // Page (or filter) changed underneath: a different result set is on screen.
    rerender(<JobList jobs={[job("j-c", "running"), job("j-d", "running")]} slug="anton" />);

    expect(screen.queryByRole("region", { name: /bulk job actions/i })).toBeNull();
    expect(rowCheckboxes().filter((box) => box.checked)).toHaveLength(0);
  });
});

describe("Bulk kill bar", () => {
  it("names the exact count in the confirm step and does not POST until it is confirmed", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <JobList
        jobs={[job("j-a", "running"), job("j-b", "queued"), job("j-c", "parked")]}
        slug="anton"
      />,
    );
    selectRow("j-a");
    selectRow("j-b");

    fireEvent.click(screen.getByRole("button", { name: "Force kill 2 jobs" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Confirm kill 2 jobs" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says one job, not 1 jobs, on a single-row selection", () => {
    render(<JobList jobs={[job("j-a", "running")]} slug="anton" />);
    selectRow("j-a");

    expect(screen.getByRole("button", { name: "Force kill 1 job" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Force kill 1 job" }));
    expect(screen.getByRole("button", { name: "Confirm kill 1 job" })).toBeDefined();
  });

  it("POSTs the selected ids to the batch route", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ cancelled: ["j-a", "j-b"], failed: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<JobList jobs={[job("j-a", "running"), job("j-b", "queued")]} slug="anton" />);
    fireEvent.click(selectAll());
    bulkKill();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projects/anton/jobs/cancel");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ jobIds: ["j-a", "j-b"] });
    expect(refresh).toHaveBeenCalled();
  });

  it("cancels only the ids the server confirmed and surfaces each refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            cancelled: ["j-a"],
            failed: [{ jobId: "j-b", reason: "not-cancellable", error: "Job is not cancellable" }],
          }),
          { status: 200 },
        ),
      ),
    );

    render(<JobList jobs={[job("j-a", "running"), job("j-b", "queued")]} slug="anton" />);
    fireEvent.click(selectAll());
    bulkKill();

    // The confirmed kill is terminal; the refused one keeps its own status.
    await waitFor(() => expect(screen.getByText("cancelled")).toBeDefined());
    expect(screen.getByText("queued")).toBeDefined();
    expect(screen.queryByText("running")).toBeNull();

    const failure = screen.getByRole("alert");
    expect(failure.textContent).toContain("j-b");
    expect(failure.textContent).toContain("not cancellable");

    // The killed row leaves the selectable set entirely; the refused one stays selected.
    expect(rowCheckboxes()).toHaveLength(1);
    expect(within(bulkBar()).getByText("1 job selected")).toBeDefined();
  });

  it("reports nothing as cancelled when the whole batch request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Failed to fetch")));

    render(<JobList jobs={[job("j-a", "running"), job("j-b", "running")]} slug="anton" />);
    fireEvent.click(selectAll());
    bulkKill();

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Failed to fetch"));
    expect(screen.queryByText("cancelled")).toBeNull();
    expect(screen.getAllByText("running")).toHaveLength(2);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("falls back to the status code when the batch is rejected with an unreadable body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 500 })));

    render(<JobList jobs={[job("j-a", "running")]} slug="anton" />);
    fireEvent.click(selectAll());
    bulkKill();

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("500"));
    expect(screen.queryByText("cancelled")).toBeNull();
  });

  it("reports a failure when a 200 carries no readable buckets, rather than claiming a kill", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })));

    render(<JobList jobs={[job("j-a", "running")]} slug="anton" />);
    fireEvent.click(selectAll());
    bulkKill();

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Unexpected"));
    expect(screen.queryByText("cancelled")).toBeNull();
    expect(screen.getByText("running")).toBeDefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("clears stale refusals when the operator re-arms for another attempt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            cancelled: [],
            failed: [{ jobId: "j-a", reason: "not-found", error: "Job not found" }],
          }),
          { status: 200 },
        ),
      ),
    );

    render(<JobList jobs={[job("j-a", "running")]} slug="anton" />);
    fireEvent.click(selectAll());
    bulkKill();
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Force kill 1 job" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the per-row kill working alongside the bulk bar", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ cancelled: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<JobList jobs={[job("j-a", "running"), job("j-b", "running")]} slug="anton" />);
    selectRow("j-a");

    fireEvent.click(within(rowFor("j-b")).getByRole("button", { name: /force kill$/i }));
    fireEvent.click(within(rowFor("j-b")).getByRole("button", { name: /^confirm kill$/i }));

    await waitFor(() => expect(screen.getByText("cancelled")).toBeDefined());
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/anton/jobs/j-b/cancel", {
      method: "POST",
    });
    // The unrelated selection survives a single-row kill.
    expect(within(bulkBar()).getByText("1 job selected")).toBeDefined();
  });
});
