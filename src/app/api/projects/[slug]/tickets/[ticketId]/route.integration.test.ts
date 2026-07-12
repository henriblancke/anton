/**
 * Real-bd route test for GET/PATCH ticket. Boots a temp bd repo, points getProjectBySlug at it,
 * then drives the actual route handlers: GET returns a known bead's detail; PATCH { risk: "high" }
 * returns risk high and leaves the `approved` label intact; PATCH with an unknown field 400s; an
 * unknown ticket/project 404s. Skipped when `bd`/`git` aren't installed. Mirrors the
 * ticket-detail integration test.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beads } from "@/lib/beads/bd";
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

vi.mock("@/lib/projects", () => ({
  getProjectBySlug: async (slug: string) => (project && project.slug === slug ? project : null),
}));

const { GET, PATCH, DELETE } = await import("./route");

const ctx = (slug: string, ticketId: string) => ({ params: Promise.resolve({ slug, ticketId }) });

const suite = has("bd") && has("git") ? describe : describe.skip;

suite("ticket route (real bd)", () => {
  let repo: string;
  let taskId: string;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "anton-bd-route-"));
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
    taskId = await beads.create(repo, {
      title: "Editable ticket",
      type: "task",
      description: "## Goal\nedit me",
    });
    await beads.tag(repo, taskId, ["agent:nextjs", "risk:low", "approved"]);
  }, 30_000);

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("GET returns the ticket detail", async () => {
    const res = await GET(new Request("http://t/"), ctx("tmp", taskId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.detail.id).toBe(taskId);
    expect(body.detail.risk).toBe("low");
    expect(body.detail.goal).toMatch(/edit me/i);
  }, 30_000);

  it("GET 404s for an unknown project", async () => {
    const res = await GET(new Request("http://t/"), ctx("nope", taskId));
    expect(res.status).toBe(404);
  });

  it("GET 404s for an unknown ticket", async () => {
    const res = await GET(new Request("http://t/"), ctx("tmp", "does-not-exist-999"));
    expect(res.status).toBe(404);
  }, 30_000);

  it("PATCH { risk: 'high' } updates risk and preserves the approved label", async () => {
    const req = new Request("http://t/", { method: "PATCH", body: JSON.stringify({ risk: "high" }) });
    const res = await PATCH(req, ctx("tmp", taskId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.detail.risk).toBe("high");

    const fresh = await beads.show(repo, taskId);
    expect(fresh.labels).toContain("approved");
    expect(fresh.labels).toContain("risk:high");
    expect(fresh.labels).not.toContain("risk:low");
  }, 30_000);

  it("PATCH with an unknown field 400s", async () => {
    const req = new Request("http://t/", {
      method: "PATCH",
      body: JSON.stringify({ bogus: true }),
    });
    const res = await PATCH(req, ctx("tmp", taskId));
    expect(res.status).toBe(400);
  });

  it("PATCH with an invalid value 400s", async () => {
    const req = new Request("http://t/", {
      method: "PATCH",
      body: JSON.stringify({ status: "done" }),
    });
    const res = await PATCH(req, ctx("tmp", taskId));
    expect(res.status).toBe(400);
  });

  it("DELETE removes the ticket, then 404s on a repeat", async () => {
    const doomed = await beads.create(repo, { title: "Delete me", type: "task" });

    const res = await DELETE(new Request("http://t/"), ctx("tmp", doomed));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    // The bead is gone — a re-read (and a repeat DELETE) both 404.
    const missing = await GET(new Request("http://t/"), ctx("tmp", doomed));
    expect(missing.status).toBe(404);
    const again = await DELETE(new Request("http://t/"), ctx("tmp", doomed));
    expect(again.status).toBe(404);
  }, 30_000);

  it("DELETE 404s for an unknown project", async () => {
    const res = await DELETE(new Request("http://t/"), ctx("nope", taskId));
    expect(res.status).toBe(404);
  });
});
