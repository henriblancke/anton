/**
 * Real-bd route test for the snooze toggle (anton-ywi8). Boots a temp bd repo, points
 * getProjectBySlug at it, then drives the actual handlers: POST parks the ticket (out of
 * `bd ready`, detail reads `deferred`), DELETE restores it to both. Skipped when `bd`/`git` aren't
 * installed. Mirrors the notes route integration test.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { beads } from "@/lib/beads/bd";
import { resetIssueSnapshots } from "@/lib/beads/snapshot";
import { describeBd, makeBdRepo, paramsCtx, type BdRepo } from "@/lib/testing/integration";
import type { Project, TicketDetail } from "@/lib/types";

let project: Project | null = null;

vi.mock("@/lib/projects", () => ({
  getProjectBySlug: async (slug: string) => (project && project.slug === slug ? project : null),
}));

const { POST, DELETE } = await import("./route");

const ctx = (slug: string, ticketId: string) => paramsCtx({ slug, ticketId });
const req = new Request("http://t/");

describeBd("ticket defer route (real bd)", () => {
  let bdRepo: BdRepo;
  let repo: string;
  let taskId: string;

  const readyIds = async () => (await beads.ready(repo)).map((b) => b.id);

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
    taskId = await beads.create(repo, { title: "Not now, not dead", type: "task" });
  }, 30_000);

  afterAll(() => {
    bdRepo.cleanup();
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
