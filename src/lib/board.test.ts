import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "./beads/bd";
import { STAGES } from "./types";
import type { Project } from "./types";

const listMock = vi.fn();

vi.mock("./beads/bd", async () => {
  const actual = await vi.importActual<typeof import("./beads/bd")>("./beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      list: (...args: unknown[]) => listMock(...args),
    },
  };
});

const { deriveStage, getBoard } = await import("./board");
const { resetIssueSnapshots } = await import("./beads/snapshot");

beforeEach(() => {
  resetIssueSnapshots();
  listMock.mockReset();
});

function makeBead(overrides: Partial<Bead> & { id: string; title: string }): Bead {
  return {
    status: "open",
    issue_type: "task",
    labels: [],
    ...overrides,
  };
}

const project: Project = {
  id: "p1",
  slug: "anton",
  name: "anton",
  repoPath: "/tmp/anton",
  defaultBranch: "main",
  hasBeads: true,
  createdAt: 0,
};

describe("deriveStage", () => {
  it("returns done for closed beads", () => {
    expect(deriveStage(makeBead({ id: "b-1", title: "t", status: "closed" }))).toBe("done");
  });

  it("returns in-review when stage:in-review label present", () => {
    expect(
      deriveStage(
        makeBead({ id: "b-2", title: "t", status: "open", labels: ["stage:in-review"] }),
      ),
    ).toBe("in-review");
  });

  it("returns in-review when metadata.pr is set (the PR seam)", () => {
    expect(
      deriveStage(makeBead({ id: "b-3", title: "t", status: "open", metadata: { pr: "gh-1" } })),
    ).toBe("in-review");
  });

  it("returns in-review for a legacy gh-* external_ref (pre-migration fallback)", () => {
    expect(
      deriveStage(makeBead({ id: "b-3b", title: "t", status: "open", external_ref: "gh-1" })),
    ).toBe("in-review");
  });

  it("does NOT read a non-gh external_ref (a tracker URL) as in-review", () => {
    expect(
      deriveStage(
        makeBead({
          id: "b-3c",
          title: "t",
          status: "open",
          external_ref: "https://tracker.example/ISSUE-7",
        }),
      ),
    ).toBe("backlog");
  });

  it("returns implementing when status is in_progress", () => {
    expect(
      deriveStage(makeBead({ id: "b-4", title: "t", status: "in_progress" })),
    ).toBe("implementing");
  });

  it("returns implementing when stage:implementing label present", () => {
    expect(
      deriveStage(
        makeBead({ id: "b-5", title: "t", status: "open", labels: ["stage:implementing"] }),
      ),
    ).toBe("implementing");
  });

  it("returns backlog otherwise", () => {
    expect(deriveStage(makeBead({ id: "b-6", title: "t", status: "open" }))).toBe("backlog");
  });
});

describe("getBoard", () => {
  it("groups epics by stage, parses goal, and surfaces orphan tasks as standalone chips", async () => {
    const epic1 = makeBead({
      id: "epic-1",
      title: "Epic One",
      issue_type: "epic",
      status: "open",
      description: "## Goal\nShip the thing.\n\n## Out of scope\nEverything else.",
      acceptance: "It ships.",
      labels: ["approved"],
      assignee: "carol",
      created_at: "2026-07-12T09:00:00Z",
      created_by: "dave",
    });
    const epic2 = makeBead({
      id: "epic-2",
      title: "Epic Two",
      issue_type: "epic",
      status: "closed",
      description: "intro\n## Goal\nDone deal.\n",
    });
    const ticket1 = makeBead({
      id: "ticket-1",
      title: "Ticket One",
      status: "in_progress",
      parent: "epic-1",
      labels: ["agent:nextjs", "risk:high", "size:S"],
      acceptance: "Works.",
      assignee: "alice",
      created_at: "2026-07-13T10:00:00Z",
      created_by: "bob",
    });
    const ticket2 = makeBead({
      id: "ticket-2",
      title: "Ticket Two",
      status: "closed",
      parent: "epic-2",
      metadata: { pr: "gh-42" },
    });
    const orphan = makeBead({
      id: "orphan-1",
      title: "Orphan Task",
      status: "open",
      labels: ["approved"],
    });

    listMock.mockResolvedValue([epic1, epic2, ticket1, ticket2, orphan]);

    const board = await getBoard(project);

    expect(board.projectSlug).toBe("anton");
    expect(Object.keys(board.columns).sort()).toEqual(
      ["backlog", "implementing", "in-review", "done"].sort(),
    );

    const backlogEpic = board.columns.backlog.find((e) => e.id === "epic-1");
    expect(backlogEpic).toBeDefined();
    expect(backlogEpic!.goal).toBe("Ship the thing.");
    expect(backlogEpic!.acceptance).toBe("It ships.");
    expect(backlogEpic!.approved).toBe(true);
    expect(backlogEpic!.tickets).toHaveLength(1);
    expect(backlogEpic!.tickets[0]).toMatchObject({
      id: "ticket-1",
      agent: "nextjs",
      risk: "high",
      size: "S",
      acceptance: "Works.",
      stage: "implementing",
      assignee: "alice",
      createdAt: "2026-07-13T10:00:00Z",
      createdBy: "bob",
    });
    // The epic itself carries the same claimed-by + created metadata.
    expect(backlogEpic!).toMatchObject({
      assignee: "carol",
      createdAt: "2026-07-12T09:00:00Z",
      createdBy: "dave",
    });

    const doneEpic = board.columns.done.find((e) => e.id === "epic-2");
    expect(doneEpic).toBeDefined();
    expect(doneEpic!.goal).toBe("Done deal.");
    expect(doneEpic!.tickets[0]).toMatchObject({ id: "ticket-2", prRef: "gh-42", stage: "done" });

    // The orphan task is NOT wrapped as a fake epic — it surfaces as a standalone chip carrying
    // its real issue_type, grouped under its derived stage.
    expect(board.columns.backlog.some((e) => e.id === "orphan-1")).toBe(false);
    const orphanItem = board.standalone.backlog.find((i) => i.id === "orphan-1");
    expect(orphanItem).toBeDefined();
    expect(orphanItem!.type).toBe("task");
    expect(orphanItem!.approved).toBe(true);
    expect(orphanItem!.stage).toBe("backlog");
    expect(orphanItem!.unread).toBe(false); // an approved task is never an unread bug
    // Null-safe: an unclaimed orphan has no assignee/created_by and an empty createdAt.
    expect(orphanItem!).toMatchObject({ assignee: null, createdAt: "", createdBy: null });
  });

  it("carries issue_type through and groups standalone items by derived stage", async () => {
    const backlogBug = makeBead({ id: "bug-1", title: "Loose bug", issue_type: "bug", status: "open" });
    const workingTask = makeBead({
      id: "task-1",
      title: "Loose task in flight",
      issue_type: "task",
      status: "in_progress",
    });
    // A task WITH a parent epic is a child, never standalone.
    const parentEpic = makeBead({ id: "epic-x", title: "Epic X", issue_type: "epic", status: "open" });
    const child = makeBead({ id: "child-1", title: "Child", issue_type: "task", parent: "epic-x" });

    listMock.mockResolvedValue([backlogBug, workingTask, parentEpic, child]);

    const board = await getBoard(project);

    const bug = board.standalone.backlog.find((i) => i.id === "bug-1");
    expect(bug?.type).toBe("bug");
    expect(board.standalone.implementing.map((i) => i.id)).toEqual(["task-1"]);
    expect(board.standalone.implementing[0].type).toBe("task");
    // The child ticket rides on its epic, not the standalone group.
    expect(board.standalone.backlog.some((i) => i.id === "child-1")).toBe(false);
    expect(board.standalone.implementing.some((i) => i.id === "child-1")).toBe(false);
    expect(board.columns.backlog.find((e) => e.id === "epic-x")?.tickets.map((t) => t.id)).toEqual([
      "child-1",
    ]);
  });

  it("does not surface a parentless non-runnable type (learning/chore) as a chip", async () => {
    // A parentless `learning` is not a run target (beads.isRunTarget → false), so a chip for it
    // would advertise `Approve & run` yet the approve route + runner reject it — a permanent 422.
    // It must not appear on the board at all (no fake epic, no standalone chip).
    const learning = makeBead({ id: "learn-1", title: "A loose learning", issue_type: "learning" });
    const bug = makeBead({ id: "bug-1", title: "Runnable bug", issue_type: "bug", status: "open" });

    listMock.mockResolvedValue([learning, bug]);

    const board = await getBoard(project);

    const allStandalone = STAGES.flatMap((s) => board.standalone[s]);
    expect(allStandalone.some((i) => i.id === "learn-1")).toBe(false);
    const allColumns = STAGES.flatMap((s) => board.columns[s]);
    expect(allColumns.some((e) => e.id === "learn-1")).toBe(false);
    // The runnable bug is unaffected.
    expect(allStandalone.some((i) => i.id === "bug-1")).toBe(true);
  });

  it("marks a self-filed, untouched bug unread and sorts unread chips first", async () => {
    const unread = makeBead({
      id: "bug-unread",
      title: "Self-filed bug",
      issue_type: "bug",
      status: "open",
      labels: ["source:stringer"],
      created_at: "2026-07-10T00:00:00Z",
    });
    // Same source, but claimed → engaged → no longer unread.
    const claimed = makeBead({
      id: "bug-claimed",
      title: "Claimed self-filed bug",
      issue_type: "bug",
      status: "open",
      labels: ["source:stringer"],
      assignee: "alice",
      created_at: "2026-07-14T00:00:00Z",
    });
    // A human-filed bug (no source label) is never "unread".
    const human = makeBead({
      id: "bug-human",
      title: "Human bug",
      issue_type: "bug",
      status: "open",
      created_at: "2026-07-15T00:00:00Z",
    });

    listMock.mockResolvedValue([human, claimed, unread]);

    const board = await getBoard(project);
    const ids = board.standalone.backlog.map((i) => i.id);
    // Unread first, then newest-created.
    expect(ids).toEqual(["bug-unread", "bug-human", "bug-claimed"]);
    expect(board.standalone.backlog.find((i) => i.id === "bug-unread")!.unread).toBe(true);
    expect(board.standalone.backlog.find((i) => i.id === "bug-claimed")!.unread).toBe(false);
    expect(board.standalone.backlog.find((i) => i.id === "bug-human")!.unread).toBe(false);
  });

  it("attaches ready/blockedBy and sorts the backlog so a blocker precedes what it blocks", async () => {
    // epic-late is blocked by epic-early (a direct epic→epic blocks edge). The runtime's bd-ready
    // would skip epic-late, so the board must mark it blocked and sink it below its blocker.
    const early = makeBead({ id: "epic-early", title: "Blocker", issue_type: "epic" });
    const late = makeBead({
      id: "epic-late",
      title: "Blocked",
      issue_type: "epic",
      dependencies: [{ issue_id: "epic-late", depends_on_id: "epic-early", type: "blocks" }],
    });

    listMock.mockResolvedValue([late, early]);

    const board = await getBoard(project);

    const ids = board.columns.backlog.map((e) => e.id);
    expect(ids).toEqual(["epic-early", "epic-late"]);

    const blocker = board.columns.backlog.find((e) => e.id === "epic-early")!;
    const blocked = board.columns.backlog.find((e) => e.id === "epic-late")!;
    expect(blocker.ready).toBe(true);
    expect(blocker.blockedBy).toEqual([]);
    expect(blocked.ready).toBe(false);
    expect(blocked.blockedBy).toEqual(["epic-early"]);
    expect(blocker.rank).toBeLessThan(blocked.rank);
  });

  it("marks an epic blocked by an open standalone task not-ready (the rollup drops that edge)", async () => {
    // A parentless task blocks the epic. computeEpicGraph's rollup can't attribute a standalone
    // blocker to an epic, so it drops the edge — the board must fold it back in via
    // epicStandaloneBlockers, matching the readiness the approve route enforces (409 while open).
    const blockerTask = makeBead({ id: "task-block", title: "Prereq task", issue_type: "task" });
    const epic = makeBead({
      id: "epic-x",
      title: "Depends on a loose task",
      issue_type: "epic",
      dependencies: [{ issue_id: "epic-x", depends_on_id: "task-block", type: "blocks" }],
    });

    listMock.mockResolvedValue([epic, blockerTask]);

    const board = await getBoard(project);

    const built = board.columns.backlog.find((e) => e.id === "epic-x")!;
    expect(built.ready).toBe(false);
    expect(built.blockedBy).toEqual(["task-block"]);
  });

  it("does not treat a closed non-work (molecule) blocker as still-open", async () => {
    // `molecule` beads are filtered off the board, but a `blocks` edge to one still lives on the
    // epic. Blocker readiness must be derived against the UNFILTERED bead list — otherwise the
    // filtered-out (and here already-closed) molecule reads as a phantom open blocker via the
    // helper's missing-bead fail-safe, wrongly marking the epic not-ready and 409ing approval.
    const doneMolecule = makeBead({
      id: "mol-done",
      title: "Coordination artifact",
      issue_type: "molecule",
      status: "closed",
    });
    const epic = makeBead({
      id: "epic-m",
      title: "Depends on a done molecule",
      issue_type: "epic",
      dependencies: [{ issue_id: "epic-m", depends_on_id: "mol-done", type: "blocks" }],
    });

    listMock.mockResolvedValue([epic, doneMolecule]);

    const board = await getBoard(project);

    // The molecule itself never lands on the board...
    const allIds = STAGES.flatMap((s) => [
      ...board.columns[s].map((e) => e.id),
      ...board.standalone[s].map((i) => i.id),
    ]);
    expect(allIds).not.toContain("mol-done");
    // ...and its closed edge doesn't block the epic.
    const built = board.columns.backlog.find((e) => e.id === "epic-m")!;
    expect(built.blockedBy).toEqual([]);
    expect(built.ready).toBe(true);
  });

  it("carries ready/blockedBy onto a standalone item so a blocked chip can't be approved", async () => {
    // Two parentless tasks: task-b blocks task-a. task-a is a standalone run target whose readiness
    // isn't in the epic rollup, so the board derives it from its own blocks edge (standaloneBlockers).
    const blocker = makeBead({ id: "task-b", title: "Prereq", issue_type: "task" });
    const blocked = makeBead({
      id: "task-a",
      title: "Blocked standalone",
      issue_type: "task",
      dependencies: [{ issue_id: "task-a", depends_on_id: "task-b", type: "blocks" }],
    });

    listMock.mockResolvedValue([blocked, blocker]);

    const board = await getBoard(project);

    const a = board.standalone.backlog.find((i) => i.id === "task-a")!;
    const b = board.standalone.backlog.find((i) => i.id === "task-b")!;
    expect(a.ready).toBe(false);
    expect(a.blockedBy).toEqual(["task-b"]);
    expect(b.ready).toBe(true);
    expect(b.blockedBy).toEqual([]);
  });

  it("falls back to merging open + closed lists when --status all fails", async () => {
    const openEpic = makeBead({ id: "epic-open", title: "Open Epic", issue_type: "epic" });
    const closedEpic = makeBead({
      id: "epic-closed",
      title: "Closed Epic",
      issue_type: "epic",
      status: "closed",
    });

    listMock.mockImplementation(async (_cwd: string, extra: string[] = []) => {
      if (extra.includes("all")) throw new Error("unsupported flag");
      if (extra.includes("closed")) return [closedEpic];
      return [openEpic];
    });

    const board = await getBoard(project);

    expect(board.columns.backlog.some((e) => e.id === "epic-open")).toBe(true);
    expect(board.columns.done.some((e) => e.id === "epic-closed")).toBe(true);
  });
});
