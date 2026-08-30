/**
 * Unit tests for escalation-gate.ts (anton-0ci7) — the one stall whose answer is not about the run:
 * a wait on a PERSON, answered by calling `answerGateWait` directly.
 *
 * Two decisions carry this module, and both are asserted here without an action or a db around them:
 *
 *   • THE GATE OPENS AND CLOSES IN A FIXED ORDER relative to the work. Resume closes the gate FIRST
 *     (execute-epic re-reads the board, so a run enqueued against an open gate parks on the same
 *     wait); abandon closes it LAST (a gate that closes over an open bead is handed straight back to
 *     gate-check's own resume). Getting either backwards is silent in production and invisible to a
 *     scenario suite that only checks the end state.
 *   • WHAT THE CLOSED GATE RELEASES is re-derived from the LIVE board, never from the escalation's
 *     frozen pointer, and the dispatch rule that decides `run` vs `hold` vs `nothing` is the
 *     automatic path's own — so an unapproved, claimed, in-review, still-blocked or foreign-run
 *     target holds instead of being re-queued.
 *
 * The board is a literal; bd, the runner and the work verbs are stubbed. The board-reading helpers
 * (`beadBlockedByGate`, `runTargetAbove`, `undispatchableReason`) stay REAL — that this module
 * applies the automatic path's own predicate is the property under test, not a detail to fake away.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GATE_RESUMED_LABEL } from "./jobs/gate-targets";
import { LABELS, type Bead } from "./beads/bd";
import type { EscalationView } from "./escalations";
import type { Project } from "./types";

const beadsPull = vi.fn<(repoPath: string) => Promise<void>>();
const beadsShow = vi.fn<(repoPath: string, id: string) => Promise<Bead | undefined>>();
const gateResolve =
  vi.fn<(repoPath: string, id: string, reason?: string) => Promise<string>>();
const beadsTag = vi.fn<(repoPath: string, id: string, labels: string[]) => Promise<unknown>>();
const loadAllIssues =
  vi.fn<(repo: string, opts?: { strictGates?: boolean }) => Promise<Bead[]>>();
const nudgeSync = vi.fn<(project: Project, label?: string) => void>();
const actOnBead =
  vi.fn<
    (project: Project, action: string, view: EscalationView, target: string) => Promise<string>
  >();
const readBead = vi.fn<(repoPath: string, id: string) => Promise<Bead | "missing" | "unreadable">>();

vi.mock("./beads/bd", async () => {
  const actual = await vi.importActual<typeof import("./beads/bd")>("./beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      pull: (...args: [string]) => beadsPull(...args),
      show: (...args: [string, string]) => beadsShow(...args),
      gateResolve: (...args: [string, string, string?]) => gateResolve(...args),
      tag: (...args: [string, string, string[]]) => beadsTag(...args),
    },
  };
});
vi.mock("./beads/issues", () => ({
  loadAllIssues: (...args: [string, { strictGates?: boolean }?]) => loadAllIssues(...args),
}));
vi.mock("./beads/sync-nudge", () => ({
  nudgeSync: (...args: [Project, string?]) => nudgeSync(...args),
}));
// Pinned so a test box's git config can't decide whether a claimed target is "ours".
vi.mock("./operator", () => ({ resolveOperator: async () => "alice", resetOperatorCache: () => {} }));
vi.mock("./escalation-work", () => ({
  actOnBead: (...args: [Project, string, EscalationView, string]) => actOnBead(...args),
  readBead: (...args: [string, string]) => readBead(...args),
}));

const { answerGateWait } = await import("./escalation-gate");

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const project = { id: "p1", slug: "p1", name: "p1", repoPath: "/tmp/p1" } as Project;

/** A promise the test releases by hand, so a step can be held mid-flight and observed there. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Drains the microtask queue, so everything not blocked on a held promise has run. */
const settle = () => new Promise((r) => setImmediate(r));

const view = (o: Partial<EscalationView> = {}): EscalationView =>
  ({
    id: "esc-abcdef12-0000",
    findingKey: "needs-human:g-1",
    kind: "needs-human",
    reason: "waiting on a human 3h: the founder wants to see the design first",
    beadId: "anton-t9",
    epicBeadId: "anton-e1",
    gateId: "g-1",
    ageMs: 3 * HOUR,
    status: "open",
    noted: false,
    raisedAt: Math.floor(NOW / 1000),
    ...o,
  }) as EscalationView;

const gate = (o: Partial<Bead> = {}): Bead =>
  ({ id: "g-1", title: "Gate: human", issue_type: "gate", status: "closed", ...o }) as Bead;

/** The ticket the gate hangs on — bd records the `blocks` edge on the BLOCKED bead, never the gate. */
const gatedTicket = (parent = "anton-e1"): Bead =>
  ({
    id: "anton-t9",
    title: "ticket",
    status: "open",
    issue_type: "task",
    parent,
    dependencies: [{ issue_id: "anton-t9", depends_on_id: "g-1", type: "blocks" }],
  }) as Bead;

const runTarget = (id = "anton-e1", o: Partial<Bead> = {}): Bead =>
  ({
    id,
    title: "feature",
    status: "open",
    issue_type: "feature",
    labels: [LABELS.approved],
    ...o,
  }) as Bead;

/** The ordinary board: one closed gate on a ticket whose feature above it is free to run. */
const board = (o: { target?: Bead; extra?: Bead[] } = {}): Bead[] => [
  gatedTicket(),
  o.target ?? runTarget(),
  gate(),
  ...(o.extra ?? []),
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  beadsPull.mockResolvedValue(undefined);
  beadsShow.mockResolvedValue(gate());
  gateResolve.mockResolvedValue("✓ Gate resolved");
  beadsTag.mockResolvedValue(undefined);
  loadAllIssues.mockResolvedValue(board());
  nudgeSync.mockReturnValue(undefined);
  actOnBead.mockResolvedValue("enqueued");
  readBead.mockResolvedValue(gate());
});

describe("answerGateWait — abandon closes the gate LAST", () => {
  // The abandon is held OPEN rather than resolved on call: a call order alone would also be produced
  // by starting the abandon, closing the gate while it is still in flight, and awaiting it after —
  // which closes the gate over a bead that is still open, and gate-check hands that straight back.
  it("closes the bead first, then the gate", async () => {
    const order: string[] = [];
    const abandoning = deferred();
    actOnBead.mockImplementation(async () => {
      order.push("bead");
      await abandoning.promise;
      return "abandoned";
    });
    gateResolve.mockImplementation(async () => {
      order.push("gate");
      return "ok";
    });

    const answering = answerGateWait(project, "abandon", view(), "g-1", "anton-t9");
    await settle();

    expect(order).toEqual(["bead"]);
    abandoning.resolve();

    const applied = await answering;
    expect(order).toEqual(["bead", "gate"]);
    expect(applied).toEqual({ detail: "abandoned" });
    expect(actOnBead).toHaveBeenCalledWith(project, "abandon", expect.anything(), "anton-t9");
  });

  it("records which answer ended the wait, traceable to the escalation", async () => {
    await answerGateWait(project, "abandon", view(), "g-1", "anton-t9");

    const [, , reason] = gateResolve.mock.calls[0]!;
    expect(reason).toContain("the work was abandoned");
    expect(reason).toContain("esc-abcd");
  });

  // A gate can block work anton doesn't run — a molecule step, a bead this read doesn't carry.
  // Closing it is then the whole answer, and it must still happen or the sweep re-raises the row.
  it("still closes the gate when the escalation names no bead to abandon", async () => {
    const applied = await answerGateWait(project, "abandon", view(), "g-1");

    expect(applied).toEqual({ detail: "gate-resolved" });
    expect(actOnBead).not.toHaveBeenCalled();
    expect(gateResolve).toHaveBeenCalledWith("/tmp/p1", "g-1", expect.any(String));
  });

  it("leaves the gate OPEN when the abandon refuses — the bead's boundary check wins", async () => {
    actOnBead.mockRejectedValue(new Error("run restarted"));

    await expect(answerGateWait(project, "abandon", view(), "g-1", "anton-t9")).rejects.toThrow();
    expect(gateResolve).not.toHaveBeenCalled();
  });
});

describe("answerGateWait — resume closes the gate FIRST", () => {
  // Both the close and the pull are held OPEN rather than resolved on call: a call order alone would
  // also be produced by starting each step and awaiting it after the next one had begun — pulling
  // over an unlanded close can miss the very write being answered, and reading the board over an
  // unlanded pull decides on exactly the stale board that pull exists to replace.
  it("closes the gate before re-reading the board and re-queueing", async () => {
    const order: string[] = [];
    const close = deferred();
    const pull = deferred();
    gateResolve.mockImplementation(async () => {
      order.push("gate");
      await close.promise;
      return "ok";
    });
    beadsPull.mockImplementation(async () => {
      order.push("pull");
      await pull.promise;
    });
    loadAllIssues.mockImplementation(async () => {
      order.push("board");
      return board();
    });
    actOnBead.mockImplementation(async () => {
      order.push("resume");
      return "enqueued";
    });

    const answering = answerGateWait(project, "resume", view(), "g-1", "anton-e1");
    await settle();

    expect(order).toEqual(["gate"]);
    close.resolve();
    await settle();

    // The pull sits BETWEEN the close and the read: pulling before the close can miss the very
    // write being answered, and the board must not be read until the pull has LANDED.
    expect(order).toEqual(["gate", "pull"]);
    pull.resolve();

    const applied = await answering;
    expect(order).toEqual(["gate", "pull", "board", "resume"]);
    expect(applied).toEqual({ detail: "enqueued" });
    expect(gateResolve.mock.calls[0]![2]).toContain("resolved");
  });

  it("pulls the shared board before reading it, and reads gates in", async () => {
    await answerGateWait(project, "resume", view(), "g-1", "anton-e1");

    expect(beadsPull).toHaveBeenCalledWith("/tmp/p1");
    // bd omits gate beads from ordinary listings, and a SECOND gate is exactly the blocker this
    // read exists to find — an unread one would answer "clear".
    expect(loadAllIssues).toHaveBeenCalledWith("/tmp/p1", { strictGates: true });
  });

  it("marks the resumed gate handed back, and nudges the marks out to teammates", async () => {
    await answerGateWait(project, "resume", view(), "g-1", "anton-e1");

    expect(beadsTag).toHaveBeenCalledWith("/tmp/p1", "g-1", [GATE_RESUMED_LABEL]);
    expect(nudgeSync).toHaveBeenCalledWith(project, "gate-resumed");
  });

  // Two waits on one target are answered one at a time; the run this marks releases both, so a
  // gate left unmarked would be re-dispatched by gate-check forever.
  it("marks EVERY closed gate the resumed target covers, not just the one answered", async () => {
    const second = gate({ id: "g-2" });
    const ticket = {
      ...gatedTicket(),
      dependencies: [
        { issue_id: "anton-t9", depends_on_id: "g-1", type: "blocks" },
        { issue_id: "anton-t9", depends_on_id: "g-2", type: "blocks" },
      ],
    } as Bead;
    loadAllIssues.mockResolvedValue([ticket, runTarget(), gate(), second]);

    await answerGateWait(project, "resume", view(), "g-1", "anton-e1");

    expect(beadsTag.mock.calls.map(([, id]) => id).sort()).toEqual(["g-1", "g-2"]);
    // One nudge for the whole batch of marks — a push carries whatever landed.
    expect(nudgeSync.mock.calls.filter(([, label]) => label === "gate-resumed")).toHaveLength(1);
  });

  it("reports the resume even when marking a gate fails — the run did happen", async () => {
    beadsTag.mockRejectedValue(new Error("bd: write conflict"));

    expect(await answerGateWait(project, "resume", view(), "g-1", "anton-e1")).toEqual({
      detail: "enqueued",
    });
    // Nothing landed, so there is nothing to propagate.
    expect(nudgeSync).not.toHaveBeenCalledWith(project, "gate-resumed");
  });
});

describe("answerGateWait — what the closed gate releases is re-derived", () => {
  // A gate outlives a reparent: the escalation's frozen ancestor can have stopped being the run
  // target while the row sat on the panel. Resuming it would run the wrong feature AND mark the
  // gate handed back, so the bead's real target would never be released at all.
  it("resumes the run target above the gated bead NOW, not the frozen ancestor", async () => {
    loadAllIssues.mockResolvedValue([
      gatedTicket("anton-e2"),
      runTarget("anton-e2"),
      runTarget("anton-e1", { status: "closed" }),
      gate(),
    ]);

    await answerGateWait(project, "resume", view(), "g-1", "anton-e1");

    expect(actOnBead).toHaveBeenCalledWith(project, "resume", expect.anything(), "anton-e2");
    expect(beadsTag).toHaveBeenCalledWith("/tmp/p1", "g-1", [GATE_RESUMED_LABEL]);
  });

  it("falls back to the frozen pointer only when the board maps the gate to nothing", async () => {
    loadAllIssues.mockResolvedValue([runTarget("anton-e1"), gate()]);

    await answerGateWait(project, "resume", view(), "g-1", "anton-e1");

    expect(actOnBead).toHaveBeenCalledWith(project, "resume", expect.anything(), "anton-e1");
  });

  it("resumes nothing when the gate maps to work anton does not run", async () => {
    // The gate was moved onto a molecule STEP — the ancestor walk stops at pipeline plumbing.
    loadAllIssues.mockResolvedValue([
      { ...gatedTicket("m-1"), issue_type: "task" } as Bead,
      { id: "m-1", title: "molecule", status: "open", issue_type: "molecule" } as Bead,
      gate(),
    ]);

    expect(await answerGateWait(project, "resume", view(), "g-1", "anton-e1")).toEqual({
      detail: "gate-resolved",
    });
    expect(actOnBead).not.toHaveBeenCalled();
    expect(beadsTag).not.toHaveBeenCalled();
  });

  it("resumes nothing when the escalation left no pointer and the board maps nothing", async () => {
    loadAllIssues.mockResolvedValue([gate()]);

    expect(await answerGateWait(project, "resume", view(), "g-1")).toEqual({
      detail: "gate-resolved",
    });
    expect(actOnBead).not.toHaveBeenCalled();
  });
});

describe("answerGateWait — the dispatch rule that holds a resume", () => {
  /** Each hold is the automatic path's own clause, applied to the manual answer unchanged. */
  const holds: [name: string, board: Bead[], reason: RegExp][] = [
    [
      "unapproved work the founder never authorized",
      board({ target: runTarget("anton-e1", { labels: [] }) }),
      /not approved/,
    ],
    [
      "a target another operator holds",
      board({ target: runTarget("anton-e1", { assignee: "bob" }) }),
      /claimed by bob/,
    ],
    [
      "a target whose PR is already in review",
      board({ target: runTarget("anton-e1", { labels: [LABELS.approved, LABELS.stage("in-review")] }) }),
      /in review/,
    ],
    [
      "a target a SECOND open blocker still holds",
      [
        gatedTicket(),
        {
          ...runTarget(),
          dependencies: [{ issue_id: "anton-e1", depends_on_id: "anton-e9", type: "blocks" }],
        } as Bead,
        gate(),
        runTarget("anton-e9", { issue_type: "task", parent: undefined }),
      ],
      /still blocked by anton-e9/,
    ],
    [
      "a target another machine is running right now",
      board({
        target: runTarget("anton-e1", {
          labels: [LABELS.approved, LABELS.runLease(Date.now() + HOUR, "r-other")],
        }),
      }),
      /another machine is running it/,
    ],
  ];

  it.each(holds)("holds on %s", async (_name, boardRows, reason) => {
    loadAllIssues.mockResolvedValue(boardRows);

    const applied = await answerGateWait(project, "resume", view(), "g-1", "anton-e1");

    // The reason rides back with the detail: "still blocked" is the only hold the panel's one line
    // describes truthfully, and it is not the common one.
    expect(applied.detail).toBe("gate-still-blocked");
    expect(applied.note).toMatch(reason);
    expect(actOnBead).not.toHaveBeenCalled();
    // Closed and UNMARKED on purpose — that is what makes the hold gate-check's to recover.
    expect(beadsTag).not.toHaveBeenCalled();
  });

  it("closes the gate anyway when the resume holds — the wait was on the person", async () => {
    loadAllIssues.mockResolvedValue(board({ target: runTarget("anton-e1", { labels: [] }) }));

    await answerGateWait(project, "resume", view(), "g-1", "anton-e1");

    expect(gateResolve).toHaveBeenCalledWith("/tmp/p1", "g-1", expect.any(String));
  });

  // FAILS SAFE to held — a board read that didn't land proves nothing about the way being clear.
  it("holds on a pull that was rejected, and says so at the louder level", async () => {
    beadsPull.mockRejectedValue(new Error("no remote answered"));

    const applied = await answerGateWait(project, "resume", view(), "g-1", "anton-e1");

    expect(applied).toMatchObject({ detail: "gate-still-blocked" });
    expect(applied.note).toMatch(/could not be re-read/);
    expect(loadAllIssues).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("the board reads clear"));
  });

  it("holds on a board that would not load", async () => {
    loadAllIssues.mockRejectedValue(new Error("dolt is wedged"));

    const applied = await answerGateWait(project, "resume", view(), "g-1", "anton-e1");

    expect(applied.note).toMatch(/board could not be read/);
  });

  // A board that answered "not yet" is the feature working; only an unread board is an anomaly.
  it("logs an ordinary hold at info, not warn", async () => {
    loadAllIssues.mockResolvedValue(board({ target: runTarget("anton-e1", { labels: [] }) }));

    await answerGateWait(project, "resume", view(), "g-1", "anton-e1");

    expect(console.warn).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("the hold clears"));
  });

  it("holds when the frozen pointer names a bead this board does not carry", async () => {
    loadAllIssues.mockResolvedValue([gate()]);

    const applied = await answerGateWait(project, "resume", view(), "g-1", "anton-e1");

    expect(applied.detail).toBe("gate-still-blocked");
    expect(applied.note).toMatch(/board row could not be read/);
  });
});

describe("resolving the gate itself", () => {
  it("pushes the close out, like every other operator board write", async () => {
    await answerGateWait(project, "abandon", view(), "g-1");

    expect(nudgeSync).toHaveBeenCalledWith(project, "gate-resolve");
  });

  it("treats a gate that is already closed as done, not as a failure", async () => {
    gateResolve.mockRejectedValue(new Error("bd: gate already resolved"));
    readBead.mockResolvedValue(gate({ status: "closed" }));

    expect(await answerGateWait(project, "abandon", view(), "g-1")).toEqual({
      detail: "gate-resolved",
    });
    // No write of ours landed, so there is nothing of ours to propagate.
    expect(nudgeSync).not.toHaveBeenCalled();
  });

  it("treats a gate that no longer exists as done — the wait is over either way", async () => {
    gateResolve.mockRejectedValue(new Error("bd: no issues found"));
    readBead.mockResolvedValue("missing");

    expect(await answerGateWait(project, "abandon", view(), "g-1")).toMatchObject({
      detail: "gate-resolved",
    });
  });

  it("keeps the failure when the gate is provably still open", async () => {
    gateResolve.mockRejectedValue(new Error("bd: write conflict"));
    readBead.mockResolvedValue(gate({ status: "open" }));

    await expect(answerGateWait(project, "abandon", view(), "g-1")).rejects.toThrow(
      "write conflict",
    );
  });

  it("keeps the failure when bd could not say either way", async () => {
    gateResolve.mockRejectedValue(new Error("bd: timeout"));
    readBead.mockResolvedValue("unreadable");

    await expect(answerGateWait(project, "abandon", view(), "g-1")).rejects.toThrow("timeout");
  });
});
