/**
 * Real-bd route test for POST ticket notes (anton-bfy4). Boots a temp bd repo, points
 * getProjectBySlug at it, then drives the actual route handler: a note appends via `bd note` and
 * comes back as attributed history; a second note appends rather than replacing; an anton machine
 * note written straight to the blob stays a separate entry; empty/unknown inputs are refused.
 * Skipped when `bd`/`git` aren't installed. Mirrors the ticket route integration test.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beads } from "@/lib/beads/bd";
import type { Project, TicketNote } from "@/lib/types";

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

const { POST } = await import("./route");
const { GET } = await import("../route");

const ctx = (slug: string, ticketId: string) => ({ params: Promise.resolve({ slug, ticketId }) });

const post = (slug: string, ticketId: string, body: unknown) =>
  POST(new Request("http://t/", { method: "POST", body: JSON.stringify(body) }), ctx(slug, ticketId));

const suite = has("bd") && has("git") ? describe : describe.skip;

suite("ticket notes route (real bd)", () => {
  let repo: string;
  let taskId: string;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "anton-bd-notes-"));
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
    taskId = await beads.create(repo, { title: "Steerable ticket", type: "task" });
  }, 30_000);

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("appends a human note and returns the updated history", async () => {
    const res = await post("tmp", taskId, { text: "prefer the existing helper" });
    expect(res.status).toBe(200);
    const { notes } = (await res.json()) as { notes: TicketNote[] };
    expect(notes).toHaveLength(1);
    expect(notes[0]!.source).toBe("human");
    expect(notes[0]!.text).toBe("prefer the existing helper");
    expect(notes[0]!.at).toBeTruthy();
  }, 30_000);

  it("appends rather than replacing, and keeps an anton machine note as its own entry", async () => {
    await beads.note(repo, taskId, "anton: run failed after committing work — needs review");
    const res = await post("tmp", taskId, { text: "ignore the flaky test\nfix the real bug" });
    const { notes } = (await res.json()) as { notes: TicketNote[] };
    expect(notes.map((n) => n.source)).toEqual(["human", "system", "human"]);
    expect(notes[2]!.text).toBe("ignore the flaky test\nfix the real bug");
  }, 30_000);

  it("surfaces the history on the ticket detail GET", async () => {
    const res = await GET(new Request("http://t/"), ctx("tmp", taskId));
    const body = await res.json();
    expect(body.detail.notes.filter((n: TicketNote) => n.source === "human")).toHaveLength(2);
  }, 30_000);

  it("400s an empty note and 404s an unknown ticket or project", async () => {
    expect((await post("tmp", taskId, { text: "   " })).status).toBe(400);
    expect((await post("tmp", taskId, {})).status).toBe(400);
    expect((await post("tmp", "bd-nope", { text: "hi" })).status).toBe(404);
    expect((await post("nope", taskId, { text: "hi" })).status).toBe(404);
  }, 30_000);

  it("400s a note past the length cap rather than bloating the dispatch prompt", async () => {
    const res = await post("tmp", taskId, { text: "x".repeat(5_000) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/too long/i);
  }, 30_000);
});
