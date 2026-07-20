/**
 * Real-bd route test for the snooze toggle (anton-ywi8). Boots a temp bd repo, points
 * getProjectBySlug at it, then drives the actual handlers: POST parks the ticket (out of
 * `bd ready`, detail reads `deferred`), DELETE restores it to both. Skipped when `bd`/`git` aren't
 * installed. Mirrors the notes route integration test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beads } from "@/lib/beads/bd";
import { resetIssueSnapshots } from "@/lib/beads/snapshot";
import type { Project, TicketDetail } from "@/lib/types";

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let project: Project | null = null;

vi.mock("@/lib/projects", () => ({
  getProjectBySlug: async (slug: string) => (project && project.slug === slug ? project : null),
}));

const { POST, DELETE } = await import("./route");

const ctx = (slug: string, ticketId: string) => ({ params: Promise.resolve({ slug, ticketId }) });
const req = new Request("http://t/");

const suite = has("bd") && has("git") ? describe : describe.skip;

suite("ticket defer route (real bd)", () => {
  let repo: string;
  let taskId: string;

  const readyIds = async () => (await beads.ready(repo)).map((b) => b.id);

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "anton-bd-defer-"));
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
    taskId = await beads.create(repo, { title: "Not now, not dead", type: "task" });
  }, 30_000);

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  // The cases share one repo, so a warm snapshot would leak a pre-write bead list between them.
  beforeEach(() => resetIssueSnapshots());

  it("POST snoozes the ticket out of the ready queue and reports it as deferred", async () => {
    expect(await readyIds()).toContain(taskId);

    const res = await POST(req, ctx("tmp", taskId));
    expect(res.status).toBe(200);
    const { detail } = (await res.json()) as { detail: TicketDetail };
    expect(detail.deferred).toBe(true);
    expect(detail.status).toBe("deferred");

    expect(await readyIds()).not.toContain(taskId);
  }, 30_000);

  it("DELETE un-snoozes it back into the ready queue", async () => {
    const res = await DELETE(req, ctx("tmp", taskId));
    expect(res.status).toBe(200);
    const { detail } = (await res.json()) as { detail: TicketDetail };
    expect(detail.deferred).toBe(false);

    expect(await readyIds()).toContain(taskId);
  }, 30_000);

  it("404s an unknown ticket or project", async () => {
    expect((await POST(req, ctx("tmp", "bd-nope"))).status).toBe(404);
    expect((await DELETE(req, ctx("tmp", "bd-nope"))).status).toBe(404);
    expect((await POST(req, ctx("nope", taskId))).status).toBe(404);
  }, 30_000);
});
