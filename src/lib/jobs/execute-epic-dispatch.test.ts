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

type HasCommitOptions = { base?: string; excludeBase?: string; strict?: boolean };
const hasCommitMock = vi.fn<(worktree: string, id: string, options?: HasCommitOptions) => Promise<boolean>>();
const satisfiedByMock = vi.fn();
const branchAddedMock = vi.fn();
vi.mock("../git/ops", async () => {
  const actual = await vi.importActual<typeof import("../git/ops")>("../git/ops");
  return {
    ...actual,
    worktreeHasCommitFor: (worktree: string, id: string, options?: HasCommitOptions) =>
      hasCommitMock(worktree, id, options),
    branchSatisfiesTicket: (...args: unknown[]) => satisfiedByMock(...args),
    branchAddedCommit: (...args: unknown[]) => branchAddedMock(...args),
  };
});

const clearBoardEvidencePendingMock = vi.fn();
vi.mock("./execute-epic-board-evidence", async () => {
  const actual = await vi.importActual<typeof import("./execute-epic-board-evidence")>(
    "./execute-epic-board-evidence",
  );
  return {
    ...actual,
    clearBoardEvidencePending: (...args: unknown[]) => clearBoardEvidencePendingMock(...args),
  };
});

// The durable-confirmation resume path writes the attribution commit directly rather than through
// runTicket/the ticket's own worktree (PR #284 review, thread on line 601) — mocked so the test
// exercises the dispatch decision, not `steps/git.ts`'s real `commitMarker` against a fake worktree.
const recordBoardOnlyAttributionMock = vi.fn();
vi.mock("./step-registry", () => ({
  recordBoardOnlyAttribution: (...args: unknown[]) => recordBoardOnlyAttributionMock(...args),
}));

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
const { TicketRetiredError, TicketTimeoutError } = await import("./execute-epic-errors");
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
const superseded = (id: string, by: string, over: Partial<Bead> = {}): Bead =>
  bead(id, {
    status: "closed",
    dependencies: [{ issue_id: id, depends_on_id: by, type: "supersedes" }],
    ...over,
  } as Partial<Bead>);

/** The board as bd answers a fresh `show` — the run's snapshot, unless a case moves a bead on. */
let board: Bead[] = [];

function makeRun(tickets: Bead[], signal: AbortSignal, over: Partial<EpicRun> = {}): EpicRun {
  const target = bead(EPIC, { issue_type: "epic", status: "in_progress", parent: undefined });
  board = [target, ...tickets];
  return {
    repo: "/tmp/anton-repo",
    targetId: EPIC,
    ctx: { signal, heartbeat: vi.fn(async () => {}), report: vi.fn() },
    standaloneRun: false,
    // The target IS an epic, so every board the run re-reads is judged by the graph rollup rather
    // than the standalone path — what the reopened-retirement re-gate reads (PR #238 review).
    targetIsUnit: true,
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
    ...over,
  } as unknown as EpicRun;
}

/**
 * A standalone run: the target IS its own only ticket (`beads.groupsChildren` reads a childless
 * target that way), so retiring it retires the whole run.
 */
function makeStandaloneRun(target: Bead, signal: AbortSignal): EpicRun {
  const run = makeRun([target], signal, {
    standaloneRun: true,
    target,
    tickets: [target],
    all: [target, bead(SHIPPER, { status: "closed", parent: undefined })],
  });
  board = [target, bead(SHIPPER, { status: "closed", parent: undefined })];
  return run;
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
/** The bead a dispatch actually received — the snapshot, or the fresh read that replaced it. */
const dispatchedBead = (id: string) => runTicketMock.mock.calls.find((c) => c[0].ticket.id === id)?.[0].ticket;

/** A contract the run's re-gate accepts, for a child the loop is about to regenerate. */
const CONTRACT = "## Goal\nShip X.\n\n## Acceptance\nWorks.";

const abandoned = (id: string): Bead =>
  bead(id, { status: "closed", labels: [LABELS.abandoned] });

beforeEach(() => {
  board = [];
  runTicketMock.mockReset().mockResolvedValue(COMMITTED);
  clearBoardEvidencePendingMock.mockReset();
  recordBoardOnlyAttributionMock.mockReset().mockResolvedValue(undefined);
  hasCommitMock.mockReset().mockResolvedValue(false);
  satisfiedByMock.mockReset().mockResolvedValue(undefined);
  branchAddedMock.mockReset().mockResolvedValue(true);
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

  it("keeps a superseded ticket whose sibling marker satisfies it in this branch's delta", async () => {
    satisfiedByMock.mockImplementation(async (_worktree: string, id: string) =>
      id === "anton-a"
        ? { sha: "0123456789abcdef0123456789abcdef01234567", subject: "anton-b: cover both", ticketIds: [id] }
        : undefined,
    );
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);

    const outcome = await dispatchRunTickets(run, prep());

    expect(dispatchedIds()).toEqual(["anton-b"]);
    expect(outcome.delivered.map((t) => t.id)).toEqual(["anton-a", "anton-b"]);
    expect(run.retired).toEqual([]);
    expect(markedNotDelivered()).toEqual([]);
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

  // The reopen that carries a NEW contract (PR #238 review). An operator who reopens a superseded
  // ticket usually rewrites what it asks for — that is what the rerun is for — and the run's
  // snapshot still holds the pre-reopen spec. `readForDispatch` only fills a description the
  // snapshot LACKS, so handing the loop the snapshot would dispatch the agent against the retired
  // requirements and close the ticket against them. The fresh bead is what travels on.
  it("dispatches the bead the fresh read carried, not the snapshot's superseded contract", async () => {
    const REOPENED = "## Goal\nShip Y instead.\n\n## Acceptance\nY works.";
    const run = makeRun(
      [superseded("anton-a", SHIPPER, { description: CONTRACT }), bead("anton-b")],
      new AbortController().signal,
    );
    board = board.map((b) =>
      b.id === "anton-a" ? ({ ...b, status: "open", description: REOPENED } as Bead) : b,
    );

    await dispatchRunTickets(run, prep());

    expect(dispatchedIds()).toEqual(["anton-a", "anton-b"]);
    expect(dispatchedBead("anton-a")?.description).toBe(REOPENED);
    expect(dispatchedBead("anton-a")?.status).toBe("open");
  });

  // The reopened ticket escaped steps 0b/0c as `closed` work that would not re-run — and it does
  // run (PR #238 review). So it owes the same re-gates the cross-machine resume re-applies: a
  // reopen that stripped the definition of done must park the run, not dispatch an agent whose work
  // self-review has no rubric to score.
  it("parks the run when the reopen left the ticket without a definition of done", async () => {
    const run = makeRun(
      [superseded("anton-a", SHIPPER, { description: CONTRACT }), bead("anton-b")],
      new AbortController().signal,
    );
    (run.target as Bead).description = CONTRACT;
    board = board.map((b) =>
      b.id === "anton-a" ? ({ ...b, status: "open", description: "## Goal\nShip Y." } as Bead) : b,
    );

    await expect(dispatchRunTickets(run, prep())).rejects.toThrow(
      /has beads that don't meet the bead contract[\s\S]*anton-a/,
    );
    expect(dispatchedIds()).toEqual([]);
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
    // The bead handed on is the post-marker read MINUS the marker the withdraw took off the board:
    // carried forward, the claim bookend would `mustPersist` an untag for a label already gone and
    // park the run on a race that is already settled.
    expect(dispatchedBead("anton-a")?.labels).not.toContain(LABELS.notDelivered);
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

  // The post-marker live exit owes the SAME ownership fence as the pre-marker one (PR #238 review):
  // it hands the loop a ticket to dispatch, and a reopen in the marker window can rehome the bead
  // onto another run's target just as easily. Unfenced, `runTicket` would claim it by id and execute
  // work that now belongs elsewhere.
  it("stops the run when the ticket is reopened AND rehomed in the marker window", async () => {
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);
    tagMock.mockImplementation(async (_repo: string, id: string, labels: string[]) => {
      if (id === "anton-a" && labels.includes(LABELS.notDelivered)) {
        board = [
          ...board.map((b) =>
            b.id === "anton-a"
              ? ({ ...b, status: "open", parent: OTHER_EPIC, labels: [LABELS.notDelivered] } as Bead)
              : b,
          ),
          bead(OTHER_EPIC, { issue_type: "epic", parent: undefined }),
        ];
      }
      return "";
    });

    await expect(dispatchRunTickets(run, prep())).rejects.toThrow(
      new RegExp(`anton-a was superseded on the board this run read but has since been reopened and now runs under ${OTHER_EPIC}`),
    );
    // The marker comes off FIRST: the bead is another target's live work now, and a `not-delivered`
    // label left on it would be read by whichever run delivers it as work that run did not do.
    expect(untagMock).toHaveBeenCalledWith("/tmp/anton-repo", "anton-a", [LABELS.notDelivered]);
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

  // `bd abandon` does not remove the supersedes edge left by an earlier retirement. A fresh read can
  // therefore still say superseded while the label records the operator's later decision not to do
  // the work. That decision wins even when the snapshot's commit is in this branch's diff.
  it("drops a committed superseded ticket abandoned after the snapshot", async () => {
    hasCommitMock.mockImplementation(async (worktree, id) => worktree === WORKTREE && id === "anton-a");
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);
    board = board.map((b) =>
      b.id === "anton-a" ? ({ ...b, labels: [LABELS.abandoned] } as Bead) : b,
    );

    const outcome = await dispatchRunTickets(run, prep());

    expect(dispatchedIds()).toEqual(["anton-b"]);
    expect(outcome.delivered.map((t) => t.id)).toEqual(["anton-b"]);
    expect(run.retired).toEqual([]);
    expect(reopenMock).not.toHaveBeenCalled();
  });

  // A commit in the diff is evidence of the snapshot's work, not a waiver for a later board decision
  // (PR #238 review). The operator reopened and rewrote this ticket; dispatching the stale closed bead
  // would accept the commit as delivery and let merge finalization close the new requirements unseen.
  it("re-runs the fresh contract when a committed superseded ticket was reopened after the snapshot", async () => {
    const REOPENED = "## Goal\nShip the rewrite.\n\n## Acceptance\nThe rewrite works.";
    hasCommitMock.mockImplementation(async (worktree, id) => worktree === WORKTREE && id === "anton-a");
    const run = makeRun(
      [superseded("anton-a", SHIPPER, { description: CONTRACT }), bead("anton-b")],
      new AbortController().signal,
    );
    (run.target as Bead).description = CONTRACT;
    board = board.map((b) =>
      b.id === "anton-a" ? ({ ...b, status: "open", description: REOPENED, dependencies: [] } as Bead) : b,
    );

    const outcome = await dispatchRunTickets(run, prep());

    expect(dispatchedIds()).toEqual(["anton-a", "anton-b"]);
    expect(dispatchedBead("anton-a")?.description).toBe(REOPENED);
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

    expect(hasCommitMock).toHaveBeenCalledWith(WORKTREE, "anton-a", {
      base: FORK_POINT,
      excludeBase: BASE_REF,
      strict: true,
    });
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

// The gate set was computed over a board where these tickets read CLOSED, so it cannot name them —
// a closed child is not work, and the readiness graph dropped it and its blockers with it. Reinstated
// on that set alone, a reopened ticket can never be held, and the run dispatches it over a
// prerequisite that has not shipped (PR #238 review).
describe("a reopened retirement's gates", () => {
  /** An open bead OUTSIDE this run that `blocked` waits on — the prerequisite the hold exists for. */
  const OUTSIDE = "anton-outside";
  const blockedBy = (id: string, blocker: string): Bead =>
    bead(id, { dependencies: [{ issue_id: id, depends_on_id: blocker, type: "blocks" }] } as Partial<Bead>);

  it("holds the ticket when the fresh board shows an external prerequisite still open", async () => {
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);
    // Reopened since the snapshot, and blocked by work in another run that has not landed.
    board = [
      ...board.map((b) =>
        b.id === "anton-a"
          ? ({
              ...b,
              status: "open",
              dependencies: [{ issue_id: "anton-a", depends_on_id: OUTSIDE, type: "blocks" }],
            } as Bead)
          : b,
      ),
      bead(OUTSIDE, { parent: undefined }),
    ];

    // The tail parks rather than delivering: `anton-a` is held, `anton-b` ran.
    await expect(dispatchRunTickets(run, prep())).rejects.toThrow(/anton-a/);
    expect(dispatchedIds()).toEqual(["anton-b"]);
  });

  it("dispatches it when the fresh board shows that prerequisite closed", async () => {
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);
    board = [
      ...board.map((b) =>
        b.id === "anton-a"
          ? ({
              ...b,
              status: "open",
              dependencies: [{ issue_id: "anton-a", depends_on_id: OUTSIDE, type: "blocks" }],
            } as Bead)
          : b,
      ),
      bead(OUTSIDE, { status: "closed", parent: undefined }),
    ];

    await dispatchRunTickets(run, prep());

    expect(dispatchedIds()).toEqual(["anton-a", "anton-b"]);
  });

  // The fresh read is a second opinion on the WHOLE run, not just the reopened ticket (PR #238
  // review): a prerequisite of an ordinary sibling can reopen in the same window that reopened the
  // retirement — a person rescoping one bead usually touches its neighbours. Kept to the reopened
  // ids, that hold would be read off the fresh board and then discarded, and the sibling dispatched
  // onto a prerequisite the board currently holds open.
  it("holds an ordinary sibling whose own prerequisite reopened before the fresh read", async () => {
    const run = makeRun(
      [superseded("anton-a", SHIPPER), blockedBy("anton-b", OUTSIDE)],
      new AbortController().signal,
    );
    board = [
      ...board.map((b) => (b.id === "anton-a" ? ({ ...b, status: "open" } as Bead) : b)),
      // OPEN on the fresh read: the run's own verdict was taken while it was closed, so only this
      // read can see the hold.
      bead(OUTSIDE, { parent: undefined }),
    ];

    await expect(dispatchRunTickets(run, prep())).rejects.toThrow(/anton-b/);
    expect(dispatchedIds()).toEqual(["anton-a"]);
  });

  // The re-gate may only ADD holds: the earlier verdict is what the whole run was planned against,
  // and a prerequisite that closed between the two reads must not silently un-hold a sibling.
  it("keeps a hold the run's own readiness verdict already carried", async () => {
    const run = makeRun(
      [superseded("anton-a", SHIPPER), blockedBy("anton-b", OUTSIDE)],
      new AbortController().signal,
    );
    board = [
      ...board.map((b) => (b.id === "anton-a" ? ({ ...b, status: "open" } as Bead) : b)),
      // Closed on the FRESH read, so the re-gate would clear anton-b's hold if it replaced the set.
      bead(OUTSIDE, { status: "closed", parent: undefined }),
    ];
    const p = prep();
    p.gated = new Set(["anton-b"]);

    await expect(dispatchRunTickets(run, p)).rejects.toThrow(/anton-b/);
    expect(dispatchedIds()).toEqual(["anton-a"]);
  });

  // "Could not check" is not "not blocked": this read is what decides whether an agent runs without
  // its prerequisite, so an unreadable board holds the reopened ticket instead of dispatching it.
  it("holds the reopened ticket when the board cannot be re-read to re-gate it", async () => {
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);
    board = board.map((b) => (b.id === "anton-a" ? ({ ...b, status: "open" } as Bead) : b));
    // Readable for the ownership recompute, then broken for the re-gate that follows it.
    let reads = 0;
    listMock.mockImplementation(async () => {
      reads += 1;
      if (reads > 1) throw new Error("dolt: connection refused");
      return board;
    });

    await expect(dispatchRunTickets(run, prep())).rejects.toThrow(/anton-a/);
    expect(dispatchedIds()).toEqual(["anton-b"]);
  });

  // A run with no reopened retirement pays for no extra board read — the gate set it was planned
  // with already speaks for every ticket in it.
  it("does not re-read the board when no retirement was reopened", async () => {
    const run = makeRun([superseded("anton-a", SHIPPER), bead("anton-b")], new AbortController().signal);

    await dispatchRunTickets(run, prep());

    expect(listMock).not.toHaveBeenCalled();
    expect(dispatchedIds()).toEqual(["anton-b"]);
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

// A STANDALONE target the run retired itself is FINISHED, not parked (PR #238 review): the target
// IS the retired ticket, closed as superseded with anton's evidence on it, so there is no PR to
// open, no ticket left to run and nothing for a person to decide. Parked, the row settles FAILED
// and the runner parks the job permanently — a successfully retired target represented as a stuck
// execution.
describe("a standalone target this run retired as already shipped", () => {
  const standaloneTarget = () =>
    bead(EPIC, { issue_type: "task", status: "in_progress", parent: undefined });

  it("answers a terminal run rather than parking", async () => {
    const run = makeStandaloneRun(standaloneTarget(), new AbortController().signal);
    runTicketMock.mockImplementation(async () => {
      throw new TicketRetiredError(EPIC, SHIPPER, `retired ${EPIC} as superseded by ${SHIPPER}`);
    });

    const outcome = await dispatchRunTickets(run, prep());

    expect(outcome.targetRetired).toBe(true);
    expect(outcome.delivered).toEqual([]);
    expect(run.retired).toEqual([{ id: EPIC, replacedBy: SHIPPER, source: "this-run" }]);
  });

  // An EPIC whose every dispatchable ticket was retired still parks: the epic itself is open with
  // no work left in it, and only a person decides whether it is now empty or still wants work.
  it("still parks the epic whose children were all retired", async () => {
    const run = makeRun([bead("anton-a")], new AbortController().signal);
    runTicketMock.mockImplementation(async () => {
      throw new TicketRetiredError("anton-a", SHIPPER, "retired anton-a as superseded");
    });

    await expect(dispatchRunTickets(run, prep())).rejects.toThrow(
      new RegExp(`every ticket under ${EPIC} that this run could dispatch was retired rather than run`),
    );
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

// A prior attempt's `clearBoardEvidencePending` call (execute-epic-ticket.ts) can exhaust its
// retries and throw PoisonEpic AFTER this ticket already closed — `runTicket` is the only caller
// of that cleanup, and a resume that finds the ticket's own commit already on the branch skips
// `runTicket` entirely (the ordinary resumeSkipped fast path, distinct from the retirement/reopen
// cases above). Without a retry here, the stale marker a failed cleanup left behind would never
// clear: a later reopen of this same ticket would read it as CURRENT evidence for no new work.
describe("a resume-skipped ticket's leftover board-evidence marker (anton-fc5x review)", () => {
  it("retries the cleanup once this ticket's own commit is found already on the branch", async () => {
    const child = bead("anton-a", {
      status: "closed",
      labels: [LABELS.boardOnly, LABELS.boardEvidencePending(["anton-eb1"])],
    });
    hasCommitMock.mockResolvedValue(true);

    const outcome = await dispatchRunTickets(makeRun([child], new AbortController().signal), prep());

    expect(runTicketMock).not.toHaveBeenCalled();
    expect(clearBoardEvidencePendingMock).toHaveBeenCalledWith(
      "/tmp/anton-repo",
      child,
      ["anton-eb1"],
      false,
      false,
    );
    // The companion fix in the `if (delivery)` branch above records the stale-pending ids into the
    // ledger BEFORE clearing them (`ledger.boardEvidence.set(ticket.id, stalePending)`) — asserted
    // here too so a regression that drops that call while leaving the cleanup call intact still
    // fails: `boardEvidenceByTicket` is what `review-context.ts`'s `boardEvidenceSection` reads to
    // show the reviewer which beads this ticket's confirmed evidence covers.
    expect(outcome.boardEvidenceByTicket.get("anton-a")).toEqual(["anton-eb1"]);
  });

  it("does nothing when the ticket carries no pending marker and no preserved baseline", async () => {
    const child = bead("anton-a", { status: "closed", labels: [LABELS.boardOnly] });
    hasCommitMock.mockResolvedValue(true);

    await dispatchRunTickets(makeRun([child], new AbortController().signal), prep());

    expect(clearBoardEvidencePendingMock).not.toHaveBeenCalled();
  });

  it(
    "retries the cleanup for a surviving preserved baseline alone, even with no pending marker " +
      "(PR #284 review) — a prior halt can clear the marker and then exhaust its retries on just " +
      "the baseline, so the resume must still reach it",
    () => {
      const child = bead("anton-a", {
        status: "closed",
        labels: [LABELS.boardOnly],
        metadata: { boardEvidenceBaseline: JSON.stringify({ a: "hash" }) },
      });
      hasCommitMock.mockResolvedValue(true);

      return dispatchRunTickets(makeRun([child], new AbortController().signal), prep()).then(() => {
        expect(runTicketMock).not.toHaveBeenCalled();
        expect(clearBoardEvidencePendingMock).toHaveBeenCalledWith("/tmp/anton-repo", child, [], true, false);
      });
    },
  );

  it(
    "retries the confirming push alone when a prior cleanup's two writes both landed locally but " +
      "the push never confirmed (PR #284 review, \"retain a retry obligation after cleanup push " +
      "failure\") — neither the pending marker nor the preserved baseline survives that failure, so " +
      "only the dedicated obligation flag can tell a same-machine resume there is still an " +
      "unconfirmed remote write",
    () => {
      const child = bead("anton-a", {
        status: "closed",
        labels: [LABELS.boardOnly],
        metadata: { boardEvidenceCleanupUnsynced: "true" },
      });
      hasCommitMock.mockResolvedValue(true);

      return dispatchRunTickets(makeRun([child], new AbortController().signal), prep()).then(() => {
        expect(runTicketMock).not.toHaveBeenCalled();
        expect(clearBoardEvidencePendingMock).toHaveBeenCalledWith("/tmp/anton-repo", child, [], false, true);
      });
    },
  );
});

// A board-only ticket closed and cleaned up on ANOTHER machine (its pending marker and preserved
// baseline both cleared once delivery confirmed) whose branch was never pushed before this run
// resumes on a fresh worktree here: no commit of its own, no sibling, and no note — `branchDelivery`
// finds nothing, so the ordinary cross-machine path would regenerate it. Regenerating it is exactly
// wrong (PR #284 review, "no record that this bead's board-only delivery ever happened"): its own
// fresh `readBoardBaseline` already reflects the change this ticket made, so an idempotent agent can
// only ever find a zero diff and fail with `NoDeliveryError`, undoing a delivery that already
// happened. `beads.boardEvidenceConfirmed` is the durable trace `clearBoardEvidencePending` leaves
// for exactly this case — it survives the marker/baseline clear precisely so this branch can tell
// "confirmed and cleaned up" apart from "closed with nothing behind it".
describe("a board-only ticket durably confirmed delivered with no commit on this branch (PR #284 review)", () => {
  it("writes the attribution commit directly instead of regenerating the ticket", async () => {
    const child = bead("anton-a", {
      status: "closed",
      labels: [LABELS.boardOnly],
      metadata: { boardEvidenceConfirmed: JSON.stringify(["anton-eb1"]) },
    });
    hasCommitMock.mockResolvedValue(false);

    const outcome = await dispatchRunTickets(makeRun([child], new AbortController().signal), prep());

    expect(reopenMock).not.toHaveBeenCalled();
    expect(runTicketMock).not.toHaveBeenCalled();
    expect(recordBoardOnlyAttributionMock).toHaveBeenCalledTimes(1);
    expect(recordBoardOnlyAttributionMock.mock.calls[0][0].tickets).toEqual([child]);
    expect(outcome.delivered.map((b) => b.id)).toContain("anton-a");
    // The pending marker and preserved baseline that would normally carry these ids are exactly
    // what `clearBoardEvidencePending` cleared when it set this durable flag (PR #284 review,
    // "track which beads a durably-confirmed board-only delivery touched") — asserted here so a
    // regression that drops the ids from the confirmed-flag payload still fails: without them the
    // reviewer's per-ticket evidence section falls back to a generic note for a ticket whose
    // evidence genuinely was confirmed.
    expect(outcome.boardEvidenceByTicket.get("anton-a")).toEqual(["anton-eb1"]);
  });

  it("still reopens and regenerates a board-only ticket that was never durably confirmed", async () => {
    const child = bead("anton-a", {
      status: "closed",
      labels: [LABELS.boardOnly],
      description: CONTRACT,
    });
    hasCommitMock.mockResolvedValue(false);
    const run = makeRun([child], new AbortController().signal);
    (run.target as Bead).description = CONTRACT;

    await dispatchRunTickets(run, prep());

    expect(recordBoardOnlyAttributionMock).not.toHaveBeenCalled();
    expect(reopenMock).toHaveBeenCalledWith("/tmp/anton-repo", "anton-a");
    expect(dispatchedIds()).toEqual(["anton-a"]);
  });

  // PR #284 review (P1, "honor every confirmed board-only resume shape"): `delivery:board` is
  // documented as a label shapers put on the run TARGET, inherited by every child — the child
  // itself carries no label of its own. A bare `beads.isBoardOnly(ticket)` check misses this shape
  // entirely and falls through to regeneration against a fresh baseline that already contains the
  // child's delivered writes, where an idempotent retry is rejected as a zero diff.
  it("writes the attribution commit for a child whose board-only label lives on the run TARGET", async () => {
    const child = bead("anton-a", {
      status: "closed",
      metadata: { boardEvidenceConfirmed: "true" },
    });
    const run = makeRun([child], new AbortController().signal);
    (run.target as Bead).labels = [LABELS.boardOnly];
    hasCommitMock.mockResolvedValue(false);

    const outcome = await dispatchRunTickets(run, prep());

    expect(reopenMock).not.toHaveBeenCalled();
    expect(runTicketMock).not.toHaveBeenCalled();
    expect(recordBoardOnlyAttributionMock).toHaveBeenCalledTimes(1);
    expect(recordBoardOnlyAttributionMock.mock.calls[0][0].tickets).toEqual([child]);
    expect(outcome.delivered.map((b) => b.id)).toContain("anton-a");
  });

  // Same finding, second missed shape: a standalone success stays OPEN at `stage:in-review` by
  // design (its PR step is all that is left), so requiring `ticket.status === "closed"` excluded it
  // even though `doneOnBoard` (via `resumeSkipped`) already treats it as done.
  it("writes the attribution commit for a standalone success left OPEN at stage:in-review", async () => {
    const target = bead(EPIC, {
      issue_type: "task",
      status: "open",
      parent: undefined,
      labels: [LABELS.boardOnly, LABELS.stage("in-review")],
      metadata: { boardEvidenceConfirmed: "true" },
    });
    const run = makeStandaloneRun(target, new AbortController().signal);
    hasCommitMock.mockResolvedValue(false);

    const outcome = await dispatchRunTickets(run, prep());

    expect(reopenMock).not.toHaveBeenCalled();
    expect(runTicketMock).not.toHaveBeenCalled();
    expect(recordBoardOnlyAttributionMock).toHaveBeenCalledTimes(1);
    expect(recordBoardOnlyAttributionMock.mock.calls[0][0].tickets).toEqual([target]);
    expect(outcome.delivered.map((b) => b.id)).toContain(EPIC);
  });

  // chatgpt-codex-connector, PR #284 review, "Finish surviving cleanup before accepting
  // confirmation": `clearBoardEvidencePending` can persist the confirmed flag and still fail one of
  // its PRECEDING clears (the marker or the baseline), and a later best-effort sync can publish that
  // partial state on its own. A resume that only checks `boardEvidenceConfirmed` would accept this
  // ticket as fully settled and leave the survivor behind for a future, unrelated reopen to misread.
  it("finishes a surviving pending marker instead of trusting confirmed as fully settled", async () => {
    const child = bead("anton-a", {
      status: "closed",
      labels: [LABELS.boardOnly, LABELS.boardEvidencePending(["anton-eb2"])],
      metadata: { boardEvidenceConfirmed: JSON.stringify(["anton-eb1"]) },
    });
    hasCommitMock.mockResolvedValue(false);

    const outcome = await dispatchRunTickets(makeRun([child], new AbortController().signal), prep());

    expect(clearBoardEvidencePendingMock).toHaveBeenCalledWith(
      "/tmp/anton-repo",
      child,
      ["anton-eb1", "anton-eb2"],
      false,
      false,
    );
    expect(recordBoardOnlyAttributionMock).toHaveBeenCalledTimes(1);
    expect(outcome.boardEvidenceByTicket.get("anton-a")).toEqual(["anton-eb1", "anton-eb2"]);
  });

  it("finishes a surviving preserved baseline instead of trusting confirmed as fully settled", async () => {
    const child = bead("anton-a", {
      status: "closed",
      labels: [LABELS.boardOnly],
      metadata: {
        boardEvidenceConfirmed: JSON.stringify(["anton-eb1"]),
        boardEvidenceBaseline: JSON.stringify({ x: "hash" }),
      },
    });
    hasCommitMock.mockResolvedValue(false);

    await dispatchRunTickets(makeRun([child], new AbortController().signal), prep());

    expect(clearBoardEvidencePendingMock).toHaveBeenCalledWith(
      "/tmp/anton-repo",
      child,
      ["anton-eb1"],
      true,
      false,
    );
  });

  // PR #284 review (critical, "board-only confirmed dependent wrongly skipped by an unrelated
  // timeout"): `skipCause` used to be checked BEFORE the two board-only fast paths above. A
  // board-only ticket already durably confirmed by an EARLIER attempt has not yet been added to
  // `onBranch` when a sibling times out THIS attempt — that only happens once the loop actually
  // reaches it — so `skippedDependents` could sweep it into the cascade even though its delivery
  // has nothing to do with the timed-out ticket's rolled-back mechanism, and the old ordering would
  // then reopen it and tag it `not-delivered`.
  it(
    "still recognizes a board-only confirmed dependent even when an unrelated sibling's timeout " +
      "cascade reaches it first",
    async () => {
      const timedOutTicket = bead("anton-a");
      const confirmedChild = bead("anton-b", {
        status: "closed",
        labels: [LABELS.boardOnly],
        metadata: { boardEvidenceConfirmed: JSON.stringify(["anton-eb1"]) },
        dependencies: [{ issue_id: "anton-b", depends_on_id: "anton-a", type: "blocks" }],
      });
      hasCommitMock.mockResolvedValue(false);
      runTicketMock.mockImplementation(async ({ ticket }) => {
        if (ticket.id === "anton-a") {
          throw new TicketTimeoutError("anton-a", 60_000, false);
        }
        return COMMITTED;
      });

      const outcome = await dispatchRunTickets(
        makeRun([timedOutTicket, confirmedChild], new AbortController().signal),
        prep(),
      );

      // The confirmed board-only delivery is honored, not reopened and marked undelivered.
      expect(reopenMock).not.toHaveBeenCalled();
      expect(markedNotDelivered()).not.toContain("anton-b");
      expect(recordBoardOnlyAttributionMock).toHaveBeenCalledTimes(1);
      expect(recordBoardOnlyAttributionMock.mock.calls[0][0].tickets).toEqual([confirmedChild]);
      expect(outcome.delivered.map((b) => b.id)).toContain("anton-b");
    },
  );
});

// PR #284 review ("Recover cleanup-only resumes before regeneration"): a prior attempt can clear
// the pending marker and preserved baseline locally but exhaust its retries on
// `setBoardEvidenceConfirmed` itself — leaving `boardEvidenceCleanupUnsynced` as the only trace,
// carrying the ids still owed confirmation. That obligation is board state, so it can reach a
// machine with no attribution commit of its own for this ticket at all (a fresh cross-machine
// worktree). Without retrying it here, independently of `delivery`, this ticket would fall through
// the confirmed-evidence fast path (never confirmed) into full regeneration against a fresh
// baseline that already contains its delivered writes.
describe(
  "a board-only ticket with an unsynced cleanup obligation and no commit on this branch " +
    "(PR #284 review, \"Recover cleanup-only resumes before regeneration\")",
  () => {
    it("finishes confirming the recovered ids instead of reopening and regenerating", async () => {
      const child = bead("anton-a", {
        status: "closed",
        labels: [LABELS.boardOnly],
        metadata: { boardEvidenceCleanupUnsynced: JSON.stringify(["anton-eb1"]) },
      });
      hasCommitMock.mockResolvedValue(false);

      const outcome = await dispatchRunTickets(
        makeRun([child], new AbortController().signal),
        prep(),
      );

      expect(reopenMock).not.toHaveBeenCalled();
      expect(runTicketMock).not.toHaveBeenCalled();
      expect(clearBoardEvidencePendingMock).toHaveBeenCalledWith(
        "/tmp/anton-repo",
        child,
        ["anton-eb1"],
        false,
        true,
      );
      expect(recordBoardOnlyAttributionMock).toHaveBeenCalledTimes(1);
      expect(recordBoardOnlyAttributionMock.mock.calls[0][0].tickets).toEqual([child]);
      expect(outcome.delivered.map((b) => b.id)).toContain("anton-a");
      expect(outcome.boardEvidenceByTicket.get("anton-a")).toEqual(["anton-eb1"]);
    });

    it("unions the obligation's ids with a surviving pending marker and preserved baseline", async () => {
      const child = bead("anton-a", {
        status: "closed",
        labels: [LABELS.boardOnly],
        metadata: {
          boardEvidenceCleanupUnsynced: JSON.stringify(["anton-eb1"]),
          boardEvidenceBaseline: JSON.stringify({ x: "hash" }),
        },
      });
      hasCommitMock.mockResolvedValue(false);

      await dispatchRunTickets(makeRun([child], new AbortController().signal), prep());

      expect(clearBoardEvidencePendingMock).toHaveBeenCalledWith(
        "/tmp/anton-repo",
        child,
        ["anton-eb1"],
        true,
        true,
      );
    });

    // PR #284 review (chatgpt-codex-connector, "Clear obligations on confirmed cross-machine
    // resumes"): a failed cleanup push can write BOTH `boardEvidenceConfirmed` and the obligation
    // locally, and a later best-effort sync can publish both together — so a fresh machine can see
    // this exact combination. The confirmed fast path used to leave the stale obligation behind
    // uncleared; it now finishes that cleanup too, so the obligation cannot survive indefinitely
    // and later get unioned into a REOPENED delivery's evidence ids.
    it("clears a stale cleanup obligation left behind on an already-confirmed ticket", async () => {
      const child = bead("anton-a", {
        status: "closed",
        labels: [LABELS.boardOnly],
        metadata: {
          boardEvidenceConfirmed: JSON.stringify(["anton-eb1"]),
          boardEvidenceCleanupUnsynced: JSON.stringify(["anton-eb1"]),
        },
      });
      hasCommitMock.mockResolvedValue(false);

      const outcome = await dispatchRunTickets(
        makeRun([child], new AbortController().signal),
        prep(),
      );

      expect(clearBoardEvidencePendingMock).toHaveBeenCalledWith(
        "/tmp/anton-repo",
        child,
        ["anton-eb1"],
        false,
        true,
      );
      expect(recordBoardOnlyAttributionMock).toHaveBeenCalledTimes(1);
      expect(outcome.boardEvidenceByTicket.get("anton-a")).toEqual(["anton-eb1"]);
    });
  },
);

// chatgpt-codex-connector, PR #284 review, "Reconfirm pending evidence before regenerating the
// ticket": a process dying AFTER `finishTicket` closes/transitions the ticket but BEFORE
// `clearBoardEvidencePending` ever runs leaves the pending marker/baseline `readBoardEvidence`
// already confirmed synced sitting on the board with NO cleanup obligation — that flag is only
// ever written BY `clearBoardEvidencePending`, which in this scenario never started. A fresh
// machine with no commit for this ticket must still finish confirming that surviving evidence
// instead of falling through to full regeneration.
describe(
  "a board-only ticket with surviving pending evidence but no cleanup obligation and no commit " +
    "on this branch (PR #284 review, \"Reconfirm pending evidence before regenerating the ticket\")",
  () => {
    it("finishes confirming a surviving pending marker instead of reopening and regenerating", async () => {
      const child = bead("anton-a", {
        status: "closed",
        labels: [LABELS.boardOnly, LABELS.boardEvidencePending(["anton-eb1"])],
      });
      hasCommitMock.mockResolvedValue(false);

      const outcome = await dispatchRunTickets(makeRun([child], new AbortController().signal), prep());

      expect(reopenMock).not.toHaveBeenCalled();
      expect(runTicketMock).not.toHaveBeenCalled();
      expect(clearBoardEvidencePendingMock).toHaveBeenCalledWith(
        "/tmp/anton-repo",
        child,
        ["anton-eb1"],
        false,
        false,
      );
      expect(recordBoardOnlyAttributionMock).toHaveBeenCalledTimes(1);
      expect(outcome.delivered.map((b) => b.id)).toContain("anton-a");
      expect(outcome.boardEvidenceByTicket.get("anton-a")).toEqual(["anton-eb1"]);
    });

    it("finishes confirming a surviving preserved baseline alone, with no pending marker either", async () => {
      const child = bead("anton-a", {
        status: "closed",
        labels: [LABELS.boardOnly],
        metadata: { boardEvidenceBaseline: JSON.stringify({ x: "hash" }) },
      });
      hasCommitMock.mockResolvedValue(false);

      await dispatchRunTickets(makeRun([child], new AbortController().signal), prep());

      expect(reopenMock).not.toHaveBeenCalled();
      expect(runTicketMock).not.toHaveBeenCalled();
      expect(clearBoardEvidencePendingMock).toHaveBeenCalledWith("/tmp/anton-repo", child, [], true, false);
      expect(recordBoardOnlyAttributionMock).toHaveBeenCalledTimes(1);
    });
  },
);

// PR #284 review ("Preserve confirmed evidence IDs during cleanup retries"): a same-machine resume
// whose commit IS on this branch retries any leftover cleanup obligation through the `if (delivery)`
// path. `setBoardEvidenceConfirmed` is not idempotent on its `ids` argument — passing the bare
// (already-cleared) pending marker would overwrite real confirmed evidence with an empty array.
describe(
  "a resume-skipped ticket's cleanup retry preserves already-known evidence ids (PR #284 review, " +
    "\"Preserve confirmed evidence IDs during cleanup retries\")",
  () => {
    it("unions already-confirmed ids into the retry instead of passing the empty stale-pending set", async () => {
      const child = bead("anton-a", {
        status: "closed",
        labels: [LABELS.boardOnly],
        metadata: {
          boardEvidenceConfirmed: JSON.stringify(["anton-eb1"]),
          boardEvidenceCleanupUnsynced: JSON.stringify([]),
        },
      });
      hasCommitMock.mockResolvedValue(true);

      const outcome = await dispatchRunTickets(
        makeRun([child], new AbortController().signal),
        prep(),
      );

      expect(runTicketMock).not.toHaveBeenCalled();
      expect(clearBoardEvidencePendingMock).toHaveBeenCalledWith(
        "/tmp/anton-repo",
        child,
        ["anton-eb1"],
        false,
        true,
      );
      expect(outcome.boardEvidenceByTicket.get("anton-a")).toEqual(["anton-eb1"]);
    });
  },
);
