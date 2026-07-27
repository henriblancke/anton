import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "./beads/bd";
import type { Project } from "./types";

const showMock = vi.fn();
const listMock = vi.fn();
const abandonMock = vi.fn();
const cancelRunMock = vi.fn();

vi.mock("./beads/bd", async () => {
  const actual = await vi.importActual<typeof import("./beads/bd")>("./beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      show: (...args: unknown[]) => showMock(...args),
      list: (...args: unknown[]) => listMock(...args),
      abandon: (...args: unknown[]) => abandonMock(...args),
      sync: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock("./jobs/service", () => ({
  cancelRunForTarget: (...args: unknown[]) => cancelRunMock(...args),
}));

vi.mock("./ticket-detail", () => ({
  freshDetail: vi.fn().mockResolvedValue({ id: "detail" }),
}));

const { abandonTicket, openDescendants } = await import("./abandon");

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
    abandonMock.mockReset().mockResolvedValue(undefined);
    cancelRunMock.mockReset().mockResolvedValue(false);
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
    const abandoned = abandonMock.mock.calls.map((c) => c[1]);
    expect(abandoned).toEqual(["t1", "t3", "feature"]); // settled t2 untouched, feature closes last
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
    expect(abandonMock.mock.calls.map((c) => c[1])).toEqual(["t1"]);
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
    expect(abandonMock.mock.calls.map((c) => c[1])).toEqual(["s1"]);
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
    expect(abandonMock).not.toHaveBeenCalled();
    expect(cancelRunMock).not.toHaveBeenCalled();
  });
});
