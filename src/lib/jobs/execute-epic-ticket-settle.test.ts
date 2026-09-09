/**
 * What a RETIRED ticket owes the board at the release (PR #238 review): the `not-delivered` marker
 * is written by the retirement itself, under the ticket's lock, and the settlement refuses to hand
 * the claim back on a retirement that landed without it — the release is what makes the ticket
 * claimable again, and a marker written after it can land on a bead another run has already
 * snapshotted, whose claim bookend then never clears it.
 *
 * Mocked at the IO seams — bd's writes, the session store, the repair pass. The settlement RUNS.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LABELS, type Bead } from "../beads/bd";
import type { StepContext } from "./step-registry";

const unassignMock = vi.fn(async () => "");
const assignMock = vi.fn(async () => "");
const untagMock = vi.fn(async () => "");
const setStatusMock = vi.fn(async () => "");
const noteMock = vi.fn(async () => "");
const showMock = vi.fn();
const repairMock = vi.fn();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      unassign: (...args: unknown[]) => unassignMock(...(args as [])),
      assign: (...args: unknown[]) => assignMock(...(args as [])),
      untag: (...args: unknown[]) => untagMock(...(args as [])),
      setStatus: (...args: unknown[]) => setStatusMock(...(args as [])),
      note: (...args: unknown[]) => noteMock(...(args as [])),
      show: (...args: unknown[]) => showMock(...(args as [])),
    },
  };
});

vi.mock("../sessions", async () => {
  const actual = await vi.importActual<typeof import("../sessions")>("../sessions");
  return { ...actual, endSession: async () => undefined, appendSessionLog: async () => undefined };
});

vi.mock("./execute-epic-ticket-repair", () => ({
  repairBlockedTicket: (...args: unknown[]) => repairMock(...args),
}));

const { settleFailedTicket } = await import("./execute-epic-ticket-settle");
const { NoDeliveryError, TicketRetiredError } = await import("./execute-epic-errors");
const { PoisonEpic } = await import("./errors");

const SHIPPER = "anton-ship";
const ticket = { id: "anton-a", title: "Already done", status: "in_progress" } as Bead;

function run(): Omit<StepContext, "tickets"> {
  return {
    ctx: { signal: new AbortController().signal, heartbeat: async () => undefined },
    repoPath: "/tmp/anton",
    worktreePath: "/tmp/anton-wt",
    branch: "anton/anton-f1",
    baseRef: "main",
    db: {},
    clock: { now: () => 0 },
    settings: {},
    target: { id: "anton-f1" },
  } as unknown as Omit<StepContext, "tickets">;
}

/** A zero-diff block the agent classified `already-shipped` — the one failure the retirement runs on. */
const settle = (operator?: string) =>
  settleFailedTicket({
    run: run(),
    ticket,
    runTicketIds: [ticket.id],
    session: { sessionId: "s1", logPath: "/dev/null" } as never,
    ranOutOfTime: false,
    baseline: null,
    progress: {
      committed: false,
      delivered: false,
      selfReport: { outcome: "blocked", klass: "already-shipped", reason: `shipped by ${SHIPPER}` },
    },
    timeoutMs: 60_000,
    standalone: false,
    operator,
    e: new NoDeliveryError("no diff"),
  });

/** The board's `bd show` shape for anton's retirement: closed, superseded by the survivor. */
const retiredRead = (assignee?: string): Bead =>
  ({
    id: ticket.id,
    status: "closed",
    ...(assignee ? { assignee } : {}),
    dependencies: [{ dependency_type: "supersedes", id: SHIPPER }],
  }) as unknown as Bead;

/**
 * A STATEFUL board for the release's CAS: the swap reads, writes, then re-reads to verify (see
 * beads/claim.ts), so a constant `show` would report every real release as lost on its own
 * post-write read. This makes `unassign` actually clear the assignee the next read returns.
 */
function boardHolding(bead: Bead): void {
  let live = bead;
  showMock.mockImplementation(async () => live);
  unassignMock.mockImplementation(async () => {
    live = { ...live, assignee: "" } as Bead;
    return "";
  });
  assignMock.mockImplementation(async (...args: unknown[]) => {
    live = { ...live, assignee: args[2] as string } as Bead;
    return "";
  });
}

const retired = (marked: boolean) => ({
  action: "retired" as const,
  marked,
  replacementId: SHIPPER,
  proof: ["verified"],
  attempted: `retired anton-a as superseded by ${SHIPPER}`,
});

describe("settling a ticket the repair RETIRED", () => {
  beforeEach(() => {
    for (const m of [unassignMock, assignMock, untagMock, setStatusMock, noteMock, showMock, repairMock])
      m.mockReset();
    unassignMock.mockResolvedValue("");
    assignMock.mockResolvedValue("");
    untagMock.mockResolvedValue("");
    setStatusMock.mockResolvedValue("");
    noteMock.mockResolvedValue("");
    // The release CASes on a fresh read: by default the board still shows anton's own retirement,
    // claimed by this run.
    boardHolding(retiredRead("anton-op"));
  });

  it("releases only the claim on a marked retirement, and hands the loop the retirement", async () => {
    repairMock.mockResolvedValue(retired(true));

    await expect(settle()).rejects.toBeInstanceOf(TicketRetiredError);

    expect(unassignMock).toHaveBeenCalledWith("/tmp/anton", "anton-a");
    expect(untagMock).toHaveBeenCalledWith("/tmp/anton", "anton-a", [LABELS.stage("implementing")]);
    // Neither `blocked` nor `open`: the retirement is a recorded outcome, and both would rewrite it.
    expect(setStatusMock).not.toHaveBeenCalled();
  });

  // An already-unassigned retirement has no claim to take off, so the CAS writes nothing rather than
  // spawning a bd call to set what already holds — but the stage label still comes off.
  it("skips the assignee write on a retirement nothing holds", async () => {
    repairMock.mockResolvedValue(retired(true));
    boardHolding(retiredRead());

    await expect(settle()).rejects.toBeInstanceOf(TicketRetiredError);

    expect(unassignMock).not.toHaveBeenCalled();
    expect(untagMock).toHaveBeenCalledWith("/tmp/anton", "anton-a", [LABELS.stage("implementing")]);
  });

  it("stops the run BEFORE the release on a retirement that landed unmarked", async () => {
    repairMock.mockResolvedValue(retired(false));

    await expect(settle()).rejects.toThrow(PoisonEpic);
    await expect(settle()).rejects.toThrow(
      /anton-a is retired as already shipped, but bd would not record `not-delivered` on it/,
    );

    // The claim stays on the closed bead: it is what keeps the ticket out of every other run's
    // claimable set until a resume finds the retirement on the board and marks it there.
    expect(unassignMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
    expect(setStatusMock).not.toHaveBeenCalled();
  });

  // The release runs after the retirement's lock is dropped, so another run can reopen and reclaim
  // the ticket in the window — reachable with the same operator (PR #238 review). An unconditional
  // unassign would strip that newer holder and leave the ticket in_progress but unowned.
  it("leaves a reopened-and-reclaimed ticket's claim alone", async () => {
    repairMock.mockResolvedValue(retired(true));
    // A concurrent run reopened it: no longer closed, so it is no longer anton's retirement close.
    boardHolding({ id: ticket.id, status: "in_progress", assignee: "someone-else" } as unknown as Bead);

    await expect(settle()).rejects.toBeInstanceOf(TicketRetiredError);

    expect(unassignMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  // A same-operator reopen-and-reclaim, the case no assignee comparison can see: `bd update --claim`
  // is idempotent, so the newer holder's name is this run's own. The status half of the CAS is what
  // catches it — a reopen is no longer `closed`, so it is no longer anton's retirement.
  it("leaves a same-operator reclaim's claim alone", async () => {
    repairMock.mockResolvedValue(retired(true));
    boardHolding({ id: ticket.id, status: "in_progress", assignee: "anton-op" } as unknown as Bead);

    await expect(settle("anton-op")).rejects.toBeInstanceOf(TicketRetiredError);

    expect(unassignMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  // The cross-process leg the in-process lock cannot order: the pre-write read still shows anton's
  // own claimed retirement, and another machine's claim lands before the unassign. The swap's
  // POST-write verify is the only thing that can see it — the assignee reads back as the newcomer,
  // so the release reports lost and the stage label stays on the live claim.
  it("does not strip the stage label when another machine's claim wins the release", async () => {
    repairMock.mockResolvedValue(retired(true));
    let live = retiredRead("anton-op");
    showMock.mockImplementation(async () => live);
    unassignMock.mockImplementation(async () => {
      live = retiredRead("other-machine");
      return "";
    });

    await expect(settle("anton-op")).rejects.toBeInstanceOf(TicketRetiredError);

    expect(unassignMock).toHaveBeenCalledWith("/tmp/anton", "anton-a");
    expect(untagMock).not.toHaveBeenCalled();
  });

  // Reassigned without reopening — still closed and superseded, but a different assignee now holds
  // it; the CAS's assignee half keeps the release from taking that claim off.
  it("leaves a reassigned retirement's claim alone", async () => {
    repairMock.mockResolvedValue(retired(true));
    boardHolding(retiredRead("someone-else"));

    await expect(settle("anton-op")).rejects.toBeInstanceOf(TicketRetiredError);

    expect(unassignMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  it("releases when the fresh read still shows this run's own retirement claim", async () => {
    repairMock.mockResolvedValue(retired(true));
    boardHolding(retiredRead("anton-op"));

    await expect(settle("anton-op")).rejects.toBeInstanceOf(TicketRetiredError);

    expect(unassignMock).toHaveBeenCalledWith("/tmp/anton", "anton-a");
    expect(untagMock).toHaveBeenCalledWith("/tmp/anton", "anton-a", [LABELS.stage("implementing")]);
  });

  // An unreadable board is not proof the retirement still stands, so the CAS fails closed rather
  // than release blind.
  it("does not release on an unreadable board", async () => {
    repairMock.mockResolvedValue(retired(true));
    showMock.mockRejectedValue(new Error("bd offline"));

    await expect(settle()).rejects.toBeInstanceOf(TicketRetiredError);

    expect(unassignMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  // The window the gate's read cannot cover (PR #238 review): a claim landing between it and the
  // write. The swap must take its OWN read immediately before the write — handed the gate's read as
  // `current`, it would compare against a stale snapshot and overwrite that claim.
  it("loses the release to a claim that lands between the gate's read and the write", async () => {
    repairMock.mockResolvedValue(retired(true));
    let live = retiredRead("anton-op");
    let gateRead = false;
    showMock.mockImplementation(async () => {
      const answer = live;
      // The gate's read is the LAST one that still shows anton's own claim; another machine claims
      // it before the swap's own pre-write read, which is the next one.
      if (gateRead) live = retiredRead("other-machine");
      if (answer.status === "closed" && answer.assignee === "anton-op") gateRead = true;
      return answer;
    });

    await expect(settle("anton-op")).rejects.toBeInstanceOf(TicketRetiredError);

    // Caught BEFORE the write, so nothing was overwritten and nothing came off.
    expect(unassignMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  // The half no assignee comparison can see (PR #238 review): another process reopens the ticket and
  // re-claims it under the SAME operator anton's claim already names, so the swap's compare passes
  // and the release strips a claim the reopen made valid — leaving in_progress with no owner, which
  // `bd update --claim` refuses, so the rerun the reopen was for could never claim it.
  it("puts the claim back when a reopen re-claimed the ticket under the same operator", async () => {
    repairMock.mockResolvedValue(retired(true));
    // Reopened and re-claimed by another process under the SAME operator, in the window the release
    // writes into: the swap's compare sees the identical name and passes, and the unassign strips
    // that newer claim. Only a read taken after the write can see what happened.
    let reopened = false;
    let live = retiredRead("anton-op");
    showMock.mockImplementation(async () => live);
    unassignMock.mockImplementation(async () => {
      reopened = true;
      live = { id: ticket.id, status: "in_progress", assignee: "" } as unknown as Bead;
      return "";
    });
    assignMock.mockImplementation(async (...args: unknown[]) => {
      live = { ...live, assignee: args[2] as string } as Bead;
      return "";
    });

    await expect(settle("anton-op")).rejects.toBeInstanceOf(TicketRetiredError);
    expect(reopened).toBe(true);

    expect(unassignMock).toHaveBeenCalledWith("/tmp/anton", "anton-a");
    // Handed back to the holder the release found, and the stage label left alone.
    expect(assignMock).toHaveBeenCalledWith("/tmp/anton", "anton-a", "anton-op");
    expect(untagMock).not.toHaveBeenCalled();
  });

  // Best-effort like every write on this stopping path: an unreadable fence leaves the release as it
  // stands rather than re-claiming a ticket nothing reopened.
  it("leaves the release standing when the fence's read fails", async () => {
    repairMock.mockResolvedValue(retired(true));
    // Readable up to and including the swap's post-write verify — the FIRST read after the release
    // — and broken from the fence's read, the second, onward.
    let readsAfterRelease = 0;
    let live = retiredRead("anton-op");
    let released = false;
    showMock.mockImplementation(async () => {
      if (released) readsAfterRelease += 1;
      if (readsAfterRelease > 1) throw new Error("bd offline");
      return live;
    });
    unassignMock.mockImplementation(async () => {
      live = { ...live, assignee: "" } as Bead;
      released = true;
      return "";
    });

    await expect(settle("anton-op")).rejects.toBeInstanceOf(TicketRetiredError);

    expect(unassignMock).toHaveBeenCalledWith("/tmp/anton", "anton-a");
    // Nothing is re-claimed on an unverified read — that could just as easily re-claim a ticket
    // nothing reopened — so the release stands whole, stage label included.
    expect(assignMock).not.toHaveBeenCalled();
    expect(untagMock).toHaveBeenCalledWith("/tmp/anton", "anton-a", [LABELS.stage("implementing")]);
  });
});

// The retirement's marker window was overtaken (PR #238 review): another process moved the ticket
// after the supersede and marker landed, and the repair already cleared its marker and took back
// what was still its own. Releasing now would block-and-unassign whoever holds it, or reset a
// settled bead open — so the settlement writes nothing and the run stops on the block.
describe("settling a ticket the repair reported OVERTAKEN", () => {
  const overtaken = () => ({
    action: "overtaken" as const,
    why: "anton-a blocked as `already-shipped`, and the board moved between the retirement and its marker",
    evidence: ["reopened or reclaimed since the retirement's fence"],
  });

  beforeEach(() => {
    for (const m of [unassignMock, untagMock, setStatusMock, noteMock, repairMock]) m.mockClear();
  });

  it("stops the run without releasing the claim or touching the status", async () => {
    repairMock.mockResolvedValue(overtaken());

    await expect(settle()).rejects.toBeInstanceOf(NoDeliveryError);

    expect(unassignMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
    expect(setStatusMock).not.toHaveBeenCalled();
  });
});
