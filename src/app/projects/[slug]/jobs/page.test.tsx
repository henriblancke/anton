// @vitest-environment jsdom
/**
 * THE RECORD ON THE JOBS PAGE (anton-hzce).
 *
 * An auto-applied proposal closes the moment it is filed, so it never stands on the board as an open
 * ask — it goes straight from "not yet filed" to "closed". This page is therefore the only place a
 * founder can see an unattended write BEFORE finding a bead already moved, which is why the suite
 * runs the whole chain: a session log's real text in, rendered counts and reasons out. Only the two
 * stores are stubbed (the jobs table and the session link); the parser, the summary and the panel
 * are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import type { JobSummary, JobType } from "@/lib/jobs-view";
import type { JobSessionLink } from "@/lib/sessions";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/projects/anton/jobs",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/lib/projects", () => ({
  getProjectBySlug: async () => ({ id: "p1", slug: "anton", name: "anton" }),
}));
vi.mock("@/lib/jobs/service", () => ({ getRunningJobInfos: () => ({}) }));
vi.mock("@/lib/runs", () => ({ countRuns: async () => 0 }));

let jobs: JobSummary[] = [];
vi.mock("@/lib/jobs-view", () => ({
  countJobs: async () => jobs.length,
  listJobsPaged: async () => jobs,
}));

let sessions: Record<string, JobSessionLink> = {};
let logs: Record<string, string> = {};
vi.mock("@/lib/sessions", () => ({
  sessionsByJob: async () => sessions,
  readSessionLogLines: async (logPath: string, keep: (line: string) => boolean) => ({
    lines: (logs[logPath] ?? "").split("\n").filter(keep),
    truncated: false,
    unreadable: !(logPath in logs),
  }),
}));

function job(id: string, type: JobType): JobSummary {
  return { id, type, status: "done", attempts: 1, createdAt: 1_700_000_000, updatedAt: 1_700_000_060 };
}

/** Point a job at a session whose log holds `log`. */
function pass(id: string, type: JobType, log: string): JobSummary {
  const logPath = `/logs/${id}.log`;
  sessions[id] = { id: `s-${id}`, logPaths: [logPath] };
  logs[logPath] = log;
  return job(id, type);
}

async function renderPage() {
  const { default: ProjectJobsPage } = await import("./page");
  return render(
    await ProjectJobsPage({
      params: Promise.resolve({ slug: "anton" }),
      searchParams: Promise.resolve({}),
    }),
  );
}

/** Open a job row's detail — the record lives under it. */
function expand(type: string) {
  fireEvent.click(screen.getByRole("button", { expanded: false, name: new RegExp(type) }));
}

function record() {
  return within(screen.getByRole("region", { name: "Proposals" }));
}

const APPLIED =
  "[gardener] APPLY p-1 (shipped-orphan) retire/close t-4 — APPLIED: closed t-4 as shipped\n";
const REFUSED =
  "[gardener] APPLY p-2 (stale) retire/defer t-7 — REFUSED: cannot apply p-2: t-7 was written " +
  "after this proposal was filed — its evidence is stale\n";
const SHADOWED =
  "[gardener] SHADOW p-3 (mispriority) repriority t-9 — WOULD APPLY: set t-9 to P1\n";

beforeEach(() => {
  jobs = [];
  sessions = {};
  logs = {};
});

afterEach(() => {
  cleanup();
  vi.resetModules();
});

describe("jobs page — what each pass applied, shadowed and refused", () => {
  it("shows counts per outcome on the row, before anything is expanded", async () => {
    jobs = [pass("g1", "gardener", APPLIED + REFUSED + SHADOWED)];
    await renderPage();

    // The founder scanning the list is this record's first reader: an unattended write has to be
    // visible without a click.
    expect(screen.getByText("1 applied")).toBeTruthy();
    expect(screen.getByText("1 refused")).toBeTruthy();
    expect(screen.getByText("1 shadowed")).toBeTruthy();
  });

  it("details each applied, shadowed and refused proposal under the row", async () => {
    jobs = [pass("g1", "gardener", APPLIED + REFUSED + SHADOWED)];
    await renderPage();
    expand("gardener");

    expect(record().getByText("closed t-4 as shipped", { exact: false })).toBeTruthy();
    expect(record().getByText("set t-9 to P1", { exact: false })).toBeTruthy();
    expect(record().getByText(/shipped-orphan/)).toBeTruthy();
    expect(record().getByText(/retire\/close t-4/)).toBeTruthy();
  });

  it("gives a refusal planApply's own reason, so 'the board moved' reads apart from 'evidence went stale'", async () => {
    jobs = [pass("g1", "gardener", REFUSED)];
    await renderPage();
    expand("gardener");

    expect(
      record().getByText(/t-7 was written after this proposal was filed — its evidence is stale/),
    ).toBeTruthy();
    // And it is named a refusal by the board, not an anton failure: a founder acts on those
    // differently, and only one of them is a bug.
    expect(record().getByText("1 refused")).toBeTruthy();
  });

  it("links every entry to its proposal bead, so the evidence is one click from the record", async () => {
    jobs = [pass("g1", "gardener", APPLIED + REFUSED)];
    await renderPage();
    expand("gardener");

    const hrefs = record()
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/projects/anton/epics/p-1", "/projects/anton/epics/p-2"]);
  });

  it("reads a pass that applied nothing as a clean pass, not as an empty state", async () => {
    // A patrol over a clean board opens no session at all, which is the shape most nights take.
    jobs = [job("quiet", "gardener")];
    await renderPage();

    expect(screen.queryByText(/applied$/)).toBeNull();
    expand("gardener");
    expect(record().getByText("Clean pass — nothing applied, shadowed or refused.")).toBeTruthy();
  });

  it("shows what an EARLIER attempt applied, not just the retry that succeeded", async () => {
    // A pass that applied a proposal unattended and then failed is retried under the same job id,
    // opening a second session. The writes of the first attempt are on the board either way — a
    // record that showed only the newest session would render the whole job as a clean pass.
    jobs = [job("g1", "gardener")];
    sessions["g1"] = { id: "s-latest", logPaths: ["/logs/first.log", "/logs/latest.log"] };
    logs["/logs/first.log"] = APPLIED;
    logs["/logs/latest.log"] = SHADOWED;

    await renderPage();
    expand("gardener");

    expect(record().queryByText(/Clean pass/)).toBeNull();
    expect(record().getByText("closed t-4 as shipped", { exact: false })).toBeTruthy();
    expect(record().getByText("set t-9 to P1", { exact: false })).toBeTruthy();
  });

  it("never calls a pass clean when the write cap held proposals back", async () => {
    jobs = [
      pass(
        "g1",
        "gardener",
        "[gardener] APPLY held back 2 armed proposal(s) — one pass applies at most 3; they stay " +
          "open as ordinary asks (p-8, p-9)\n",
      ),
    ];
    await renderPage();
    expand("gardener");

    expect(record().queryByText(/Clean pass/)).toBeNull();
    expect(record().getByText(/held back 2 armed proposal\(s\)/)).toBeTruthy();
  });

  it("never calls a pass clean when its log could not be read", async () => {
    // The session row stands but its disposable log is gone. Silence here is not a result: this
    // record is the only view of an unattended write, so a failed read must read as a failed read
    // rather than as a pass that wrote nothing.
    jobs = [job("g1", "gardener")];
    sessions["g1"] = { id: "s-g1", logPaths: ["/logs/vanished.log"] };
    await renderPage();
    expand("gardener");

    expect(record().queryByText(/Clean pass/)).toBeNull();
    expect(record().getByText(/session log could not be read/)).toBeTruthy();
  });

  it("separates a write that broke from a move the board declined", async () => {
    jobs = [
      pass(
        "pm1",
        "product-master",
        "[product-master] APPLY p-5 (low-value) retire/defer t-2 — COULD NOT APPLY: applying p-5 " +
          "failed: bd exited 1; rolled back\n",
      ),
    ];
    await renderPage();
    expand("product-master");

    expect(record().getByText("1 could not apply")).toBeTruthy();
    expect(record().queryByText(/^1 refused$/)).toBeNull();
  });

  it("separates a shadow that broke from an apply that broke — one of them touched the board", async () => {
    // A shadow that could not be evaluated attempted no write at all. Calling it "could not apply"
    // — under a blurb about a write that may have been rolled back — describes an event that never
    // happened, and sends a founder looking for a board change nobody made.
    jobs = [
      pass(
        "g1",
        "gardener",
        "[gardener] SHADOW p-4 (mispriority) repriority t-9 — COULD NOT SHADOW: board unreadable\n",
      ),
    ];
    await renderPage();
    expand("gardener");

    expect(record().getByText("1 could not shadow")).toBeTruthy();
    expect(record().queryByText(/could not apply/)).toBeNull();
    expect(record().getByText(/no write was attempted/)).toBeTruthy();
  });

  it("says nothing about a job that files no proposals", async () => {
    jobs = [pass("e1", "execute-epic", APPLIED)];
    await renderPage();
    expand("execute-epic");

    expect(screen.queryByRole("region", { name: "Proposals" })).toBeNull();
  });
});
