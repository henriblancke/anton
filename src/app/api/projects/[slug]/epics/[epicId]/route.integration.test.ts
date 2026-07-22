/**
 * Real-bd route test for GET/PATCH/DELETE epic. Boots a temp bd repo, points getProjectBySlug at
 * it, then drives the actual route handlers: GET returns a known epic's detail; PATCH { priority }
 * lands on the bead and returns the refreshed detail; PATCH with an unknown field / bad value / bad
 * JSON 400s; an unknown epic/project 404s; a non-"not found" failure from updateEpic surfaces as a
 * 500 (not a misleading 404). Skipped when `bd`/`git` aren't installed. Mirrors the ticket route
 * test and the epic-detail integration test.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { beads } from "@/lib/beads/bd";
import * as epicDetail from "@/lib/epic-detail";
import { resetIssueSnapshots } from "@/lib/beads/snapshot";
import { describeBd, jsonRequest, makeBdRepo, paramsCtx, type BdRepo } from "@/lib/testing/integration";
import type { Project } from "@/lib/types";

let project: Project | null = null;

vi.mock("@/lib/projects", () => ({
  getProjectBySlug: async (slug: string) => (project && project.slug === slug ? project : null),
}));

const { GET, PATCH, DELETE } = await import("./route");

const ctx = (slug: string, epicId: string) => paramsCtx({ slug, epicId });

describeBd("epic route (real bd)", () => {
  let bdRepo: BdRepo;
  let repo: string;
  let epicId: string;

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
    epicId = await beads.create(repo, {
      title: "Prioritizable epic",
      type: "epic",
      description: "## Goal\nRank me.",
    });
  });

  afterAll(() => {
    bdRepo.cleanup();
  });

  // One shared repo, so clear the read-after-write snapshot between cases (see epic-detail integration).
  beforeEach(() => resetIssueSnapshots());

  it("GET returns the epic detail", async () => {
    const res = await GET(new Request("http://t/"), ctx("tmp", epicId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.detail.epic.id).toBe(epicId);
    expect(body.detail.epic.goal).toMatch(/rank me/i);
  });

  it("GET 404s for an unknown project", async () => {
    const res = await GET(new Request("http://t/"), ctx("nope", epicId));
    expect(res.status).toBe(404);
  });

  it("PATCH { priority: 1 } updates priority and reflects it in bd show", async () => {
    const res = await PATCH(jsonRequest("PATCH", { priority: 1 }), ctx("tmp", epicId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.detail.epic.priority).toBe(1);

    const fresh = await beads.show(repo, epicId);
    expect(fresh.priority).toBe(1);
  });

  it("PATCH with an unknown field 400s", async () => {
    const res = await PATCH(jsonRequest("PATCH", { bogus: true }), ctx("tmp", epicId));
    expect(res.status).toBe(400);
  });

  it("PATCH with an invalid priority value 400s", async () => {
    const res = await PATCH(jsonRequest("PATCH", { priority: 99 }), ctx("tmp", epicId));
    expect(res.status).toBe(400);
  });

  it("PATCH with a non-JSON body 400s", async () => {
    const res = await PATCH(
      new Request("http://t/", { method: "PATCH", body: "not json" }),
      ctx("tmp", epicId),
    );
    expect(res.status).toBe(400);
  });

  it("PATCH 404s for an unknown project", async () => {
    const res = await PATCH(jsonRequest("PATCH", { priority: 1 }), ctx("nope", epicId));
    expect(res.status).toBe(404);
  });

  it("PATCH 404s for an unknown epic", async () => {
    const res = await PATCH(jsonRequest("PATCH", { priority: 1 }), ctx("tmp", "does-not-exist-999"));
    expect(res.status).toBe(404);
  });

  // A non-"not found" failure (e.g. a disk/write error) must surface as 500, not a misleading 404.
  it("PATCH surfaces a non-404 updateEpic failure as 500", async () => {
    const spy = vi
      .spyOn(epicDetail, "updateEpic")
      .mockRejectedValueOnce(new Error("disk write failed"));
    const res = await PATCH(jsonRequest("PATCH", { priority: 2 }), ctx("tmp", epicId));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Failed to update epic");
    spy.mockRestore();
  });

  it("DELETE removes the epic, then 404s on a repeat", async () => {
    const doomed = await beads.create(repo, { title: "Delete me", type: "epic" });

    const res = await DELETE(new Request("http://t/"), ctx("tmp", doomed));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const again = await DELETE(new Request("http://t/"), ctx("tmp", doomed));
    expect(again.status).toBe(404);
  });
});
