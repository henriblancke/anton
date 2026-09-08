/**
 * The ticket loop's answer to a RETIRED ticket (anton-5bpd), at the two seams PR #238's review found
 * open:
 *
 *   • a ticket the board already holds as superseded is dropped from the run — UNLESS this branch
 *     carries its commit, in which case its work is in the diff and the loop must count it
 *     delivered rather than tell the reviewer the PR does not contain it;
 *   • a retirement that lands under a job that has since been cancelled stays retired, but the
 *     loop stops there — `ctx.heartbeat()` never reads the signal, so nothing else would;
 *   • a run left with nothing live parks on a message that names only what actually settled its
 *     tickets — "abandoned" is a different decision from "superseded";
 *   • the cross-machine reopen of a closed child is decided under that bead's write lock, so it
 *     cannot land between the already-shipped repair's reread of a survivor and its supersede.
 *
 * Mocked at the IO seams only — the ticket walk, git's branch read, bd's writes. The partition, the
 * loop and the delivery verdict all RUN.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LABELS, type Bead } from "../beads/bd";
import { withBeadWriteLock } from "../beads/claim-lock";
import { resumeSkipped } from "../ticket-view";
import type { EpicRun } from "./execute-epic-run";
import type { RunPreparation } from "./execute-epic-prepare";

const runTicketMock = vi.fn<(args: { ticket: Bead }) => Promise<void>>();
vi.mock("./execute-epic-ticket", () => ({
  runTicket: (args: { ticket: Bead }) => runTicketMock(args),
}));

type HasCommitOptions = { base?: string; strict?: boolean };
const hasCommitMock = vi.fn<(worktree: string, id: string, options?: HasCommitOptions) => Promise<boolean>>();
vi.mock("../git/ops", async () => {
  const actual = await vi.importActual<typeof import("../git/ops")>("../git/ops");
  return {
    ...actual,
    worktreeHasCommitFor: (worktree: string, id: string, options?: HasCommitOptions) =>
      hasCommitMock(worktree, id, options),
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
      show: vi.fn(async () => undefined),
    },
  };
});

const { dispatchRunTickets } = await import("./execute-epic-dispatch");
const { TicketRetiredError } = await import("./execute-epic-errors");
const { PoisonEpic } = await import("./errors");
const { beads } = await import("../beads/bd");
const reopenMock = vi.mocked(beads.reopen);
const showMock = vi.mocked(beads.show);

const EPIC = "anton-epic";
const SHIPPER = "anton-ship";
const WORKTREE = "/tmp/anton-worktree";
const BASE_REF = "origin/main";

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
    runStep: { baseRef: BASE_REF },
    worktree: { path: WORKTREE, branch: "anton/anton-epic" },
    readiness: { blockers: [] },
    gated: new Set<string>(),
    isResumeSkipped: (t: Bead) => resumeSkipped(t, false),
  }) as unknown as Extract<RunPreparation, { done: false }>;

const dispatchedIds = () => runTicketMock.mock.calls.map((c) => c[0].ticket.id);

/** A contract the run's re-gate accepts, for a child the loop is about to regenerate. */
const CONTRACT = "## Goal\nShip X.\n\n## Acceptance\nWorks.";

const abandoned = (id: string): Bead =>
  bead(id, { status: "closed", labels: [LABELS.abandoned] });

beforeEach(() => {
  runTicketMock.mockReset().mockResolvedValue(undefined);
  hasCommitMock.mockReset().mockResolvedValue(false);
  reopenMock.mockReset().mockResolvedValue("");
  showMock.mockReset().mockResolvedValue(undefined as unknown as Bead);
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

  // The commit that keeps a superseded ticket live has to be in THIS run's delta (PR #238 review):
  // a `<id>:` commit an earlier merge landed in the base is on the branch's ancestry too, and read
  // there it would keep a settled ticket out of the ledger and in the delivered set of a PR that
  // carries none of it — an all-retired run would then try to open an empty PR.
  it("is retired when its only commit sits in the base's history, not in the branch's delta", async () => {
    hasCommitMock.mockImplementation(async (_worktree, id, options) => id === "anton-a" && !options?.base);
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);

    const outcome = await dispatchRunTickets(run, prep());

    expect(hasCommitMock).toHaveBeenCalledWith(WORKTREE, "anton-a", { base: BASE_REF, strict: true });
    expect(dispatchedIds()).toEqual(["anton-b"]);
    expect(outcome.delivered.map((t) => t.id)).toEqual(["anton-b"]);
    expect(run.retired).toEqual([{ id: "anton-a", replacedBy: SHIPPER, source: "pre-existing" }]);
  });

  // The delta scan failing is not "no commit here" (PR #238 review): the base ref gone or git broken
  // must stop the run, not retire a ticket whose commit may be in the very diff the PR would carry.
  it("stops the run when the branch's delta cannot be read, rather than reading the failure as absence", async () => {
    hasCommitMock.mockImplementation(async (_worktree, id) => {
      if (id === "anton-a") throw new Error("fatal: bad revision 'origin/main..HEAD'");
      return false;
    });
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);

    await expect(dispatchRunTickets(run, prep())).rejects.toThrow(PoisonEpic);
    await expect(dispatchRunTickets(run, prep())).rejects.toThrow(
      /anton-a is superseded on the board, and anton could not read the commits `anton\/anton-epic` carries beyond origin\/main[\s\S]*bad revision/,
    );
    expect(dispatchedIds()).toEqual([]);
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

describe("a run left with nothing live", () => {
  const park = (tickets: Bead[]) =>
    dispatchRunTickets(makeRun(tickets, new AbortController().signal), prep()).then(
      () => {
        throw new Error("expected the run to park");
      },
      (e: Error) => e.message,
    );

  // Every ticket was superseded on the board, none abandoned (PR #238 review): the message must not
  // tell the operator a won't-do was recorded when the board says the work shipped elsewhere.
  it("names only the supersedes when no ticket was abandoned", async () => {
    const message = await park([superseded("anton-a", SHIPPER), superseded("anton-b", SHIPPER)]);

    expect(message).toContain("already settled as superseded on the board");
    expect(message).not.toContain("abandoned");
  });

  it("names only the abandon when no ticket was superseded", async () => {
    const message = await park([abandoned("anton-a")]);

    expect(message).toContain("has been abandoned");
    expect(message).not.toContain("superseded");
  });

  it("names both when the board holds one of each", async () => {
    const message = await park([abandoned("anton-a"), superseded("anton-b", SHIPPER)]);

    expect(message).toContain("been abandoned");
    expect(message).toContain("already settled as superseded on the board");
  });
});

describe("the cross-machine reopen of a closed child", () => {
  const closedChild = (id: string) => bead(id, { status: "closed", description: CONTRACT });
  const makeResume = (child: Bead) => {
    const run = makeRun([child], new AbortController().signal);
    (run.target as Bead).description = CONTRACT;
    return run;
  };

  // The already-shipped repair rereads a survivor under its write lock and supersedes the target
  // against it; the reopen has to queue on that same lock, or it lands in between (PR #238 review).
  it("waits on the bead's write lock before it writes", async () => {
    const child = closedChild("anton-a");
    showMock.mockResolvedValue(child);
    let release!: () => void;
    const held = withBeadWriteLock(
      "/tmp/anton-repo",
      "anton-a",
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    const dispatch = dispatchRunTickets(makeResume(child), prep());
    await new Promise((r) => setTimeout(r, 20));
    expect(reopenMock).not.toHaveBeenCalled();
    expect(runTicketMock).not.toHaveBeenCalled();

    release();
    await held;
    await dispatch;

    expect(reopenMock).toHaveBeenCalledWith("/tmp/anton-repo", "anton-a");
    expect(dispatchedIds()).toEqual(["anton-a"]);
  });

  it("reopens a bead the fresh read still finds closed", async () => {
    const child = closedChild("anton-a");
    showMock.mockResolvedValue(child);

    await dispatchRunTickets(makeResume(child), prep());

    expect(reopenMock).toHaveBeenCalledTimes(1);
    expect(dispatchedIds()).toEqual(["anton-a"]);
  });

  it("leaves alone a bead somebody reopened since the run's snapshot", async () => {
    const child = closedChild("anton-a");
    showMock.mockResolvedValue({ ...child, status: "open" });

    await dispatchRunTickets(makeResume(child), prep());

    expect(reopenMock).not.toHaveBeenCalled();
    expect(dispatchedIds()).toEqual(["anton-a"]);
  });
});
