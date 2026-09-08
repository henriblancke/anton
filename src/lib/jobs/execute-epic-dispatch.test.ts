/**
 * The ticket loop's answer to a RETIRED ticket (anton-5bpd), at the two seams PR #238's review found
 * open:
 *
 *   • a ticket the board already holds as superseded is dropped from the run — UNLESS this branch
 *     carries its commit, in which case its work is in the diff and the loop must count it
 *     delivered rather than tell the reviewer the PR does not contain it;
 *   • a retirement that lands under a job that has since been cancelled stays retired, but the
 *     loop stops there — `ctx.heartbeat()` never reads the signal, so nothing else would.
 *
 * Mocked at the IO seams only — the ticket walk, git's branch read, bd's writes. The partition, the
 * loop and the delivery verdict all RUN.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "../beads/bd";
import { resumeSkipped } from "../ticket-view";
import type { EpicRun } from "./execute-epic-run";
import type { RunPreparation } from "./execute-epic-prepare";

const runTicketMock = vi.fn<(args: { ticket: Bead }) => Promise<void>>();
vi.mock("./execute-epic-ticket", () => ({
  runTicket: (args: { ticket: Bead }) => runTicketMock(args),
}));

const hasCommitMock = vi.fn<(worktree: string, id: string) => Promise<boolean>>();
vi.mock("../git/ops", async () => {
  const actual = await vi.importActual<typeof import("../git/ops")>("../git/ops");
  return {
    ...actual,
    worktreeHasCommitFor: (worktree: string, id: string) => hasCommitMock(worktree, id),
  };
});

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      note: vi.fn(async () => ""),
      tag: vi.fn(async () => ""),
      untag: vi.fn(async () => ""),
      reopen: vi.fn(async () => ""),
    },
  };
});

const { dispatchRunTickets } = await import("./execute-epic-dispatch");
const { TicketRetiredError } = await import("./execute-epic-errors");

const EPIC = "anton-epic";
const SHIPPER = "anton-ship";
const WORKTREE = "/tmp/anton-worktree";

const bead = (id: string, over: Partial<Bead> = {}): Bead =>
  ({ id, title: id, status: "open", issue_type: "task", parent: EPIC, labels: [], ...over }) as Bead;

/** A child closed as superseded by `by` — the `supersedes` edge `bd supersede` writes beside the close. */
const superseded = (id: string, by: string): Bead =>
  bead(id, {
    status: "closed",
    dependencies: [{ issue_id: id, depends_on_id: by, type: "supersedes" }],
  } as Partial<Bead>);

function makeRun(tickets: Bead[], signal: AbortSignal): EpicRun {
  const target = bead(EPIC, { issue_type: "epic", status: "in_progress", parent: undefined });
  return {
    repo: "/tmp/anton-repo",
    targetId: EPIC,
    ctx: { signal, heartbeat: vi.fn(async () => {}), report: vi.fn() },
    standaloneRun: false,
    lease: { assertHeld: () => {} },
    settings: { agents: [] },
    target,
    tickets,
    all: [target, ...tickets, bead(SHIPPER, { status: "closed", parent: undefined })],
    timedOut: [],
    retired: [],
    userAgentIds: [],
    operator: "op-1",
    ticketTimeoutMs: Infinity,
    childCascade: null,
  } as unknown as EpicRun;
}

const prep = (): Extract<RunPreparation, { done: false }> =>
  ({
    done: false,
    ticketSteps: [],
    runSteps: [],
    runStep: {},
    worktree: { path: WORKTREE },
    readiness: { blockers: [] },
    gated: new Set<string>(),
    isResumeSkipped: (t: Bead) => resumeSkipped(t, false),
  }) as unknown as Extract<RunPreparation, { done: false }>;

const dispatchedIds = () => runTicketMock.mock.calls.map((c) => c[0].ticket.id);

beforeEach(() => {
  runTicketMock.mockReset().mockResolvedValue(undefined);
  hasCommitMock.mockReset().mockResolvedValue(false);
});

describe("a ticket the board already holds as superseded", () => {
  it("is dropped from the run when nothing on this branch carries it", async () => {
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);

    const outcome = await dispatchRunTickets(run, prep());

    expect(dispatchedIds()).toEqual(["anton-b"]);
    expect(outcome.delivered.map((t) => t.id)).toEqual(["anton-b"]);
    expect(run.retired).toEqual([{ id: "anton-a", replacedBy: SHIPPER, source: "pre-existing" }]);
  });

  // A child that committed and closed on an earlier attempt, then was superseded by hand before the
  // retry (PR #238 review): its commit is in this branch's diff, so the PR body has to list it and
  // the retirement notice must not claim the PR leaves it out.
  it("stays DELIVERED when this branch carries its commit — the diff outranks the board's edge", async () => {
    hasCommitMock.mockImplementation(async (worktree, id) => worktree === WORKTREE && id === "anton-a");
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);

    const outcome = await dispatchRunTickets(run, prep());

    expect(dispatchedIds()).toEqual(["anton-b"]); // its work is here, so it is skipped, never re-run
    expect(outcome.delivered.map((t) => t.id)).toEqual(["anton-a", "anton-b"]);
    expect(run.retired).toEqual([]);
  });
});

describe("a retirement landing under a cancelled job", () => {
  const retire = (controller?: AbortController) =>
    runTicketMock.mockImplementation(async ({ ticket }) => {
      if (ticket.id !== "anton-a") return;
      // The supersede is on the board before the kill lands — the settlement lets it stand.
      controller?.abort();
      throw new TicketRetiredError("anton-a", SHIPPER, "retired anton-a as superseded by anton-ship");
    });

  it("keeps the retirement and stops the loop, rather than claim the next ticket under the kill", async () => {
    const controller = new AbortController();
    retire(controller);
    const run = makeRun([bead("anton-a"), bead("anton-b")], controller.signal);

    await expect(dispatchRunTickets(run, prep())).rejects.toMatchObject({ name: "AbortError" });

    expect(run.retired).toEqual([{ id: "anton-a", replacedBy: SHIPPER, source: "this-run" }]);
    expect(dispatchedIds()).toEqual(["anton-a"]);
  });

  it("carries the run on to the next ticket under a signal that never fires", async () => {
    retire();
    const run = makeRun([bead("anton-a"), bead("anton-b")], new AbortController().signal);

    const outcome = await dispatchRunTickets(run, prep());

    expect(dispatchedIds()).toEqual(["anton-a", "anton-b"]);
    expect(run.retired).toEqual([{ id: "anton-a", replacedBy: SHIPPER, source: "this-run" }]);
    expect(outcome.delivered.map((t) => t.id)).toEqual(["anton-b"]);
  });
});
