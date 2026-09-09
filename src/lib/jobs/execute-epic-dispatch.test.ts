/**
 * The ticket loop's answer to a RETIRED ticket (anton-5bpd), at the two seams PR #238's review found
 * open:
 *
 *   • a ticket the board already holds as superseded is dropped from the run — UNLESS this branch
 *     carries its commit, in which case its work is in the diff and the loop must count it
 *     delivered rather than tell the reviewer the PR does not contain it;
 *   • a retirement that lands under a job that has since been cancelled stays retired, but the
 *     loop stops there — `ctx.heartbeat()` never reads the signal, so nothing else would — and the
 *     loop writes nothing to the board for a retirement it made itself: its `not-delivered` marker
 *     is the settlement's, written under the ticket's lock before the claim comes off;
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
import type { TicketOutcome } from "./execute-epic-ticket";

/** What a ticket that ran to its own commit settles as — the walk's ordinary answer. */
const COMMITTED: TicketOutcome = { how: "committed", closed: true };
const runTicketMock = vi.fn<(args: { ticket: Bead }) => Promise<TicketOutcome>>();
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
      list: vi.fn(async () => []),
    },
  };
});

const { dispatchRunTickets } = await import("./execute-epic-dispatch");
const { TicketRetiredError } = await import("./execute-epic-errors");
const { PoisonEpic } = await import("./errors");
const { beads } = await import("../beads/bd");
const reopenMock = vi.mocked(beads.reopen);
const showMock = vi.mocked(beads.show);
const listMock = vi.mocked(beads.list);
const tagMock = vi.mocked(beads.tag);
const untagMock = vi.mocked(beads.untag);

const EPIC = "anton-epic";
/** Another run target, for the rehome cases: the owner a reparented ticket now answers to. */
const OTHER_EPIC = "anton-other-epic";
/** An intermediate task between the epic and its subtask — the bead a nested rehome actually moves. */
const MIDDLE = "anton-middle";
const SHIPPER = "anton-ship";
const WORKTREE = "/tmp/anton-worktree";
const BASE_REF = "origin/main";
/** The immutable commit `origin/main` forked from — what the delta scan is pinned to, not the ref. */
const FORK_POINT = "f0f0f0fork";

const bead = (id: string, over: Partial<Bead> = {}): Bead =>
  ({ id, title: id, status: "open", issue_type: "task", parent: EPIC, labels: [], ...over }) as Bead;

/** A child closed as superseded by `by` — the `supersedes` edge `bd supersede` writes beside the close. */
const superseded = (id: string, by: string): Bead =>
  bead(id, {
    status: "closed",
    dependencies: [{ issue_id: id, depends_on_id: by, type: "supersedes" }],
  } as Partial<Bead>);

/** The board as bd answers a fresh `show` — the run's snapshot, unless a case moves a bead on. */
let board: Bead[] = [];

function makeRun(tickets: Bead[], signal: AbortSignal): EpicRun {
  const target = bead(EPIC, { issue_type: "epic", status: "in_progress", parent: undefined });
  board = [target, ...tickets];
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
    runStep: { baseRef: BASE_REF, baseForkSha: FORK_POINT },
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
  board = [];
  runTicketMock.mockReset().mockResolvedValue(COMMITTED);
  hasCommitMock.mockReset().mockResolvedValue(false);
  reopenMock.mockReset().mockResolvedValue("");
  // Faithful default: a tag/untag the subsequent `show` reads back on the board bead, so the
  // post-write reread in retireFound sees the marker it just wrote (PR #238 review).
  tagMock.mockReset().mockImplementation(async (_repo: string, id: string, labels: string[]) => {
    board = board.map((b) =>
      b.id === id ? ({ ...b, labels: [...new Set([...(b.labels ?? []), ...labels])] } as Bead) : b,
    );
    return "";
  });
  untagMock.mockReset().mockImplementation(async (_repo: string, id: string, labels: string[]) => {
    board = board.map((b) =>
      b.id === id ? ({ ...b, labels: (b.labels ?? []).filter((l) => !labels.includes(l)) } as Bead) : b,
    );
    return "";
  });
  showMock.mockReset().mockImplementation(async (_repo: string, id: string) => board.find((b) => b.id === id)!);
  // The ancestry recompute reads the FULL board, not one bead (PR #238 review): the same mutable
  // `board` every case moves, so a reparent shows up in the owner walk exactly as bd would report it.
  listMock.mockReset().mockImplementation(async () => board);
});

/** Every ticket the loop marked `not-delivered`. */
const markedNotDelivered = () =>
  tagMock.mock.calls.filter((c) => c[2].includes(LABELS.notDelivered)).map((c) => c[1]);

describe("a ticket the board already holds as superseded", () => {
  it("is dropped from the run when nothing on this branch carries it", async () => {
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);

    const outcome = await dispatchRunTickets(run, prep());

    expect(dispatchedIds()).toEqual(["anton-b"]);
    expect(outcome.delivered.map((t) => t.id)).toEqual(["anton-b"]);
    expect(run.retired).toEqual([{ id: "anton-a", replacedBy: SHIPPER, source: "pre-existing" }]);
    // Marked as work this run does not deliver (PR #238 review): reopened while the PR sits in
    // review, it is an open child with nothing in that diff, and the marker is the only thing that
    // keeps merge finalization from closing it as shipped.
    expect(markedNotDelivered()).toEqual(["anton-a"]);
  });

  // The snapshot says superseded; the board, read under the ticket's lock, says an operator has
  // reopened it since (PR #238 review). The reopen is a person saying the work is NOT done, so the
  // ticket is live work again — dispatched, not dropped on a supersede the board no longer holds.
  it("stays LIVE when a fresh read under its lock finds it reopened since the snapshot", async () => {
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);
    board = board.map((b) => (b.id === "anton-a" ? ({ ...b, status: "open" } as Bead) : b));

    const outcome = await dispatchRunTickets(run, prep());

    expect(dispatchedIds()).toEqual(["anton-a", "anton-b"]);
    expect(outcome.delivered.map((t) => t.id)).toEqual(["anton-a", "anton-b"]);
    expect(run.retired).toEqual([]);
    expect(markedNotDelivered()).toEqual([]);
  });

  // A reopen on a shared-server board can also REHOME the ticket onto another run's target
  // (PR #238 review). Returning it as live would feed the loop the stale snapshot — reopenForRegeneration
  // no-ops on the already-open bead and runTicket claims it by id, running work that now belongs to
  // that other target. Stop instead of dispatching a ticket a different run target now owns.
  it("stops the run when the fresh read finds it reopened AND reparented onto another target", async () => {
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);
    board = [
      ...board.map((b) => (b.id === "anton-a" ? ({ ...b, status: "open", parent: OTHER_EPIC } as Bead) : b)),
      bead(OTHER_EPIC, { issue_type: "epic", parent: undefined }),
    ];

    await expect(dispatchRunTickets(run, prep())).rejects.toThrow(
      new RegExp(`anton-a was superseded on the board this run read but has since been reopened and now runs under ${OTHER_EPIC}`),
    );
    expect(dispatchedIds()).toEqual([]);
    expect(run.retired).toEqual([]);
    expect(markedNotDelivered()).toEqual([]);
  });

  // The rehome the DIRECT-parent compare misses (PR #238 review): under epic → task → subtask, only
  // the intermediate task moves, so `parentOf(subtask)` is untouched while its run target is now
  // another epic's. The owner has to be recomputed from a fresh board's ancestry, not the edge.
  it("stops the run when an ANCESTOR is rehomed though the ticket's own parent is unchanged", async () => {
    const subtask = superseded("anton-a", SHIPPER);
    const run = makeRun([{ ...subtask, parent: MIDDLE } as Bead, bead("anton-b")], new AbortController().signal);
    board = [
      ...board.map((b) => (b.id === "anton-a" ? ({ ...b, status: "open" } as Bead) : b)),
      // The intermediate task now hangs off another epic; the subtask's own `parent` still says MIDDLE.
      bead(MIDDLE, { parent: OTHER_EPIC }),
      bead(OTHER_EPIC, { issue_type: "epic", parent: undefined }),
    ];

    await expect(dispatchRunTickets(run, prep())).rejects.toThrow(
      new RegExp(`anton-a was superseded on the board this run read but has since been reopened and now runs under ${OTHER_EPIC}`),
    );
    expect(dispatchedIds()).toEqual([]);
    expect(run.retired).toEqual([]);
    expect(markedNotDelivered()).toEqual([]);
  });

  // An unreadable board is no answer about ownership, and this write is guarded on that answer —
  // stop rather than dispatch a ticket that may belong to another target (PR #238 review).
  it("stops the run when the board cannot be read back to recompute the owner", async () => {
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);
    board = board.map((b) => (b.id === "anton-a" ? ({ ...b, status: "open" } as Bead) : b));
    listMock.mockRejectedValue(new Error("dolt: connection refused"));

    await expect(dispatchRunTickets(run, prep())).rejects.toThrow(
      /bd would not read the board back, so anton cannot recompute which run target now owns it/,
    );
    expect(dispatchedIds()).toEqual([]);
    expect(run.retired).toEqual([]);
    expect(markedNotDelivered()).toEqual([]);
  });

  it("decides the retirement under the ticket's write lock, not on the snapshot", async () => {
    const run = makeRun([superseded("anton-a", SHIPPER)], new AbortController().signal);
    let release!: () => void;
    const held = withBeadWriteLock(
      "/tmp/anton-repo",
      "anton-a",
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    const dispatch = dispatchRunTickets(run, prep()).catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 20));
    expect(showMock).not.toHaveBeenCalled();
    expect(run.retired).toEqual([]);

    // The lock holder reopens the ticket before it lets go — the run must see that read, not its own.
    board = board.map((b) => (b.id === "anton-a" ? ({ ...b, status: "open" } as Bead) : b));
    release();
    await held;
    await dispatch;

    expect(run.retired).toEqual([]);
    expect(dispatchedIds()).toEqual(["anton-a"]);
  });

  // Unreadable is not "still superseded" and not "reopened" (PR #238 review): retired, a reopen is
  // silently reversed; kept live, a retirement an earlier attempt verified is re-run. Stop instead.
  it("stops the run when bd cannot read the superseded ticket back", async () => {
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);
    showMock.mockRejectedValue(new Error("dolt: connection refused"));

    await expect(dispatchRunTickets(run, prep())).rejects.toThrow(PoisonEpic);
    await expect(dispatchRunTickets(run, prep())).rejects.toThrow(
      /anton-a is superseded on the board this run read, but bd would not read the ticket back/,
    );
    expect(dispatchedIds()).toEqual([]);
    expect(run.retired).toEqual([]);
  });

  it("stops the run rather than open a PR when the marker cannot be written", async () => {
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);
    tagMock.mockRejectedValue(new Error("dolt: connection refused"));

    await expect(dispatchRunTickets(run, prep())).rejects.toThrow(
      /anton-a is retired as already shipped, but bd would not record `not-delivered` on it/,
    );
    expect(dispatchedIds()).toEqual([]);
    expect(run.retired).toEqual([]);
  }, 10_000);

  // The lock orders only this process (PR #238 review): another process reopens and claims the
  // ticket between the locked read and the marker landing, and a run that snapshotted the reopened
  // bead before the tag never clears it at its claim gate. So the marker is re-read once it is on
  // the board, and a ticket that moved gets it taken back and goes live instead of retired.
  it("withdraws the marker and stays LIVE when the ticket moved between the read and the marker landing", async () => {
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);
    tagMock.mockImplementation(async (_repo: string, id: string, labels: string[]) => {
      if (id === "anton-a" && labels.includes(LABELS.notDelivered)) {
        board = board.map((b) =>
          b.id === "anton-a"
            ? ({ ...b, status: "in_progress", assignee: "someone-else", labels: [LABELS.notDelivered] } as Bead)
            : b,
        );
      }
      return "";
    });

    const outcome = await dispatchRunTickets(run, prep());

    expect(markedNotDelivered()).toEqual(["anton-a"]);
    expect(untagMock).toHaveBeenCalledWith("/tmp/anton-repo", "anton-a", [LABELS.notDelivered]);
    expect(run.retired).toEqual([]);
    expect(dispatchedIds()).toEqual(["anton-a", "anton-b"]);
    expect(outcome.delivered.map((t) => t.id)).toEqual(["anton-a", "anton-b"]);
  });

  it("keeps the retirement, unwithdrawn, when the post-write read still finds it superseded", async () => {
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);

    await dispatchRunTickets(run, prep());

    expect(showMock.mock.calls.filter((c) => c[1] === "anton-a")).toHaveLength(2);
    expect(untagMock).not.toHaveBeenCalled();
    expect(run.retired).toEqual([{ id: "anton-a", replacedBy: SHIPPER, source: "pre-existing" }]);
  });

  // Still superseded on the reread but with the marker gone is the race the fence has to close the
  // other way (PR #238 review): another process cleared `not-delivered` between the tag and the
  // reread, and a run that accepted the supersede alone would open a PR whose merge reads the
  // ticket as work no run reserved — reopened in review, closed as shipped. Stop on the missing
  // marker rather than open that PR.
  it("stops the run when the marker is stripped before the reread but the ticket stays superseded", async () => {
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);
    tagMock.mockImplementation(async (_repo: string, id: string, labels: string[]) => {
      if (id === "anton-a" && labels.includes(LABELS.notDelivered)) {
        // Lands the tag, then a concurrent writer clears it while the supersede still stands.
        board = board.map((b) => (b.id === "anton-a" ? ({ ...b, labels: [] } as Bead) : b));
      }
      return "";
    });

    await expect(dispatchRunTickets(run, prep())).rejects.toThrow(
      /anton-a is superseded on the reread that fenced its retirement, but the `not-delivered` marker anton just wrote is gone/,
    );
    expect(dispatchedIds()).toEqual([]);
    expect(run.retired).toEqual([]);
    expect(untagMock).not.toHaveBeenCalled();
  }, 10_000);

  // A marker on the board and a bead that will not read back is neither "still superseded" nor
  // "reopened": stop rather than open a PR on either guess.
  it("stops the run when bd cannot read the ticket back after the marker landed", async () => {
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);
    showMock.mockImplementation(async (_repo: string, id: string) => {
      const b = board.find((x) => x.id === id)!;
      if (id === "anton-a" && markedNotDelivered().includes("anton-a")) throw new Error("dolt: connection refused");
      return b;
    });

    await expect(dispatchRunTickets(run, prep())).rejects.toThrow(
      /anton-a is retired as already shipped and now carries `not-delivered`, but bd would not read the ticket back/,
    );
    expect(dispatchedIds()).toEqual([]);
    expect(run.retired).toEqual([]);
  }, 10_000);

  it("stops the run when a marker on a ticket that moved cannot be taken back", async () => {
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);
    tagMock.mockImplementation(async (_repo: string, id: string) => {
      if (id === "anton-a") board = board.map((b) => (b.id === "anton-a" ? ({ ...b, status: "open" } as Bead) : b));
      return "";
    });
    untagMock.mockRejectedValue(new Error("dolt: connection refused"));

    await expect(dispatchRunTickets(run, prep())).rejects.toThrow(
      /anton-a was reopened while anton was retiring it as already shipped, and bd would not clear the `not-delivered` marker/,
    );
    expect(dispatchedIds()).toEqual([]);
    expect(run.retired).toEqual([]);
  }, 10_000);

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
  // carries none of it — an all-retired run would then try to open an empty PR. And the delta is
  // pinned to the fork COMMIT, never the mutable `origin/<base>` ref: a sibling run rewinding that
  // ref behind the fork point would widen `<base>..HEAD` back into pre-fork history and let the same
  // stale commit read as this run's delivery, so partition against the resolved fork point instead.
  it("is retired when its only commit sits in the base's history, not in the branch's delta", async () => {
    hasCommitMock.mockImplementation(async (_worktree, id, options) => id === "anton-a" && !options?.base);
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);

    const outcome = await dispatchRunTickets(run, prep());

    expect(hasCommitMock).toHaveBeenCalledWith(WORKTREE, "anton-a", { base: FORK_POINT, strict: true });
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
      if (ticket.id !== "anton-a") return COMMITTED;
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
    // No board write under the kill, and none for the marker either way — see the next case.
    expect(markedNotDelivered()).toEqual([]);
  });

  it("carries the run on to the next ticket under a signal that never fires", async () => {
    retire();
    const run = makeRun([bead("anton-a"), bead("anton-b")], new AbortController().signal);

    const outcome = await dispatchRunTickets(run, prep());

    expect(dispatchedIds()).toEqual(["anton-a", "anton-b"]);
    expect(run.retired).toEqual([{ id: "anton-a", replacedBy: SHIPPER, source: "this-run" }]);
    expect(outcome.delivered.map((t) => t.id)).toEqual(["anton-b"]);
    // NOT marked from the loop (PR #238 review): by the time the retirement reaches it, the
    // settlement has released the ticket's claim and another run may already hold a snapshot of
    // the bead — a marker written now would never be cleared by that run's claim bookend. The
    // marker is the settlement's own write, made beside the supersede while the claim still stood.
    expect(markedNotDelivered()).toEqual([]);
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

  // Unreadable is not "still closed" (PR #238 review): the snapshot's status is stale by
  // construction on a resume, and a reopen decided on it alone would undo an abandon or a supersede
  // that landed since, then dispatch the ticket again. Stop, like every other guarded write.
  it("stops the run when bd cannot read the closed child back", async () => {
    const child = closedChild("anton-a");
    showMock.mockRejectedValue(new Error("dolt: connection refused"));

    await expect(dispatchRunTickets(makeResume(child), prep())).rejects.toThrow(PoisonEpic);
    await expect(dispatchRunTickets(makeResume(child), prep())).rejects.toThrow(
      /anton-a is closed on the board this run read but its commit is on no branch here, and bd would not read the ticket back/,
    );
    expect(reopenMock).not.toHaveBeenCalled();
    expect(runTicketMock).not.toHaveBeenCalled();
  });

  // The snapshot's plain `closed` reaches the reopen as work to regenerate, but a fresh read shows
  // an abandon landed since (PR #238 review). It is still `closed`, so a status-only check would
  // reopen it and re-run work a person killed. Stop instead — the resume re-snapshots it as a
  // won't-do.
  it("stops the run when a fresh read finds the closed child abandoned since the snapshot", async () => {
    const child = closedChild("anton-a");
    showMock.mockResolvedValue(abandoned("anton-a"));

    await expect(dispatchRunTickets(makeResume(child), prep())).rejects.toThrow(PoisonEpic);
    await expect(dispatchRunTickets(makeResume(child), prep())).rejects.toThrow(
      /anton-a is closed on the board this run read.*shows it was abandoned since/,
    );
    expect(reopenMock).not.toHaveBeenCalled();
    expect(runTicketMock).not.toHaveBeenCalled();
  });

  // Same race, the other retirement: a supersede landed since the snapshot, and reopening would
  // re-run work that shipped elsewhere (PR #238 review). The message names the survivor.
  it("stops the run when a fresh read finds the closed child superseded since the snapshot", async () => {
    const child = closedChild("anton-a");
    showMock.mockResolvedValue(superseded("anton-a", SHIPPER));

    await expect(dispatchRunTickets(makeResume(child), prep())).rejects.toThrow(PoisonEpic);
    await expect(dispatchRunTickets(makeResume(child), prep())).rejects.toThrow(
      new RegExp(`anton-a is closed on the board this run read.*superseded by ${SHIPPER} since`),
    );
    expect(reopenMock).not.toHaveBeenCalled();
    expect(runTicketMock).not.toHaveBeenCalled();
  });
});
