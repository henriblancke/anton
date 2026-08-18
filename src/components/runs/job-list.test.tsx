// @vitest-environment jsdom
/**
 * anton-domt: the jobs row, read as its parts. The sibling suites cover one affordance each
 * end-to-end (kill, bulk kill, investigate, view output); this one pins the branching the row
 * itself owns — which status a row shows, which timing it shows, and which actions it offers —
 * against the extracted parts, so a change to one branch is reviewed against that branch alone.
 *
 * next/navigation MUST be mocked — under jsdom there's no App Router provider, so the real
 * `useRouter()` throws inside the action buttons.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import type { JobStatus, JobSummary } from "@/lib/jobs-view";
import { JobList } from "@/components/runs/job-list";
import { JobRowActions, JobRowTiming, JobStatusDot } from "@/components/runs/job-row";
import {
  isActionable,
  jobRowAffordances,
  relativeTime,
  selectableJobIds,
  type JobRowAffordances,
} from "@/components/runs/job-view-utils";
import type { JobRowPanels } from "@/components/runs/use-job-row-panels";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
// Both live panels reach for xterm, which jsdom cannot host; their wiring is asserted by the
// investigate / view-output suites, so a marker is enough here.
vi.mock("@/components/runs/run-terminal", () => ({
  RunTerminal: () => <div data-testid="run-terminal" />,
}));
vi.mock("@/components/pty/pty-terminal", () => ({
  PtyTerminal: () => <div data-testid="pty-terminal" />,
}));

const CREATED = 1_700_000_000;
const UPDATED = 1_700_000_060;
/** An hour after the job was queued, so "in flight" and "settled" timings can't read alike. */
const NOW_MS = (CREATED + 3600) * 1000;

function job(status: JobStatus, overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: `job-${status}`,
    type: "execute-epic",
    status,
    attempts: 1,
    createdAt: CREATED,
    updatedAt: UPDATED,
    epicBeadId: "anton-domt",
    ...overrides,
  };
}

/** Closed panels — the default a freshly rendered row starts from. */
function panels(overrides: Partial<JobRowPanels> = {}): JobRowPanels {
  return {
    investigateSession: null,
    openInvestigate: vi.fn(),
    closeInvestigate: vi.fn(),
    outputOpen: false,
    openOutput: vi.fn(),
    closeOutput: vi.fn(),
    ...overrides,
  };
}

/** The row whose summary line names this epic — the id itself never renders. */
function row(epicBeadId: string): HTMLElement {
  const li = screen.getAllByRole("listitem").find((el) => el.textContent?.includes(epicBeadId));
  if (!li) throw new Error(`no row for ${epicBeadId}`);
  return li;
}

beforeEach(() => {
  // Date only: the armed-kill countdown and testing-library both want real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("jobRowAffordances", () => {
  it("offers resume — and nothing live — on a settled failed job", () => {
    const a = jobRowAffordances({ job: job("failed"), killed: false });
    expect(a).toMatchObject({
      status: "failed",
      active: false,
      resumable: true,
      investigable: false,
      observable: false,
      following: false,
    });
    expect(isActionable(a)).toBe(true);
  });

  it("has nothing to offer on a done job whose log was never recorded", () => {
    const a = jobRowAffordances({ job: job("done"), killed: false });
    expect(a.sessionId).toBeUndefined();
    expect(isActionable(a)).toBe(false);
  });

  it("offers investigate and live output on a running job the instance still holds", () => {
    const a = jobRowAffordances({
      job: job("running"),
      live: { sessionId: "sess-1", cwd: "/wt/1" },
      killed: false,
    });
    expect(a).toMatchObject({
      status: "running",
      active: true,
      resumable: false,
      investigable: true,
      observable: true,
      following: true,
      sessionId: "sess-1",
      liveCwd: "/wt/1",
    });
  });

  it("reads the durable session link once the live handle is gone", () => {
    const a = jobRowAffordances({
      job: job("done"),
      loggedSessionId: "sess-logged",
      killed: false,
    });
    expect(a).toMatchObject({ observable: true, following: false, sessionId: "sess-logged" });
  });

  it("shows a confirmed kill as cancelled and drops every action with it", () => {
    const a = jobRowAffordances({
      job: job("running"),
      live: { sessionId: "sess-1", cwd: "/wt/1" },
      killed: true,
    });
    expect(a).toMatchObject({
      status: "cancelled",
      active: false,
      resumable: false,
      investigable: false,
      observable: false,
    });
  });
});

describe("selectableJobIds", () => {
  it("groups exactly the in-flight rows, minus the ones already killed", () => {
    const jobs = [
      job("queued", { id: "j-queued" }),
      job("running", { id: "j-running" }),
      job("parked", { id: "j-parked" }),
      job("done", { id: "j-done" }),
      job("failed", { id: "j-failed" }),
      job("cancelled", { id: "j-cancelled" }),
    ];
    expect(selectableJobIds(jobs, new Set())).toEqual(["j-queued", "j-running", "j-parked"]);
    expect(selectableJobIds(jobs, new Set(["j-running"]))).toEqual(["j-queued", "j-parked"]);
  });
});

describe("relativeTime", () => {
  it("reads in the largest unit that has ticked, and stays empty without a timestamp", () => {
    expect(relativeTime(undefined)).toBe("");
    expect(relativeTime(NOW_MS / 1000 - 5)).toBe("5s ago");
    expect(relativeTime(NOW_MS / 1000 - 120)).toBe("2m ago");
    expect(relativeTime(NOW_MS / 1000 - 7200)).toBe("2h ago");
    expect(relativeTime(NOW_MS / 1000 - 172_800)).toBe("2d ago");
  });
});

describe("JobStatusDot", () => {
  it("pulses only while the job is in flight", () => {
    const { container } = render(<JobStatusDot status="running" />);
    expect(container.firstElementChild?.className).toContain("anton-pulse");
    cleanup();

    const settled = render(<JobStatusDot status="done" />);
    expect(settled.container.firstElementChild?.className).not.toContain("anton-pulse");
  });
});

describe("JobRowTiming", () => {
  it("counts up from the queue for a job still in flight", () => {
    render(<JobRowTiming job={job("running")} status="running" />);
    expect(screen.getByText("running")).toBeDefined();
    expect(screen.getByText("1h ago")).toBeDefined();
  });

  it("reports how long a settled job took and when it last moved", () => {
    render(<JobRowTiming job={job("done")} status="done" />);
    expect(screen.getByText("done")).toBeDefined();
    expect(screen.getByText("1m 0s · 59m ago")).toBeDefined();
  });
});

describe("JobRowActions", () => {
  /** A settled job with nothing to offer, plus whichever affordance is under test. */
  function affordancesFor(a: Partial<JobRowAffordances>): JobRowAffordances {
    return {
      status: "done",
      active: false,
      resumable: false,
      investigable: false,
      observable: false,
      following: false,
      ...a,
    };
  }

  function renderActions(a: Partial<JobRowAffordances>, p = panels()) {
    return render(
      <JobRowActions
        slug="anton"
        jobId="job-1"
        affordances={affordancesFor(a)}
        panels={p}
        onKilled={vi.fn()}
      />,
    );
  }

  it("renders nothing for a settled job with no session to read", () => {
    const { container } = renderActions({});
    expect(container.firstChild).toBeNull();
  });

  it("offers resume on a recoverable job", () => {
    renderActions({ status: "failed", resumable: true });
    expect(screen.getByRole("button", { name: /resume/i })).toBeDefined();
  });

  it("labels the output link live only while the job is still writing to its log", () => {
    renderActions({ status: "running", active: true, observable: true, following: true });
    expect(screen.getByRole("button", { name: /view live output/i })).toBeDefined();
    cleanup();

    renderActions({ observable: true });
    expect(screen.getByRole("button", { name: /^view output$/i })).toBeDefined();
  });

  it("drops the output link while its panel is already open", () => {
    renderActions({ observable: true }, panels({ outputOpen: true }));
    expect(screen.queryByRole("button", { name: /view output/i })).toBeNull();
  });

  it("drops investigate while its terminal is already attached", () => {
    renderActions(
      { status: "running", active: true, investigable: true },
      panels({ investigateSession: "sess-live" }),
    );
    expect(screen.queryByRole("button", { name: /investigate/i })).toBeNull();
    expect(screen.getByRole("button", { name: /force kill/i })).toBeDefined();
  });

  it("offers a kill on an in-flight job and none on a settled one", () => {
    renderActions({ status: "queued", active: true });
    expect(screen.getByRole("button", { name: /force kill/i })).toBeDefined();
    cleanup();

    renderActions({ status: "failed", resumable: true });
    expect(screen.queryByRole("button", { name: /force kill/i })).toBeNull();
  });
});

describe("JobRow", () => {
  const jobs = [
    job("running", { id: "j-running", epicBeadId: "epic-running" }),
    job("failed", { id: "j-failed", epicBeadId: "epic-failed", lastError: "worktree gone" }),
    job("done", { id: "j-done", epicBeadId: "epic-done" }),
  ];

  it("gives each status its own controls in one list", () => {
    render(
      <JobList
        jobs={jobs}
        slug="anton"
        liveJobs={{ "j-running": { sessionId: "sess-1", cwd: "/wt/1" } }}
      />,
    );

    const running = within(row("epic-running"));
    expect(running.getByRole("button", { name: /investigate/i })).toBeDefined();
    expect(running.getByRole("button", { name: /view live output/i })).toBeDefined();
    expect(running.getByRole("button", { name: /force kill/i })).toBeDefined();
    expect(running.queryByRole("button", { name: /resume/i })).toBeNull();

    const failed = within(row("epic-failed"));
    expect(failed.getByRole("button", { name: /resume/i })).toBeDefined();
    expect(failed.queryByRole("button", { name: /force kill/i })).toBeNull();
    expect(failed.queryByRole("button", { name: /view output/i })).toBeNull();

    const done = within(row("epic-done"));
    expect(done.queryByRole("button", { name: /resume/i })).toBeNull();
    expect(done.queryByRole("button", { name: /force kill/i })).toBeNull();
    expect(done.queryByRole("button", { name: /view output/i })).toBeNull();
  });

  it("reserves the selection column on settled rows so the labels stay aligned", () => {
    render(<JobList jobs={jobs} slug="anton" />);
    // The in-flight row owns the only checkbox; the settled ones carry its width instead.
    expect(within(row("epic-running")).getByRole("checkbox")).toBeDefined();
    expect(within(row("epic-done")).queryByRole("checkbox")).toBeNull();
    expect(row("epic-done").querySelector('span[aria-hidden="true"].size-3\\.5')).not.toBeNull();
  });

  it("expands to the full record — including the error a failed row only summarises", () => {
    render(<JobList jobs={[jobs[1]]} slug="anton" />);
    const summary = screen.getByRole("button", { expanded: false });

    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Last error")).toBeDefined();
    expect(screen.getByText("Job ID")).toBeDefined();

    fireEvent.click(summary);
    expect(screen.queryByText("Last error")).toBeNull();
  });
});
