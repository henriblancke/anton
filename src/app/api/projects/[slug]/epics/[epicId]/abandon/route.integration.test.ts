/**
 * Real-bd route test for the epic abandon cascade (anton-6xj0). Boots a temp bd repo and drives the
 * actual handler: POST kills the epic's run, abandons every still-open child, then the epic itself —
 * keeping the beads (unlike DELETE, which destroys them) and leaving already-settled children
 * untouched. The job runner is mocked; skipped when `bd`/`git` aren't installed.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { beads } from "@/lib/beads/bd";
import { resetIssueSnapshots } from "@/lib/beads/snapshot";
import { type BdRepo, describeBd, jsonRequest, makeBdRepo, paramsCtx } from "@/lib/testing/integration";
import type { EpicAbandonResult } from "@/lib/abandon";
import type { Project } from "@/lib/types";

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

const post = (body: unknown) => jsonRequest("POST", body);

describeBd("epic abandon route (real bd)", () => {
  let bdRepo: BdRepo;
  let repo: string;
  let epicId: string;
  let openChild: string;
  let doneChild: string;

  beforeAll(async () => {
    bdRepo = makeBdRepo();
    repo = bdRepo.repo;
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
  });

  afterAll(() => {
    bdRepo?.cleanup();
  });

  beforeEach(() => {
    resetIssueSnapshots();
    cancelled.length = 0;
  });

  it("refuses without a reason, and writes nothing", async () => {
    expect((await POST(post({}), paramsCtx({ slug: "tmp", epicId }))).status).toBe(400);
    expect((await POST(post({ reason: " " }), paramsCtx({ slug: "tmp", epicId }))).status).toBe(400);
    expect((await beads.show(repo, epicId)).status).not.toBe("closed");
    expect(cancelled).toEqual([]);
  });

  it("404s an unknown epic or project", async () => {
    expect(
      (await POST(post({ reason: "x" }), paramsCtx({ slug: "tmp", epicId: "bd-nope" }))).status,
    ).toBe(404);
    expect((await POST(post({ reason: "x" }), paramsCtx({ slug: "nope", epicId }))).status).toBe(404);
  });

  it("abandons the epic and cascades to its open children only", async () => {
    const res = await POST(post({ reason: "the market moved" }), paramsCtx({ slug: "tmp", epicId }));
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
  });

  it("409s an epic whose outcome already settled", async () => {
    const res = await POST(post({ reason: "again" }), paramsCtx({ slug: "tmp", epicId }));
    expect(res.status).toBe(409);
  });
});
