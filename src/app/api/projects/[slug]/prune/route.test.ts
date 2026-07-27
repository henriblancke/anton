/**
 * POST /prune contract (PR #70 review): a forced prune is a DESTRUCTIVE operator board write, so it
 * must propagate through nudgeSync — the immediate push plus the durable, deduped sync-push job
 * that retries with backoff and parks on exhaustion. A bare `beads.sync(...).catch(...)` would leave
 * the deletion with only the in-memory heartbeat retry, silently stranded when the remote is down.
 * A preview writes nothing, so it must not nudge at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const project = { id: "p1", slug: "tmp", repoPath: "/tmp/p1" };

vi.mock("../resolve-project", () => ({
  resolveProject: vi.fn(async () => ({ project })),
}));

const prune = vi.fn(async () => 7);
const sync = vi.fn(async () => {});
vi.mock("@/lib/beads/bd", () => ({ beads: { prune, sync } }));

const nudgeSync = vi.fn();
vi.mock("@/lib/beads/sync-nudge", () => ({ nudgeSync }));

const { POST } = await import("./route");

const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const pruneReq = (body: unknown) =>
  new Request("http://t/prune", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

afterEach(() => vi.clearAllMocks());

describe("POST /prune — sync propagation", () => {
  it("routes a forced prune through nudgeSync so it gets the durable sync-push backstop", async () => {
    const res = await POST(pruneReq({ age: "90d", force: true }), ctx("tmp"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 7, pruned: true });
    expect(prune).toHaveBeenCalledWith(project.repoPath, "90d", { force: true });
    // Project id is what keys the deduped sync-push job — a repoPath-only nudge can't enqueue it.
    expect(nudgeSync).toHaveBeenCalledWith({ id: project.id, repoPath: project.repoPath }, "prune");
    // The bare fire-and-forget push is nudgeSync's job now, not the route's.
    expect(sync).not.toHaveBeenCalled();
  });

  it("does not nudge for a dry-run preview, which writes nothing", async () => {
    const res = await POST(pruneReq({ age: "30d" }), ctx("tmp"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 7, pruned: false });
    expect(prune).toHaveBeenCalledWith(project.repoPath, "30d", { force: false });
    expect(nudgeSync).not.toHaveBeenCalled();
  });

  it("rejects an invalid age without pruning or nudging", async () => {
    const res = await POST(pruneReq({ age: "7d", force: true }), ctx("tmp"));

    expect(res.status).toBe(400);
    expect(prune).not.toHaveBeenCalled();
    expect(nudgeSync).not.toHaveBeenCalled();
  });

  it("500s without nudging when the prune itself fails", async () => {
    prune.mockRejectedValueOnce(new Error("bd prune failed"));

    const res = await POST(pruneReq({ age: "all", force: true }), ctx("tmp"));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("bd prune failed");
    expect(nudgeSync).not.toHaveBeenCalled();
  });
});
