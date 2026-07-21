/**
 * Real-bd route test for the ticket abandon outcome (anton-6xj0). Boots a temp bd repo, points
 * getProjectBySlug at it, then drives the actual handler: POST kills the live run, closes the bead
 * with the reason and tags it `abandoned`, and the ticket leaves the ready queue without ever
 * reading as delivered. The job runner is mocked — this asserts the cancel is REQUESTED for the
 * right run target; the runner's own kill semantics are covered by anton-a4jj's tests. Skipped when
 * `bd`/`git` aren't installed. Mirrors the defer route integration test.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { beads } from "@/lib/beads/bd";
import { resetIssueSnapshots } from "@/lib/beads/snapshot";
import { describeBd, jsonRequest, makeBdRepo, paramsCtx, type BdRepo } from "@/lib/testing/integration";
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
const post = (body: unknown) => jsonRequest("POST", body);

describeBd("ticket abandon route (real bd)", () => {
  let bdRepo: BdRepo;
  let repo: string;
  let epicId: string;
  let childId: string;
  let looseId: string;

  const readyIds = async () => (await beads.ready(repo)).map((b) => b.id);

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
    epicId = await beads.create(repo, { title: "An epic", type: "epic" });
    childId = await beads.create(repo, {
      title: "Won't do this",
      type: "task",
      deps: [`parent-child:${epicId}`],
    });
    looseId = await beads.create(repo, { title: "A loose task", type: "task" });
  }, 30_000);

  afterAll(() => {
    bdRepo.cleanup();
  });

  // The cases share one repo, so a warm snapshot would leak a pre-write bead list between them.
  beforeEach(() => {
    resetIssueSnapshots();
    cancelled.length = 0;
  });

  it("closes the ticket, tags it abandoned, and kills the run of its parent epic", async () => {
    const res = await POST(post({ reason: "superseded by the new flow" }), ctx("tmp", childId));
    expect(res.status).toBe(200);
    const { detail } = (await res.json()) as { detail: TicketDetail };
    expect(detail.abandoned).toBe(true);
    expect(detail.status).toBe("closed");

    // A child ticket runs inside its epic's run — that is the job to kill, not the ticket's own id.
    expect(cancelled).toEqual([["proj-1", epicId]]);

    const bead = await beads.show(repo, childId);
    expect(beads.isAbandoned(bead)).toBe(true);
    expect(await readyIds()).not.toContain(childId);
  }, 30_000);

  it("kills the ticket's own run when it is a parentless (epic-of-one) target", async () => {
    const res = await POST(post({ reason: "not worth doing" }), ctx("tmp", looseId));
    expect(res.status).toBe(200);
    expect(cancelled).toEqual([["proj-1", looseId]]);
  }, 30_000);

  it("refuses without a reason, and leaves the ticket alone", async () => {
    const open = await beads.create(repo, { title: "Still open", type: "task" });
    for (const body of [{}, { reason: "   " }, { reason: 5 }]) {
      const res = await POST(post(body), ctx("tmp", open));
      expect(res.status).toBe(400);
    }
    const res = await POST(
      new Request("http://t/", { method: "POST", body: "not json" }),
      ctx("tmp", open),
    );
    expect(res.status).toBe(400);

    expect((await beads.show(repo, open)).status).not.toBe("closed");
    expect(cancelled).toEqual([]);
  }, 30_000);

  it("409s a ticket whose outcome already settled", async () => {
    const res = await POST(post({ reason: "again" }), ctx("tmp", childId));
    expect(res.status).toBe(409);
  }, 30_000);

  it("404s an unknown ticket or project", async () => {
    expect((await POST(post({ reason: "x" }), ctx("tmp", "bd-nope"))).status).toBe(404);
    expect((await POST(post({ reason: "x" }), ctx("nope", childId))).status).toBe(404);
  }, 30_000);
});
