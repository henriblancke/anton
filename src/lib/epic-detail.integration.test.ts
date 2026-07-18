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
  }, 30_000);

  // Regression for anton-noc: `bd list` defaults to 50 results, so in a repo with >50 issues an
  // epic's tickets were silently truncated (planar showed 3 of 5, 1 of 6). beads.list must pass
  // --limit 0 so ALL children come back regardless of repo size.
  it("returns ALL of an epic's tickets even when the repo has >50 issues", async () => {
    const epicId = await beads.create(repo, {
      title: "Big epic",
      type: "epic",
      description: "## Goal\nMany tickets.",
    });
    // Create 8 real children under the epic…
    const childIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const id = await beads.create(repo, { title: `Child ${i}`, type: "task" });
      await beads.link(repo, id, epicId, "parent-child");
      childIds.push(id);
    }
    // …and enough unrelated beads to push the total well past bd's default 50-result cap.
    for (let i = 0; i < 60; i++) {
      await beads.create(repo, { title: `Filler ${i}`, type: "task" });
    }

    const detail = await getEpicDetail(project, epicId);
    const got = new Set(detail.tickets.map((t) => t.id));
    for (const id of childIds) {
      expect(got.has(id), `child ${id} present`).toBe(true);
    }
    expect(detail.tickets.length).toBe(childIds.length);
  }, 60_000);

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
  }, 30_000);

  it("still throws for a genuinely missing id", async () => {
    await expect(getEpicDetail(project, "does-not-exist-999")).rejects.toThrow(/not found/i);
  }, 30_000);
});
