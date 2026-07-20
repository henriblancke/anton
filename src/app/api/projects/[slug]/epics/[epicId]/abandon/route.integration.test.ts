/**
 * Real-bd route test for the epic abandon cascade (anton-6xj0). Boots a temp bd repo and drives the
 * actual handler: POST kills the epic's run, abandons every still-open child, then the epic itself —
 * keeping the beads (unlike DELETE, which destroys them) and leaving already-settled children
 * untouched. The job runner is mocked; skipped when `bd`/`git` aren't installed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beads } from "@/lib/beads/bd";
import { resetIssueSnapshots } from "@/lib/beads/snapshot";
import type { EpicAbandonResult } from "@/lib/abandon";
import type { Project } from "@/lib/types";

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let project: Project | null = null;
const cancelled: Array<[string, string]> = [];

vi.mock("@/lib/projects", () => ({
  getProjectBySlug: async (slug: string) => (project && project.slug === slug ? project : null),
}));

vi.mock("@/lib/jobs/service", () => ({
  cancelRunForTarget: async (projectId: string, epicBeadId: string) => {
    cancelled.push([projectId, epicBeadId]);
    return true;
  },
}));

const { POST } = await import("./route");

const ctx = (slug: string, epicId: string) => ({ params: Promise.resolve({ slug, epicId }) });
const post = (body: unknown) =>
  new Request("http://t/", { method: "POST", body: JSON.stringify(body) });

const suite = has("bd") && has("git") ? describe : describe.skip;

suite("epic abandon route (real bd)", () => {
  let repo: string;
  let epicId: string;
  let openChild: string;
  let doneChild: string;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "anton-bd-abandon-epic-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "anton-test"], { cwd: repo });
    execFileSync("bd", ["init", "--skip-hooks"], { cwd: repo, stdio: "ignore" });
    project = {
      id: "proj-1",
      slug: "tmp",
      name: "tmp",
      repoPath: repo,
      defaultBranch: "main",
      hasBeads: true,
      createdAt: 0,
    };
    epicId = await beads.create(repo, { title: "Half-built thing", type: "epic" });
    doneChild = await beads.create(repo, {
      title: "Already shipped",
      type: "task",
      deps: [`parent-child:${epicId}`],
    });
    openChild = await beads.create(repo, {
      title: "Never going to happen",
      type: "task",
      deps: [`parent-child:${epicId}`],
    });
    await beads.close(repo, doneChild);
  }, 30_000);

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetIssueSnapshots();
    cancelled.length = 0;
  });

  it("refuses without a reason, and writes nothing", async () => {
    expect((await POST(post({}), ctx("tmp", epicId))).status).toBe(400);
    expect((await POST(post({ reason: " " }), ctx("tmp", epicId))).status).toBe(400);
    expect((await beads.show(repo, epicId)).status).not.toBe("closed");
    expect(cancelled).toEqual([]);
  }, 30_000);

  it("404s an unknown epic or project", async () => {
    expect((await POST(post({ reason: "x" }), ctx("tmp", "bd-nope"))).status).toBe(404);
    expect((await POST(post({ reason: "x" }), ctx("nope", epicId))).status).toBe(404);
  }, 30_000);

  it("abandons the epic and cascades to its open children only", async () => {
    const res = await POST(post({ reason: "the market moved" }), ctx("tmp", epicId));
    expect(res.status).toBe(200);
    const { abandoned } = (await res.json()) as { abandoned: EpicAbandonResult };
    expect(abandoned).toEqual({ epicId, children: [openChild] });

    expect(cancelled).toEqual([["proj-1", epicId]]);

    const epic = await beads.show(repo, epicId);
    expect(epic.status).toBe("closed");
    expect(beads.isAbandoned(epic)).toBe(true);

    const child = await beads.show(repo, openChild);
    expect(child.status).toBe("closed");
    expect(beads.isAbandoned(child)).toBe(true);

    // A child that already shipped keeps its outcome — abandon never rewrites settled history.
    const shipped = await beads.show(repo, doneChild);
    expect(shipped.status).toBe("closed");
    expect(beads.isAbandoned(shipped)).toBe(false);
  }, 30_000);

  it("409s an epic whose outcome already settled", async () => {
    const res = await POST(post({ reason: "again" }), ctx("tmp", epicId));
    expect(res.status).toBe(409);
  }, 30_000);
});
