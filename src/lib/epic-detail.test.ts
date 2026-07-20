/**
 * Read economy of the epic detail open (anton-8s1t). getEpicDetail used to spend a `bd show` on
 * every open for the description the board card omits, paying an embedded-Dolt cold start on top of
 * the already-warm list snapshot. These cases pin the trimmed path: the epic + its tickets + goal
 * come off the warm snapshot with no bd spawn, and only a genuinely-absent description costs one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beads } from "./beads/bd";
import { allIssues } from "./beads/issues";
import { resetIssueSnapshots } from "./beads/snapshot";
import * as db from "./db";
import { getEpicDetail } from "./epic-detail";
import * as runs from "./runs";
import type { Bead } from "./beads/bd";
import type { Project } from "./types";

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
