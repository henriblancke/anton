/**
 * Real-bd round-trip: create an epic + 2 tickets with a `blocks` edge between them, and assert
 * getEpicDetail returns the tickets plus that edge. Mirrors board.integration.test.ts. Skipped
 * when `bd`/`git` aren't installed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beads } from "./beads/bd";
import { getEpicDetail } from "./epic-detail";
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

suite("epic-detail integration (real bd)", () => {
  let repo: string;
  let project: Project;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "anton-bd-epic-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "anton-test"], { cwd: repo });
    execFileSync("bd", ["init"], { cwd: repo, stdio: "ignore" });
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
  }, 30_000);
});
