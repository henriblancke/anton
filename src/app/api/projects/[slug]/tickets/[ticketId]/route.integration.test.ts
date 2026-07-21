/**
 * Real-bd route test for GET/PATCH ticket. Boots a temp bd repo, points getProjectBySlug at it,
 * then drives the actual route handlers: GET returns a known bead's detail; PATCH { risk: "high" }
 * returns risk high and leaves the `approved` label intact; PATCH with an unknown field 400s; an
 * unknown ticket/project 404s. Skipped when `bd`/`git` aren't installed. Mirrors the
 * ticket-detail integration test.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { beads } from "@/lib/beads/bd";
import { describeBd, jsonRequest, makeBdRepo, paramsCtx, type BdRepo } from "@/lib/testing/integration";
import type { Project } from "@/lib/types";

let project: Project | null = null;

vi.mock("@/lib/projects", () => ({
  getProjectBySlug: async (slug: string) => (project && project.slug === slug ? project : null),
}));

const { GET, PATCH, DELETE } = await import("./route");

const ctx = (slug: string, ticketId: string) => paramsCtx({ slug, ticketId });

describeBd("ticket route (real bd)", () => {
  let bdRepo: BdRepo;
  let repo: string;
  let taskId: string;

  beforeAll(async () => {
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
    taskId = await beads.create(repo, {
      title: "Editable ticket",
      type: "task",
      description: "## Goal\nedit me",
    });
    await beads.tag(repo, taskId, ["agent:nextjs", "risk:low", "approved"]);
  });

  afterAll(() => {
    bdRepo.cleanup();
  });

  it("GET returns the ticket detail", async () => {
    const res = await GET(new Request("http://t/"), ctx("tmp", taskId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.detail.id).toBe(taskId);
    expect(body.detail.risk).toBe("low");
    expect(body.detail.goal).toMatch(/edit me/i);
  });

  it("GET 404s for an unknown project", async () => {
    const res = await GET(new Request("http://t/"), ctx("nope", taskId));
    expect(res.status).toBe(404);
  });

  it("GET 404s for an unknown ticket", async () => {
    const res = await GET(new Request("http://t/"), ctx("tmp", "does-not-exist-999"));
    expect(res.status).toBe(404);
  });

  it("PATCH { risk: 'high' } updates risk and preserves the approved label", async () => {
    const res = await PATCH(jsonRequest("PATCH", { risk: "high" }), ctx("tmp", taskId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.detail.risk).toBe("high");

    const fresh = await beads.show(repo, taskId);
    expect(fresh.labels).toContain("approved");
    expect(fresh.labels).toContain("risk:high");
    expect(fresh.labels).not.toContain("risk:low");
  });

  it("PATCH with an unknown field 400s", async () => {
    const res = await PATCH(jsonRequest("PATCH", { bogus: true }), ctx("tmp", taskId));
    expect(res.status).toBe(400);
  });

  it("PATCH with an invalid value 400s", async () => {
    const res = await PATCH(jsonRequest("PATCH", { status: "done" }), ctx("tmp", taskId));
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
  });

  it("DELETE 404s for an unknown project", async () => {
    const res = await DELETE(new Request("http://t/"), ctx("nope", taskId));
    expect(res.status).toBe(404);
  });
});
