/**
 * Real-bd round-trip: create an epic + 2 tickets with a `blocks` edge between them, and assert
 * getEpicDetail returns the tickets plus that edge. Mirrors board.integration.test.ts. Skipped
 * when `bd`/`git` aren't installed.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { beads } from "./beads/bd";
import { resetIssueSnapshots } from "./beads/snapshot";
import { deleteEpic, getEpicDetail, updateEpic } from "./epic-detail";
import type { Project } from "./types";

type SeedNode = { key: string; title: string; type: "epic" | "task" | "bug" };
type SeedEdge = { from_key: string; to_key: string; type: string };

/**
 * Seed many beads in ONE `bd create --graph` call, returning the key → real-id map. Seeding via
 * `beads.create` shells out (and takes the Dolt lock) per bead, which costs seconds per bead under
 * full-suite CPU contention; the batch path is a single process for the whole graph.
 */
function seedGraph(cwd: string, nodes: SeedNode[], edges: SeedEdge[] = []): Record<string, string> {
  const plan = join(cwd, "seed-plan.json");
  writeFileSync(plan, JSON.stringify({ nodes, edges }));
  const out = execFileSync("bd", ["create", "--graph", plan, "--json"], { cwd, encoding: "utf8" });
  const { ids, error } = JSON.parse(out) as { ids?: Record<string, string>; error?: string };
  if (!ids) throw new Error(`bd create --graph failed: ${error ?? out}`);
  return ids;
}

describeBd("epic-detail integration (real bd)", () => {
  let bdRepo: BdRepo;
  let repo: string;
  let project: Project;

  beforeAll(() => {
    bdRepo = makeBdRepo();
    repo = bdRepo.repo;
    project = {
      id: "x",
      slug: "tmp",
      name: "tmp",
      repoPath: repo,
      defaultBranch: "main",
      hasBeads: true,
      createdAt: 0,
    };
  });

  afterAll(() => {
    bdRepo.cleanup();
  });

  // These cases share one repo, so a warm cross-test snapshot would leak between them. Since A1
  // (anton-hp2b) the snapshot serves last-good data on a local write instead of dropping it — a
  // read-after-write returns stale beads, refreshed client-side by A3's version-bump poll. Clearing
  // the cache before each case forces the cold, fresh read a new client's next poll would make, so a
  // just-written bead is observed rather than a prior test's snapshot.
  beforeEach(() => resetIssueSnapshots());

  it("returns the epic's tickets and their blocks edge", async () => {
    const epicId = await beads.create(repo, {
      title: "Stability epic",
      type: "epic",
      description: "## Goal\nReduce flakiness.\n\n## Acceptance\n- [ ] CI is green",
    });
    const ticketA = await beads.create(repo, {
      title: "Fix flaky test A",
      type: "task",
      description: "## Goal\nFix A.\n\n## Acceptance\n- [ ] test A passes",
    });
    const ticketB = await beads.create(repo, {
      title: "Fix flaky test B",
      type: "task",
      description: "## Goal\nFix B.\n\n## Acceptance\n- [ ] test B passes",
    });
    await beads.link(repo, ticketA, epicId, "parent-child");
    await beads.link(repo, ticketB, epicId, "parent-child");
    await beads.link(repo, ticketA, ticketB, "blocks");

    const detail = await getEpicDetail(project, epicId);

    expect(detail.epic.id).toBe(epicId);
    expect(detail.epic.goal).toMatch(/reduce flakiness/i);
    expect(detail.epic.acceptance).toMatch(/CI is green/i);
    expect(detail.description).toMatch(/Reduce flakiness/);

    const ticketIds = detail.tickets.map((t) => t.id);
    expect(ticketIds).toContain(ticketA);
    expect(ticketIds).toContain(ticketB);

    const blocksEdge = detail.edges.find(
      (e) => e.from === ticketA && e.to === ticketB && e.type === "blocks",
    );
    expect(blocksEdge, "blocks edge from A to B").toBeDefined();
  });

  // Regression for anton-lhw: the epic-detail header must surface the epic's own agent/risk/size
  // chips (getEpicDetail's real-epic branch used to pass `chips: false`, silently dropping them
  // even though the board card and single-ticket pseudo-epic show them).
  it("carries the epic's own agent/risk/size chips onto the detail header", async () => {
    const epicId = await beads.create(repo, {
      title: "Labeled epic",
      type: "epic",
      description: "## Goal\nShip it.",
    });
    await beads.tag(repo, epicId, ["agent:nextjs", "risk:high", "size:M"]);

    const detail = await getEpicDetail(project, epicId);
    expect(detail.epic.agent).toBe("nextjs");
    expect(detail.epic.risk).toBe("high");
    expect(detail.epic.size).toBe("M");
  });

  // Regression for anton-noc: `bd list` defaults to 50 results, so in a repo with >50 issues an
  // epic's tickets were silently truncated (planar showed 3 of 5, 1 of 6). beads.list must pass
  // --limit 0 so ALL children come back regardless of repo size.
  it("returns ALL of an epic's tickets even when the repo has >50 issues", async () => {
    // 8 real children under the epic, plus enough unrelated beads to push the repo well past bd's
    // default 50-result cap — all seeded in one batch (anton-0oi: per-bead creates timed out here).
    const nodes: SeedNode[] = [
      { key: "epic", title: "Big epic", type: "epic" },
      ...Array.from({ length: 8 }, (_, i) => ({
        key: `c${i}`,
        title: `Child ${i}`,
        type: "task" as const,
      })),
      ...Array.from({ length: 60 }, (_, i) => ({
        key: `f${i}`,
        title: `Filler ${i}`,
        type: "task" as const,
      })),
    ];
    const edges: SeedEdge[] = Array.from({ length: 8 }, (_, i) => ({
      from_key: `c${i}`,
      to_key: "epic",
      type: "parent-child",
    }));
    const ids = seedGraph(repo, nodes, edges);
    const epicId = ids.epic;
    const childIds = Array.from({ length: 8 }, (_, i) => ids[`c${i}`]);

    const detail = await getEpicDetail(project, epicId);
    const got = new Set(detail.tickets.map((t) => t.id));
    for (const id of childIds) {
      expect(got.has(id), `child ${id} present`).toBe(true);
    }
    expect(detail.tickets.length).toBe(childIds.length);
  });

  // Regression for anton-noc (secondary): an orphan (parentless) non-epic bead is shown on the
  // board as a single-ticket card; opening it must return a single-ticket detail, not 404/throw.
  it("renders an orphan non-epic bead as a single-ticket detail instead of throwing", async () => {
    const bugId = await beads.create(repo, {
      title: "Standalone bug",
      type: "bug",
      description: "## Goal\nFix the thing.",
    });

    const detail = await getEpicDetail(project, bugId);
    expect(detail.epic.id).toBe(bugId);
    expect(detail.tickets.map((t) => t.id)).toEqual([bugId]);
    expect(detail.edges).toEqual([]);
  });

  it("still throws for a genuinely missing id", async () => {
    await expect(getEpicDetail(project, "does-not-exist-999")).rejects.toThrow(/not found/i);
  });

  // The epic priority editor's write path (anton-etvw): a PATCH to priority must land on the bead so
  // `bd show` reflects it, and the returned detail must carry the new value (read-after-write).
  it("updateEpic sets the epic's priority and reflects it in bd show + the returned detail", async () => {
    const epicId = await beads.create(repo, {
      title: "Prioritizable epic",
      type: "epic",
      description: "## Goal\nRank me.",
    });

    const detail = await updateEpic(project, epicId, { priority: 1 });
    expect(detail.epic.priority).toBe(1);

    const fresh = await beads.show(repo, epicId);
    expect(fresh.priority).toBe(1);
  });

  // Fires the remote push off the response path and swallows a rejected sync — same fire-and-forget
  // contract as deleteEpic (the "failing"/unpushed recording lives in beads.sync, covered in bd.test.ts).
  it("updateEpic fires the remote push off the response path and catches a rejected sync", async () => {
    const epicId = await beads.create(repo, { title: "Sync-tested epic", type: "epic" });

    let failSync!: () => void;
    const pendingSync = new Promise<void>((_resolve, reject) => {
      failSync = () => reject(new Error("remote unreachable"));
    });
    const syncSpy = vi.spyOn(beads, "sync").mockReturnValue(pendingSync);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Resolves while the push is still in flight — proof it isn't awaited.
    const detail = await updateEpic(project, epicId, { priority: 2 });
    expect(detail.epic.priority).toBe(2);
    expect(syncSpy).toHaveBeenCalledTimes(1);

    failSync();
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget `.catch` run
    expect(errSpy).toHaveBeenCalled(); // the failed push was logged, not silently swallowed

    syncSpy.mockRestore();
    errSpy.mockRestore();
  });

  // anton-u8wu (A2): the delete must not block on the remote push. Hold the sync pending, prove the
  // delete resolves before it settles (off the critical path), then reject it and prove the failure
  // is logged and swallowed — never awaited, never an unhandled rejection. The sync-status
  // "failing"/unpushed recording lives in beads.sync and is covered in bd.test.ts.
  it("deleteEpic fires the remote push off the response path and catches a rejected sync", async () => {
    const epicId = await beads.create(repo, { title: "Doomed epic", type: "epic" });

    let failSync!: () => void;
    const pendingSync = new Promise<void>((_resolve, reject) => {
      failSync = () => reject(new Error("remote unreachable"));
    });
    const syncSpy = vi.spyOn(beads, "sync").mockReturnValue(pendingSync);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Resolves while the push is still in flight — proof it isn't awaited (an awaited sync would
    // hang here until the test times out).
    await deleteEpic(project, epicId);
    expect(syncSpy).toHaveBeenCalledTimes(1);

    failSync();
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget `.catch` run
    expect(errSpy).toHaveBeenCalled(); // the failed push was logged, not silently swallowed

    syncSpy.mockRestore();
    errSpy.mockRestore();

    // The local cascade delete landed regardless of the failed push.
    await expect(beads.show(repo, epicId)).rejects.toThrow();
  });
});
