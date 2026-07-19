/**
 * Real-bd round-trip for the ticket-detail server layer: create an epic + a child task, read it
 * with getTicketDetail (goal/acceptance/labels/epic link), then updateTicket and assert the patch
 * hit only the intended fields — an agent change preserves the `approved` label. Mirrors
 * epic-detail.integration.test.ts. Skipped when `bd`/`git` aren't installed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beads } from "./beads/bd";
import { resetIssueSnapshots } from "./beads/snapshot";
import { deleteTicket, getTicketDetail, updateTicket } from "./ticket-detail";
import type { Project } from "./types";

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const suite = has("bd") && has("git") ? describe : describe.skip;

suite("ticket-detail integration (real bd)", () => {
  let repo: string;
  let project: Project;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "anton-bd-ticket-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "anton-test"], { cwd: repo });
    execFileSync("bd", ["init", "--skip-hooks"], { cwd: repo, stdio: "ignore" });
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
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  // These cases share one repo, so a warm cross-test snapshot would leak between them. Since A1
  // (anton-hp2b) the snapshot serves last-good data on a local write instead of dropping it — a
  // read-after-write returns stale beads, refreshed client-side by A3's version-bump poll. Clearing
  // the cache before each case forces the cold, fresh read a new client's next poll would make, so a
  // just-written bead is observed rather than a prior test's snapshot.
  beforeEach(() => resetIssueSnapshots());

  it("reads a task's goal/acceptance/labels and parent epic", async () => {
    const epicId = await beads.create(repo, { title: "Detail epic", type: "epic" });
    const taskId = await beads.create(repo, {
      title: "Wire the popup",
      type: "task",
      description: "## Goal\nOpen a ticket and edit it.\n\n## Acceptance\n- [ ] popup opens",
    });
    await beads.link(repo, taskId, epicId, "parent-child");
    await beads.tag(repo, taskId, ["agent:nextjs", "risk:low", "size:M"]);

    const detail = await getTicketDetail(project, taskId);

    expect(detail.id).toBe(taskId);
    expect(detail.type).toBe("task");
    expect(detail.goal).toMatch(/edit it/i);
    expect(detail.acceptance).toMatch(/popup opens/i);
    expect(detail.description).toMatch(/Open a ticket/);
    expect(detail.agent).toBe("nextjs");
    expect(detail.risk).toBe("low");
    expect(detail.size).toBe("M");
    expect(detail.epicId).toBe(epicId);
    expect(detail.epicTitle).toBe("Detail epic");
    expect(detail.approved).toBe(false);
  }, 30_000);

  it("changes the agent label without disturbing the approved label", async () => {
    const taskId = await beads.create(repo, { title: "Swap agent", type: "task" });
    await beads.tag(repo, taskId, ["agent:nextjs", "approved"]);

    const updated = await updateTicket(project, taskId, { labels: { agent: "fastapi" } });

    expect(updated.agent).toBe("fastapi");
    expect(updated.approved).toBe(true);
    const fresh = await beads.show(repo, taskId);
    expect(fresh.labels).toContain("approved");
    expect(fresh.labels).not.toContain("agent:nextjs");
    expect(fresh.labels).toContain("agent:fastapi");
  }, 30_000);

  it("updates the title and leaves other fields alone", async () => {
    const taskId = await beads.create(repo, {
      title: "Old title",
      type: "task",
      description: "## Goal\nkeep me",
    });

    const updated = await updateTicket(project, taskId, { title: "New title" });

    expect(updated.title).toBe("New title");
    expect(updated.goal).toMatch(/keep me/i);
  }, 30_000);

  it("returns post-write detail even when the board snapshot is warm (read-after-write)", async () => {
    const taskId = await beads.create(repo, { title: "Warm cache", type: "task" });
    await beads.tag(repo, taskId, ["agent:nextjs"]);
    // Warm the board snapshot so the read-after-write would otherwise serve stale, pre-write beads.
    await getTicketDetail(project, taskId);

    const updated = await updateTicket(project, taskId, {
      title: "Renamed",
      labels: { agent: "fastapi" },
    });

    // The mutation's own response must reflect the write, or the edit form resets to stale values.
    expect(updated.title).toBe("Renamed");
    expect(updated.agent).toBe("fastapi");
  }, 30_000);

  it("throws for a genuinely missing id", async () => {
    await expect(getTicketDetail(project, "does-not-exist-999")).rejects.toThrow(/not found/i);
  }, 30_000);

  // anton-u8wu (A2): a ticket save must not block on the remote push. Hold the sync pending, prove
  // updateTicket resolves (with the saved detail) before it settles, then reject it and prove the
  // failure is logged and swallowed — never awaited, never an unhandled rejection. The sync-status
  // "failing"/unpushed recording lives in beads.sync and is covered in bd.test.ts.
  it("updateTicket fires the remote push off the response path and catches a rejected sync", async () => {
    const taskId = await beads.create(repo, { title: "Save me", type: "task" });

    let failSync!: () => void;
    const pendingSync = new Promise<void>((_resolve, reject) => {
      failSync = () => reject(new Error("remote unreachable"));
    });
    const syncSpy = vi.spyOn(beads, "sync").mockReturnValue(pendingSync);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Resolves with the saved detail while the push is still in flight — proof it isn't awaited.
    const updated = await updateTicket(project, taskId, { title: "Saved" });
    expect(updated.title).toBe("Saved");
    expect(syncSpy).toHaveBeenCalledTimes(1);

    failSync();
    await new Promise((r) => setImmediate(r));
    expect(errSpy).toHaveBeenCalled();

    syncSpy.mockRestore();
    errSpy.mockRestore();

    // The local update landed regardless of the failed push.
    expect((await beads.show(repo, taskId)).title).toBe("Saved");
  }, 30_000);

  it("deleteTicket fires the remote push off the response path and catches a rejected sync", async () => {
    const taskId = await beads.create(repo, { title: "Delete me", type: "task" });

    let failSync!: () => void;
    const pendingSync = new Promise<void>((_resolve, reject) => {
      failSync = () => reject(new Error("remote unreachable"));
    });
    const syncSpy = vi.spyOn(beads, "sync").mockReturnValue(pendingSync);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await deleteTicket(project, taskId);
    expect(syncSpy).toHaveBeenCalledTimes(1);

    failSync();
    await new Promise((r) => setImmediate(r));
    expect(errSpy).toHaveBeenCalled();

    syncSpy.mockRestore();
    errSpy.mockRestore();

    await expect(beads.show(repo, taskId)).rejects.toThrow();
  }, 30_000);
});
