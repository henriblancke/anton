/**
 * Real-bd round-trip for moveCard: moving a card runs its label/status ops against a real repo,
 * then nudges the remote sync off the response path (anton-u8wu, A2). Mirrors the other
 * *.integration.test.ts harnesses. Skipped when `bd`/`git` aren't installed.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { beads } from "./beads/bd";
import { moveCard } from "./board-move";
import { deriveStage } from "./ticket-view";
import type { Project } from "./types";

describeBd("board-move integration (real bd)", () => {
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

  it("applies the stage ops to the real bead", async () => {
    const id = await beads.create(repo, { title: "Drag me", type: "task" });

    await moveCard(project, id, "implementing");

    expect(deriveStage(await beads.show(repo, id))).toBe("implementing");
  });

  // anton-u8wu (A2): the drag must not block on the remote push. Hold the sync pending, prove
  // moveCard resolves before it settles (off the critical path), then reject it and prove the
  // failure is logged and swallowed — never awaited, never an unhandled rejection. The sync-status
  // "failing"/unpushed recording lives in beads.sync and is covered in bd.test.ts.
  it("fires the remote push off the response path and catches a rejected sync", async () => {
    const id = await beads.create(repo, { title: "Drag then fail", type: "task" });

    let failSync!: () => void;
    const pendingSync = new Promise<void>((_resolve, reject) => {
      failSync = () => reject(new Error("remote unreachable"));
    });
    const syncSpy = vi.spyOn(beads, "sync").mockReturnValue(pendingSync);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Resolves while the push is still in flight — proof it isn't awaited.
    await moveCard(project, id, "implementing");
    expect(syncSpy).toHaveBeenCalledTimes(1);

    failSync();
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget `.catch` run
    expect(errSpy).toHaveBeenCalled(); // the failed push was logged, not silently swallowed

    syncSpy.mockRestore();
    errSpy.mockRestore();

    // The local move landed regardless of the failed push.
    expect(deriveStage(await beads.show(repo, id))).toBe("implementing");
  });
});
