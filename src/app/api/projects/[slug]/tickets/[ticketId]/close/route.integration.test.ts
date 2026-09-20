/**
 * Real-bd route test for the human-work close (anton-fgqr). Boots a temp bd repo, points
 * getProjectBySlug at it, then drives the actual handler: POST closes an open `agent:human` bead as
 * done, and 409s everything this action must refuse — agent work, an already-settled bead, and open
 * work still underneath it. The job runner is mocked — this asserts the cancel is REQUESTED for the
 * right run target before the close is written, same as the abandon route integration test. Skipped
 * when `bd`/`git` aren't installed. Mirrors the abandon route integration test.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { beads } from "@/lib/beads/bd";
import { resetIssueSnapshots } from "@/lib/beads/snapshot";
import { describeBd, makeBdRepo, paramsCtx, tmpProject, type BdRepo } from "@/lib/testing/integration";
import type { Project, TicketDetail } from "@/lib/types";

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

const ctx = (slug: string, ticketId: string) => paramsCtx({ slug, ticketId });
const req = new Request("http://t/", { method: "POST" });

describeBd("ticket close route (real bd)", () => {
  let bdRepo: BdRepo;
  let repo: string;

  beforeAll(() => {
    bdRepo = makeBdRepo();
    repo = bdRepo.repo;
    project = tmpProject(repo, { id: "proj-1" });
  });

  afterAll(() => {
    bdRepo.cleanup();
  });

  // Every case creates its own beads, so a warm snapshot would leak a pre-write list between them.
  beforeEach(() => {
    resetIssueSnapshots();
    cancelled.length = 0;
  });

  it("closes an open agent:human ticket as done, cancelling any run still executing it first", async () => {
    const id = await beads.create(repo, {
      title: "Sign the contract",
      type: "task",
      labels: ["agent:human"],
    });

    const res = await POST(req, ctx("tmp", id));
    expect(res.status).toBe(200);
    const { detail } = (await res.json()) as { detail: TicketDetail };
    expect(detail.status).toBe("closed");
    expect(detail.abandoned).toBe(false);

    const bead = await beads.show(repo, id);
    expect(bead.status).toBe("closed");
    expect(beads.isAbandoned(bead)).toBe(false);
    expect(cancelled).toEqual([["proj-1", id]]);
  });

  it("409s work an agent run is expected to close instead", async () => {
    const id = await beads.create(repo, { title: "Ship the feature", type: "task" });
    const res = await POST(req, ctx("tmp", id));
    expect(res.status).toBe(409);
    expect((await beads.show(repo, id)).status).not.toBe("closed");
  });

  it("409s a ticket whose outcome already settled", async () => {
    const id = await beads.create(repo, {
      title: "Already done",
      type: "task",
      labels: ["agent:human"],
    });
    await beads.close(repo, id);
    resetIssueSnapshots();

    const res = await POST(req, ctx("tmp", id));
    expect(res.status).toBe(409);
  });

  it("409s an already-abandoned bead too", async () => {
    const id = await beads.create(repo, {
      title: "Won't do this",
      type: "task",
      labels: ["agent:human"],
    });
    await beads.abandon(repo, id, "cut from the release");
    resetIssueSnapshots();

    const res = await POST(req, ctx("tmp", id));
    expect(res.status).toBe(409);
  });

  it("409s a human run target that still has open work under it, and leaves it open", async () => {
    const epicId = await beads.create(repo, {
      title: "Onboard the vendor",
      type: "epic",
      labels: ["agent:human"],
    });
    const childId = await beads.create(repo, {
      title: "Sign the SOW",
      type: "task",
      labels: ["agent:human"],
      deps: [`parent-child:${epicId}`],
    });
    resetIssueSnapshots();

    const res = await POST(req, ctx("tmp", epicId));
    expect(res.status).toBe(409);
    expect((await beads.show(repo, epicId)).status).not.toBe("closed");
    expect((await beads.show(repo, childId)).status).not.toBe("closed");
  });

  it("closes a human run target once its child work is already settled", async () => {
    const epicId = await beads.create(repo, {
      title: "Onboard the vendor",
      type: "epic",
      labels: ["agent:human"],
    });
    const childId = await beads.create(repo, {
      title: "Sign the SOW",
      type: "task",
      labels: ["agent:human"],
      deps: [`parent-child:${epicId}`],
    });
    resetIssueSnapshots();
    expect((await POST(req, ctx("tmp", childId))).status).toBe(200);
    resetIssueSnapshots();

    const res = await POST(req, ctx("tmp", epicId));
    expect(res.status).toBe(200);
    expect((await beads.show(repo, epicId)).status).toBe("closed");
  });

  it("404s an unknown ticket or project", async () => {
    expect((await POST(req, ctx("tmp", "bd-nope"))).status).toBe(404);
    expect((await POST(req, ctx("nope", "bd-nope"))).status).toBe(404);
  });
});
