import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "./beads/bd";
import type { Project } from "./types";

const showMock = vi.fn();
const listMock = vi.fn();
const abandonAllMock = vi.fn();
const noteMock = vi.fn();
const cancelRunMock = vi.fn();
const runIsLiveMock = vi.fn<(projectId: string, epicBeadId: string) => boolean>();

vi.mock("./beads/bd", async () => {
  const actual = await vi.importActual<typeof import("./beads/bd")>("./beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      show: (...args: unknown[]) => showMock(...args),
      list: (...args: unknown[]) => listMock(...args),
      abandonAll: (...args: unknown[]) => abandonAllMock(...args),
      note: (...args: unknown[]) => noteMock(...args),
      sync: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock("./jobs/service", () => ({
  cancelRunForTarget: (...args: unknown[]) => cancelRunMock(...args),
  runIsLiveForTarget: (...args: [string, string]) => runIsLiveMock(...args),
}));

vi.mock("./ticket-detail", () => ({
  freshDetail: vi.fn().mockResolvedValue({ id: "detail" }),
}));

const { abandonTicket, openDescendants, RunRestartedError } = await import("./abandon");

/** The one unit `beads.abandonAll` was asked to settle — asserting it IS one, not N writes. */
const soleAbandonUnit = (): Array<{ id: string; reason: string }> => {
  expect(abandonAllMock).toHaveBeenCalledTimes(1);
  return abandonAllMock.mock.calls[0][1] as Array<{ id: string; reason: string }>;
};

/** Its ids, in cascade order. */
const soleAbandonedIds = (): string[] => soleAbandonUnit().map((e) => e.id);

function makeBead(overrides: Partial<Bead> & { id: string }): Bead {
  return {
    title: overrides.id,
    status: "open",
    issue_type: "task",
    labels: [],
    ...overrides,
  };
}

describe("openDescendants (epic abandon cascade)", () => {
  it("walks the whole three-tier subtree, not just direct children", () => {
    const board = [
      makeBead({ id: "epic", issue_type: "epic" }),
      makeBead({ id: "feature", issue_type: "feature", parent: "epic" }),
      makeBead({ id: "t1", parent: "feature" }),
      makeBead({ id: "t2", parent: "feature" }),
    ];

    expect(openDescendants(board, "epic").map((b) => b.id)).toEqual(["feature", "t1", "t2"]);
  });

  it("descends through a settled feature to reach its still-open tickets", () => {
    const board = [
      makeBead({ id: "epic", issue_type: "epic" }),
      makeBead({ id: "feature", issue_type: "feature", parent: "epic", status: "closed" }),
      makeBead({ id: "t1", parent: "feature" }),
    ];

    expect(openDescendants(board, "epic").map((b) => b.id)).toEqual(["t1"]);
  });

  it("leaves other epics' subtrees and parentless beads alone", () => {
    const board = [
      makeBead({ id: "epic", issue_type: "epic" }),
      makeBead({ id: "feature", issue_type: "feature", parent: "epic" }),
      makeBead({ id: "other-epic", issue_type: "epic" }),
      makeBead({ id: "other-task", parent: "other-epic" }),
      makeBead({ id: "loose" }),
    ];

    expect(openDescendants(board, "epic").map((b) => b.id)).toEqual(["feature"]);
  });

  it("reads the parent from parent_id when that is the field bd populated", () => {
    const board = [
      makeBead({ id: "epic", issue_type: "epic" }),
      makeBead({ id: "feature", issue_type: "feature", parent_id: "epic" }),
      makeBead({ id: "t1", parent_id: "feature" }),
    ];

    expect(openDescendants(board, "epic").map((b) => b.id)).toEqual(["feature", "t1"]);
  });

  it("terminates on a malformed parent cycle", () => {
    // The epic is recorded as its own grandchild's child — the seen-set guard stops the loop.
    const board = [
      makeBead({ id: "epic", issue_type: "epic", parent: "b" }),
      makeBead({ id: "a", parent: "epic" }),
      makeBead({ id: "b", parent: "a" }),
    ];

    expect(openDescendants(board, "epic").map((b) => b.id)).toEqual(["a", "b"]);
  });

  it("returns nothing for an epic with no children", () => {
    expect(openDescendants([makeBead({ id: "epic", issue_type: "epic" })], "epic")).toEqual([]);
  });
});

describe("abandonTicket cascade", () => {
  const project: Project = {
    id: "p1",
    slug: "anton",
    name: "anton",
    repoPath: "/tmp/anton",
    defaultBranch: "main",
    hasBeads: true,
    createdAt: 0,
  };

  beforeEach(() => {
    showMock.mockReset();
    listMock.mockReset();
    abandonAllMock.mockReset().mockResolvedValue(undefined);
    noteMock.mockReset().mockResolvedValue(undefined);
    cancelRunMock.mockReset().mockResolvedValue(false);
    runIsLiveMock.mockReset().mockReturnValue(false);
  });

  /** The route hit by a direct API call on a feature id — the path the UI's epic deep-link skips. */
  it("takes a feature's open tasks with it, so none are left claimable under a settled target", async () => {
    const feature = makeBead({ id: "feature", issue_type: "feature", parent: "epic" });
    const board = [
      makeBead({ id: "epic", issue_type: "epic" }),
      feature,
      makeBead({ id: "t1", parent: "feature" }),
      makeBead({ id: "t2", parent: "feature", status: "closed" }),
      makeBead({ id: "t3", parent: "feature" }),
    ];
    showMock.mockResolvedValue(feature);
    listMock.mockResolvedValue(board);

    await abandonTicket(project, "feature", "not worth building");

    // The feature is its own run target, so its run — not the container epic's — is the one killed.
    expect(cancelRunMock).toHaveBeenCalledWith("p1", "feature");
    // One transaction for the whole unit: settled t2 untouched, the feature itself closing last.
    expect(soleAbandonedIds()).toEqual(["t1", "t3", "feature"]);
    // Each cascaded bead still records WHY it went — the parent's decision, named.
    expect(soleAbandonUnit()).toEqual([
      { id: "t1", reason: "not worth building (parent feature feature abandoned)" },
      { id: "t3", reason: "not worth building (parent feature feature abandoned)" },
      { id: "feature", reason: "not worth building" },
    ]);
  });

  it("leaves the run of a still-live sibling alone when a leaf ticket is abandoned", async () => {
    const ticket = makeBead({ id: "t1", parent: "feature" });
    showMock.mockResolvedValue(ticket);
    listMock.mockResolvedValue([
      makeBead({ id: "feature", issue_type: "feature", parent: "epic" }),
      ticket,
      makeBead({ id: "t2", parent: "feature" }),
    ]);

    await abandonTicket(project, "t1", "obsolete");

    // A child ticket executes under its feature's run, and has nothing beneath it to cascade to.
    expect(cancelRunMock.mock.calls).toEqual([["p1", "feature"]]);
    expect(soleAbandonedIds()).toEqual(["t1"]);
  });

  it("kills the FEATURE's run when a subtask two levels below it is abandoned", async () => {
    // feature → task → subtask. Runs are keyed by run target, so cancelling the intermediate task
    // matches no job and the feature's agent runs on past the ticket the board now calls won't-do.
    const subtask = makeBead({ id: "s1", parent: "t1" });
    showMock.mockResolvedValue(subtask);
    listMock.mockResolvedValue([
      makeBead({ id: "epic", issue_type: "epic" }),
      makeBead({ id: "feature", issue_type: "feature", parent: "epic" }),
      makeBead({ id: "t1", parent: "feature" }),
      subtask,
    ]);

    await abandonTicket(project, "s1", "covered by another ticket");

    expect(cancelRunMock.mock.calls).toEqual([["p1", "feature"]]);
    expect(soleAbandonedIds()).toEqual(["s1"]);
  });

  it("terminates on a malformed parent cycle above the abandoned ticket", async () => {
    const ticket = makeBead({ id: "t1", parent: "t2" });
    showMock.mockResolvedValue(ticket);
    listMock.mockResolvedValue([ticket, makeBead({ id: "t2", parent: "t1" })]);

    await abandonTicket(project, "t1", "obsolete");

    // No run target anywhere on the chain — falls back to the immediate parent, which no job is
    // keyed by, so the cancel is a no-op rather than killing the wrong run.
    expect(cancelRunMock.mock.calls).toEqual([["p1", "t2"]]);
  });

  it("refuses a ticket that already settled rather than rewriting its outcome", async () => {
    showMock.mockResolvedValue(makeBead({ id: "t1", status: "closed" }));

    await expect(abandonTicket(project, "t1", "too late")).rejects.toThrow(/already closed/);
    expect(abandonAllMock).not.toHaveBeenCalled();
    expect(cancelRunMock).not.toHaveBeenCalled();
  });

  // Abandoning a gardener proposal is the DECLINE half of the gardener loop, and its other half —
  // applyProposal — runs entirely under the proposal's per-bead write lock. This path takes the same
  // lock and re-reads inside it, so the two decisions order instead of racing: an approval that has
  // passed its own re-read must not still be writing subject moves while this closes the proposal.
  describe("declining a gardener proposal", () => {
    const PROPOSAL = makeBead({
      id: "anton-p1",
      title: "Gardener: re-parent anton-a",
      labels: ["gardener:container-orphan:0123456789ab"],
    });

    it("records the decline on the bead, after the settle that earned it", async () => {
      showMock.mockResolvedValue(PROPOSAL);
      listMock.mockResolvedValue([PROPOSAL]);

      await abandonTicket(project, PROPOSAL.id, "not worth doing");

      expect(soleAbandonedIds()).toEqual([PROPOSAL.id]);
      const [, , note] = noteMock.mock.calls[0] as string[];
      expect(note).toContain("gardener:container-orphan:0123456789ab");
      expect(abandonAllMock.mock.invocationCallOrder[0]).toBeLessThan(
        noteMock.mock.invocationCallOrder[0],
      );
    });

    it("refuses one an approval settled between the first read and the lock, writing nothing", async () => {
      // Open when the caller looked; closed by the concurrent apply by the time the lock is held.
      showMock
        .mockResolvedValueOnce(PROPOSAL)
        .mockResolvedValue({ ...PROPOSAL, status: "closed" });
      listMock.mockResolvedValue([PROPOSAL]);

      await expect(abandonTicket(project, PROPOSAL.id, "too late")).rejects.toThrow(
        /already closed/,
      );
      expect(abandonAllMock).not.toHaveBeenCalled();
      expect(noteMock).not.toHaveBeenCalled();
    });
  });
});

// An escalation's abandon is decided against work its caller observed STOPPED, several awaits before
// the kill would land (a bd pull, the escalation settle). `requireStopped` re-reads liveness at that
// boundary — the only precondition that can tie the cancel to the work the decision was about.
describe("abandonTicket with requireStopped", () => {
  const project: Project = {
    id: "p1",
    slug: "anton",
    name: "anton",
    repoPath: "/tmp/anton",
    defaultBranch: "main",
    hasBeads: true,
    createdAt: 0,
  };

  beforeEach(() => {
    showMock.mockReset();
    listMock.mockReset();
    abandonAllMock.mockReset().mockResolvedValue(undefined);
    noteMock.mockReset().mockResolvedValue(undefined);
    cancelRunMock.mockReset().mockResolvedValue(false);
    runIsLiveMock.mockReset().mockReturnValue(false);
  });

  it("refuses at the cancel boundary when the run restarted, writing nothing", async () => {
    const feature = makeBead({ id: "feature", issue_type: "feature", parent: "epic" });
    showMock.mockResolvedValue(feature);
    listMock.mockResolvedValue([
      makeBead({ id: "epic", issue_type: "epic" }),
      feature,
      makeBead({ id: "t1", parent: "feature" }),
    ]);
    runIsLiveMock.mockReturnValue(true);

    await expect(
      abandonTicket(project, "feature", "not worth building", { requireStopped: true }),
    ).rejects.toThrow(RunRestartedError);
    // The whole point: the restarted job keeps running and the board is untouched.
    expect(cancelRunMock).not.toHaveBeenCalled();
    expect(abandonAllMock).not.toHaveBeenCalled();
  });

  it("refuses before any write when it is a CASCADED descendant that restarted", async () => {
    // The caller's own guard only watches the escalated epic; the cascade reaches further down.
    const epic = makeBead({ id: "epic", issue_type: "epic" });
    showMock.mockResolvedValue(epic);
    listMock.mockResolvedValue([
      epic,
      makeBead({ id: "feature", issue_type: "feature", parent: "epic" }),
      makeBead({ id: "t1", parent: "feature" }),
    ]);
    runIsLiveMock.mockImplementation((_projectId, targetId) => targetId === "feature");

    await expect(
      abandonTicket(project, "epic", "won't do", { requireStopped: true }),
    ).rejects.toThrow(RunRestartedError);
    expect(abandonAllMock).not.toHaveBeenCalled();
  });

  it("abandons normally when nothing is live — and never cancels, since nothing is running", async () => {
    const ticket = makeBead({ id: "t1", parent: "feature" });
    showMock.mockResolvedValue(ticket);
    listMock.mockResolvedValue([
      makeBead({ id: "feature", issue_type: "feature", parent: "epic" }),
      ticket,
    ]);

    await abandonTicket(project, "t1", "stalled for good", { requireStopped: true });

    expect(cancelRunMock).not.toHaveBeenCalled();
    expect(soleAbandonedIds()).toEqual(["t1"]);
  });

  it("still kills the live run when the option is absent — the board's own abandon is unchanged", async () => {
    const ticket = makeBead({ id: "t1", parent: "feature" });
    showMock.mockResolvedValue(ticket);
    listMock.mockResolvedValue([
      makeBead({ id: "feature", issue_type: "feature", parent: "epic" }),
      ticket,
    ]);
    runIsLiveMock.mockReturnValue(true);

    await abandonTicket(project, "t1", "obsolete");

    expect(cancelRunMock.mock.calls).toEqual([["p1", "feature"]]);
    expect(soleAbandonedIds()).toEqual(["t1"]);
  });
});
