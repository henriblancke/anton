/**
 * Read economy of the ticket save path (anton-0zih). updateTicket used to spend four bd spawns per
 * save — show, update, a FORCED cold `bd list`, show — with the list blocking the response behind
 * the Dolt lock even though the write already bumped the snapshot version, so the client's next
 * poll reloads the board anyway. These cases pin the trimmed path: the board is never awaited on a
 * save, and the response still reflects the write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beads } from "./beads/bd";
import { invalidateIssueSnapshot, resetIssueSnapshots } from "./beads/snapshot";
import { getTicketDetail, updateTicket } from "./ticket-detail";
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

/** A fake board: `bd list` beads plus the per-id beads `bd show` returns, with spawn counters. */
function fakeBd(board: Bead[]) {
  const shown = new Map(board.map((b) => [b.id, b]));
  const list = vi.spyOn(beads, "list").mockImplementation(async () => [...shown.values()]);
  const show = vi.spyOn(beads, "show").mockImplementation(async (_cwd, id) => {
    const found = shown.get(id);
    if (!found) throw new Error(`no such bead ${id}`);
    return found;
  });
  const update = vi
    .spyOn(beads, "update")
    .mockImplementation(async (cwd, id, patch) => {
      shown.set(id, { ...shown.get(id)!, ...(patch as Partial<Bead>) });
      // Mirror the real write: it retains the board but flags a pending write, which is what a
      // blocking read would then wait on.
      invalidateIssueSnapshot(cwd, true);
    });
  vi.spyOn(beads, "sync").mockResolvedValue(undefined);
  return { list, show, update };
}

describe("updateTicket read economy", () => {
  beforeEach(() => resetIssueSnapshots());
  afterEach(() => vi.restoreAllMocks());

  it("saves with one show before the write and one after — no board read at all", async () => {
    const bd = fakeBd([bead({ id: "t-1", title: "Old", labels: ["agent:nextjs"] })]);
    await getTicketDetail(project, "t-1"); // warm the board, as a real client already has
    bd.list.mockClear();
    bd.show.mockClear();

    const detail = await updateTicket(project, "t-1", { title: "New" });

    expect(detail.title).toBe("New");
    expect(detail.agent).toBe("nextjs");
    expect(bd.update).toHaveBeenCalledTimes(1);
    expect(bd.show).toHaveBeenCalledTimes(2); // current labels to diff against, then the post-write read
    expect(bd.list).not.toHaveBeenCalled(); // a parentless ticket needs nothing off the board
  });

  it("does not block the save on a post-write board refresh", async () => {
    const bd = fakeBd([
      bead({ id: "e-1", title: "Epic", issue_type: "epic", assignee: "alice" }),
      bead({ id: "t-1", title: "Old", parent: "e-1" }),
    ]);
    await getTicketDetail(project, "t-1");
    bd.list.mockClear();
    // Any `bd list` from here on never returns — a save that awaited one would hang.
    bd.list.mockImplementation(() => new Promise<Bead[]>(() => {}));

    const detail = await updateTicket(project, "t-1", { title: "New" });

    expect(detail.title).toBe("New");
    // The epic header still resolves, off the retained board rather than a forced refresh.
    expect(detail.epicId).toBe("e-1");
    expect(detail.epicTitle).toBe("Epic");
    expect(detail.epicAssignee).toBe("alice");
    // At most the background refresh the client's next poll shares — never awaited here.
    expect(bd.list.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
