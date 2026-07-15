/**
 * Real-bd round-trip for the ticket-detail server layer: create an epic + a child task, read it
 * with getTicketDetail (goal/acceptance/labels/epic link), then updateTicket and assert the patch
 * hit only the intended fields — an agent change preserves the `approved` label. Mirrors
 * epic-detail.integration.test.ts. Skipped when `bd`/`git` aren't installed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beads } from "./beads/bd";
import { getTicketDetail, updateTicket } from "./ticket-detail";
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
  }, 30_000);

  it("changes the agent label without disturbing the approved label", async () => {
    const taskId = await beads.create(repo, { title: "Swap agent", type: "task" });
    await beads.tag(repo, taskId, ["agent:nextjs", "approved"]);

    const updated = await updateTicket(project, taskId, { labels: { agent: "fastapi" } });

    expect(updated.agent).toBe("fastapi");
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

  it("throws for a genuinely missing id", async () => {
    await expect(getTicketDetail(project, "does-not-exist-999")).rejects.toThrow(/not found/i);
  }, 30_000);
});
