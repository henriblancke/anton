/**
 * Real-bd route test for POST ticket notes (anton-bfy4). Boots a temp bd repo, points
 * getProjectBySlug at it, then drives the actual route handler: a note appends via `bd note` and
 * comes back as attributed history; a second note appends rather than replacing; an anton machine
 * note written straight to the blob stays a separate entry; empty/unknown inputs are refused.
 * Skipped when `bd`/`git` aren't installed. Mirrors the ticket route integration test.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { beads } from "@/lib/beads/bd";
import { describeBd, jsonRequest, makeBdRepo, paramsCtx, type BdRepo } from "@/lib/testing/integration";
import type { Project, TicketNote } from "@/lib/types";

let project: Project | null = null;

vi.mock("@/lib/projects", () => ({
  getProjectBySlug: async (slug: string) => (project && project.slug === slug ? project : null),
}));

const { POST } = await import("./route");
const { GET } = await import("../route");

const ctx = (slug: string, ticketId: string) => paramsCtx({ slug, ticketId });

const post = (slug: string, ticketId: string, body: unknown) =>
  POST(jsonRequest("POST", body), ctx(slug, ticketId));

describeBd("ticket notes route (real bd)", () => {
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
    taskId = await beads.create(repo, { title: "Steerable ticket", type: "task" });
  });

  afterAll(() => {
    bdRepo.cleanup();
  });

  it("appends a human note and returns the updated history", async () => {
    const res = await post("tmp", taskId, { text: "prefer the existing helper" });
    expect(res.status).toBe(200);
    const { notes } = (await res.json()) as { notes: TicketNote[] };
    expect(notes).toHaveLength(1);
    expect(notes[0]!.source).toBe("human");
    expect(notes[0]!.text).toBe("prefer the existing helper");
    expect(notes[0]!.at).toBeTruthy();
  });

  it("appends rather than replacing, and keeps an anton machine note as its own entry", async () => {
    await beads.note(repo, taskId, "anton: run failed after committing work — needs review");
    const res = await post("tmp", taskId, { text: "ignore the flaky test\nfix the real bug" });
    const { notes } = (await res.json()) as { notes: TicketNote[] };
    expect(notes.map((n) => n.source)).toEqual(["human", "system", "human"]);
    expect(notes[2]!.text).toBe("ignore the flaky test\nfix the real bug");
  });

  it("surfaces the history on the ticket detail GET", async () => {
    const res = await GET(new Request("http://t/"), ctx("tmp", taskId));
    const body = await res.json();
    expect(body.detail.notes.filter((n: TicketNote) => n.source === "human")).toHaveLength(2);
  });

  it("400s an empty note and 404s an unknown ticket or project", async () => {
    expect((await post("tmp", taskId, { text: "   " })).status).toBe(400);
    expect((await post("tmp", taskId, {})).status).toBe(400);
    expect((await post("tmp", "bd-nope", { text: "hi" })).status).toBe(404);
    expect((await post("nope", taskId, { text: "hi" })).status).toBe(404);
  });

  it("400s a note past the length cap rather than bloating the dispatch prompt", async () => {
    const res = await post("tmp", taskId, { text: "x".repeat(5_000) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/too long/i);
  });
});
