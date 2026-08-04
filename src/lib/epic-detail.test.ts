/**
 * Read economy of the epic detail open (anton-8s1t). getEpicDetail used to spend a `bd show` on
 * every open for the description the board card omits, paying an embedded-Dolt cold start on top of
 * the already-warm list snapshot. These cases pin the trimmed path: the epic + its tickets + goal
 * come off the warm snapshot with no bd spawn, and only a genuinely-absent description costs one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beads } from "./beads/bd";
import { withBeadWriteLock } from "./beads/claim-lock";
import { allIssues } from "./beads/issues";
import { resetIssueSnapshots } from "./beads/snapshot";
import * as db from "./db";
import { DeleteConflictError, deleteEpic, getEpicDetail } from "./epic-detail";
import * as runs from "./runs";
import type { Bead } from "./beads/bd";
import type { Project } from "./types";

vi.mock("./beads/sync-nudge", () => ({ nudgeSync: vi.fn() }));

const project: Project = {
  id: "p",
  slug: "p",
  name: "p",
  repoPath: "/repo",
  defaultBranch: "main",
  hasBeads: true,
  createdAt: 0,
};

const bead = (over: Partial<Bead> & { id: string }): Bead =>
  ({ title: "T", status: "open", issue_type: "task", ...over }) as Bead;

function fakeBd(board: Bead[]) {
  const shown = new Map(board.map((b) => [b.id, b]));
  const list = vi.spyOn(beads, "list").mockImplementation(async () => [...shown.values()]);
  const show = vi.spyOn(beads, "show").mockImplementation(async (_cwd, id) => {
    const found = shown.get(id);
    if (!found) throw new Error(`no such bead ${id}`);
    return found;
  });
  return { list, show };
}

describe("getEpicDetail read economy", () => {
  beforeEach(() => {
    resetIssueSnapshots();
    // The run lookup is orthogonal to bd reads — keep it from opening a real DB in the unit test.
    vi.spyOn(db, "getDb").mockReturnValue({} as never);
    vi.spyOn(runs, "findOpenRunForEpic").mockResolvedValue(undefined as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("opens off the warm snapshot with zero bd spawns when the list carries the description", async () => {
    const bd = fakeBd([
      bead({ id: "e-1", title: "Epic", issue_type: "epic", description: "## Goal\nBuild it\n" }),
      bead({ id: "t-1", title: "Child", parent: "e-1" }),
    ]);
    await allIssues(project.repoPath); // warm the board
    bd.list.mockClear();
    bd.show.mockClear();

    const detail = await getEpicDetail(project, "e-1");

    expect(detail.epic.goal).toBe("Build it");
    expect(detail.tickets.map((t) => t.id)).toEqual(["t-1"]);
    expect(bd.list).not.toHaveBeenCalled(); // served off the warm snapshot
    expect(bd.show).not.toHaveBeenCalled(); // description already in the snapshot — no cold spawn
  });

  it("fetches an absent epic description once, then reuses the memo", async () => {
    const bd = fakeBd([
      bead({ id: "e-1", title: "Epic", issue_type: "epic" }), // no description on the list bead
    ]);
    await allIssues(project.repoPath);
    bd.list.mockClear();
    bd.show.mockClear();

    await getEpicDetail(project, "e-1");
    expect(bd.show).toHaveBeenCalledTimes(1); // the one genuinely-absent field triggers a lazy show

    await getEpicDetail(project, "e-1");
    expect(bd.show).toHaveBeenCalledTimes(1); // second open is served from the memo
    expect(bd.list).not.toHaveBeenCalled();
  });
});

describe("getEpicDetail parent epic (the detail breadcrumb)", () => {
  beforeEach(() => {
    resetIssueSnapshots();
    vi.spyOn(db, "getDb").mockReturnValue({} as never);
    vi.spyOn(runs, "findOpenRunForEpic").mockResolvedValue(undefined as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("carries the product epic a feature hangs under", async () => {
    fakeBd([
      bead({ id: "e-1", title: "Ontology editing", issue_type: "epic" }),
      bead({ id: "f-1", title: "Ship the editor", issue_type: "feature", parent: "e-1" }),
      bead({ id: "t-1", title: "Child", parent: "f-1" }),
    ]);

    const detail = await getEpicDetail(project, "f-1");

    expect(detail.parentEpic).toEqual({ id: "e-1", title: "Ontology editing" });
  });

  it("leaves it undefined for a parentless run target", async () => {
    fakeBd([bead({ id: "e-1", title: "Legacy epic", issue_type: "epic" })]);

    const detail = await getEpicDetail(project, "e-1");

    expect(detail.parentEpic).toBeUndefined();
  });

  it("leaves it undefined when the parent is not an epic", async () => {
    fakeBd([
      bead({ id: "f-1", title: "Ship the editor", issue_type: "feature" }),
      bead({ id: "t-1", title: "Child", parent: "f-1" }),
    ]);

    const detail = await getEpicDetail(project, "t-1");

    expect(detail.parentEpic).toBeUndefined();
  });
});

/**
 * A feature is a run target, and once tickets are shaped under it the run works through THOSE
 * tickets. Its detail page must show the same set (anton-9pkk review): reporting the feature as its
 * own sole ticket hid the real work, mis-stated progress, and dropped the dependency graph.
 */
describe("getEpicDetail feature targets", () => {
  beforeEach(() => {
    resetIssueSnapshots();
    vi.spyOn(db, "getDb").mockReturnValue({} as never);
    vi.spyOn(runs, "findOpenRunForEpic").mockResolvedValue(undefined as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows a feature's child tickets and the blocks edges among them", async () => {
    fakeBd([
      bead({ id: "e-1", title: "Ontology editing", issue_type: "epic" }),
      bead({ id: "f-1", title: "Ship the editor", issue_type: "feature", parent: "e-1" }),
      bead({ id: "t-1", title: "Schema", parent: "f-1" }),
      bead({
        id: "t-2",
        title: "UI",
        parent: "f-1",
        dependencies: [{ issue_id: "t-2", depends_on_id: "t-1", type: "blocks" }],
      }),
    ]);

    const detail = await getEpicDetail(project, "f-1");

    expect(detail.tickets.map((t) => t.id)).toEqual(["t-1", "t-2"]);
    expect(detail.edges).toContainEqual({ from: "t-2", to: "t-1", type: "blocks" });
  });

  it("a childless feature stays its own single ticket (a leaf run, like a standalone task)", async () => {
    fakeBd([bead({ id: "f-1", title: "Ship the editor", issue_type: "feature" })]);

    const detail = await getEpicDetail(project, "f-1");

    expect(detail.tickets.map((t) => t.id)).toEqual(["f-1"]);
    expect(detail.edges).toEqual([]);
  });
});

/**
 * The delete cascade's serialization (anton-e42l review). `bd delete --cascade` erases the epic's
 * whole subtree, so it has to hold the same per-bead write locks the gardener's apply takes for the
 * bead it moves and the card it moves it under — otherwise a re-parent can land inside the delete
 * and lose its subject, while its proposal still closes as applied.
 */
describe("deleteEpic cascade serialization", () => {
  const subtree = () => [
    bead({ id: "e-1", title: "Epic", issue_type: "epic" }),
    bead({ id: "f-1", title: "Feature", issue_type: "feature", parent: "e-1" }),
    bead({ id: "t-1", title: "Task", parent: "f-1" }),
  ];

  beforeEach(() => resetIssueSnapshots());
  afterEach(() => vi.restoreAllMocks());

  it("deletes the epic with --cascade once the locks are held", async () => {
    fakeBd(subtree());
    const del = vi.spyOn(beads, "delete").mockResolvedValue(undefined as never);

    await deleteEpic(project, "e-1");

    expect(del).toHaveBeenCalledWith("/repo", "e-1", { cascade: true });
  });

  // The nested FEATURE, not just the epic: a gardener re-parent whose home is a feature under this
  // epic locks only that feature, so a delete holding the epic's lock alone would serialize nothing.
  it("waits on the write lock of a bead nested under the epic", async () => {
    fakeBd(subtree());
    const del = vi.spyOn(beads, "delete").mockResolvedValue(undefined as never);

    let releaseHolder!: () => void;
    const held = withBeadWriteLock(
      "/repo",
      "f-1",
      () => new Promise<void>((resolve) => (releaseHolder = resolve)),
    );

    const deleting = deleteEpic(project, "e-1");
    await new Promise((r) => setImmediate(r));
    expect(del).not.toHaveBeenCalled(); // blocked behind the descendant's lock

    releaseHolder();
    await held;
    await deleting;
    expect(del).toHaveBeenCalledTimes(1);
  });

  // The race the lock alone can't answer: the lock set was chosen from a pre-lock board, so a bead
  // attached after it would be erased while this call holds no lock on it.
  it("refuses and writes nothing when work is attached under the epic while it lands", async () => {
    const board = subtree();
    const shown = new Map(board.map((b) => [b.id, b]));
    vi.spyOn(beads, "show").mockImplementation(async (_cwd, id) => {
      const found = shown.get(id);
      if (!found) throw new Error(`no such bead ${id}`);
      return found;
    });
    let reads = 0;
    vi.spyOn(beads, "list").mockImplementation(async () => {
      reads += 1;
      // The second read is the one taken under the locks — a re-parent landed in between.
      return reads === 1 ? board : [...board, bead({ id: "t-9", title: "Newcomer", parent: "f-1" })];
    });
    const del = vi.spyOn(beads, "delete").mockResolvedValue(undefined as never);

    const refusal = await deleteEpic(project, "e-1").catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(DeleteConflictError);
    expect((refusal as Error).message).toMatch(/attached t-9/); // the newcomer is named for the operator
    expect(del).not.toHaveBeenCalled();
  });

  it("refuses rather than deleting blind when the board read fails", async () => {
    fakeBd(subtree());
    vi.spyOn(beads, "list").mockRejectedValue(new Error("dolt is locked"));
    const del = vi.spyOn(beads, "delete").mockResolvedValue(undefined as never);

    await expect(deleteEpic(project, "e-1")).rejects.toThrow(DeleteConflictError);
    expect(del).not.toHaveBeenCalled();
  });
});
