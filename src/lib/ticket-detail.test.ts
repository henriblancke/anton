/**
 * Read economy of the ticket save path (anton-0zih). updateTicket used to spend four bd spawns per
 * save — show, update, a FORCED cold `bd list`, show — with the list blocking the response behind
 * the Dolt lock even though the write already bumped the snapshot version, so the client's next
 * poll reloads the board anyway. These cases pin the trimmed path: the board is never awaited on a
 * save, and the response still reflects the write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beads } from "./beads/bd";
import { withBeadWriteLock } from "./beads/claim-lock";
import { invalidateIssueSnapshot, resetIssueSnapshots } from "./beads/snapshot";
import { allIssues } from "./beads/issues";
import { deleteTicket, getTicketDetail, updateTicket } from "./ticket-detail";
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

describe("getTicketDetail read economy", () => {
  beforeEach(() => resetIssueSnapshots());
  afterEach(() => vi.restoreAllMocks());

  it("opens off the warm snapshot with zero bd spawns when the list carries the description", async () => {
    const bd = fakeBd([
      bead({ id: "t-1", title: "T", description: "## Goal\nShip it\n", labels: ["agent:nextjs"] }),
    ]);
    await allIssues(project.repoPath); // warm the board, as a real client already has
    bd.list.mockClear();
    bd.show.mockClear();

    const detail = await getTicketDetail(project, "t-1");

    expect(detail.goal).toBe("Ship it");
    expect(detail.agent).toBe("nextjs");
    expect(bd.list).not.toHaveBeenCalled(); // served off the warm snapshot
    expect(bd.show).not.toHaveBeenCalled(); // description already in the snapshot — no cold spawn
  });

  it("fetches an absent description once, then reuses the memo", async () => {
    const bd = fakeBd([bead({ id: "t-1", title: "T" })]); // no description on the list bead
    await allIssues(project.repoPath);
    bd.list.mockClear();
    bd.show.mockClear();

    await getTicketDetail(project, "t-1");
    expect(bd.show).toHaveBeenCalledTimes(1); // the one genuinely-absent field triggers a lazy show

    await getTicketDetail(project, "t-1");
    expect(bd.show).toHaveBeenCalledTimes(1); // second open is served from the memo — still one spawn
    expect(bd.list).not.toHaveBeenCalled();
  });
});

// The dialog's Run affordance gates on this field the way the standalone chip does — over the RUN
// (runContractStatus with no children), not the bead alone — so it withholds exactly the clicks the
// approve route would 422 and keeps the ones it permits.
describe("getTicketDetail contract status", () => {
  beforeEach(() => resetIssueSnapshots());
  afterEach(() => vi.restoreAllMocks());

  it("reports a blocking Acceptance gap on a backlog standalone with none", async () => {
    fakeBd([bead({ id: "t-1", description: "## Goal\nShip it\n" })]);

    const detail = await getTicketDetail(project, "t-1");

    expect(detail.contract?.blocking.map((v) => v.section)).toEqual(["Acceptance"]);
  });

  it("carries no gaps for an in-review standalone missing Acceptance — its run dispatches no agent", async () => {
    fakeBd([
      bead({ id: "t-1", description: "## Goal\nShip it\n", labels: ["stage:in-review"] }),
    ]);

    const detail = await getTicketDetail(project, "t-1");

    // The approve gate permits Force run on exactly this shape (closed-PR recovery of a legacy
    // standalone), so the dialog must keep offering it rather than reporting the bead's own gap.
    expect(detail.contract).toEqual({ blocking: [], advisory: [] });
  });
});

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

// A gardener proposal is a ticket bead like any other, and `applyProposal` holds its per-bead write
// lock for the WHOLE apply. A delete outside that lock lands between the apply's locked re-read and
// its writes: the subject moves still go in, then `settleProposal` fails on a bead that is gone —
// board mutations with no proposal recording the decision. The lock is what orders the two.
describe("deleteTicket serializes with the gardener's apply lock", () => {
  /** Let the pending delete reach the lock (or the write it would have made without one). */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

  beforeEach(() => resetIssueSnapshots());
  afterEach(() => vi.restoreAllMocks());

  it("waits for the bead's write lock instead of deleting under a concurrent apply", async () => {
    fakeBd([bead({ id: "anton-p1" })]);
    const del = vi.spyOn(beads, "delete").mockResolvedValue("");
    let release!: () => void;
    const apply = withBeadWriteLock(
      "/repo",
      "anton-p1",
      () => new Promise<void>((r) => (release = r)),
    );

    const deleting = deleteTicket(project, "anton-p1");
    await settle();
    expect(del).not.toHaveBeenCalled();

    release();
    await apply;
    await deleting;
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("re-reads under the lock, so a bead settled while it waited 404s rather than deleting blind", async () => {
    const bd = fakeBd([bead({ id: "anton-p1" })]);
    const del = vi.spyOn(beads, "delete").mockResolvedValue("");
    let release!: () => void;
    const apply = withBeadWriteLock(
      "/repo",
      "anton-p1",
      () => new Promise<void>((r) => (release = r)),
    );

    const deleting = deleteTicket(project, "anton-p1");
    await settle();
    // The apply finished and took the bead with it — the 404 guard has to see that, which it only
    // can from inside the lock.
    bd.show.mockRejectedValue(new Error("no such bead anton-p1"));
    release();
    await apply;

    await expect(deleting).rejects.toThrow(/no such bead/);
    expect(del).not.toHaveBeenCalled();
  });
});
