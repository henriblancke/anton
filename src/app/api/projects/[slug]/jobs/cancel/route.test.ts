/**
 * Route test for POST /api/projects/[slug]/jobs/cancel, exercising the real service → runner →
 * queue → db stack over one in-memory anton.db (so the runner singleton binds to it). Mirrors the
 * single-job cancel route test: same harness, same project-scoping guarantees — plus the batch
 * contract from anton-mjdo.4 (per-job buckets, partial failure never fails the batch, capped size).
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";
import { jsonRequest, paramsCtx } from "@/lib/testing/integration";
import { PAGE_SIZE } from "@/lib/pagination";

// One db for the whole file: the jobs service caches a runner singleton bound to getDb() on first
// use, so every test must share the same connection.
let tdb: TestDb;

vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));
// service.ts imports the sync engine only to start it in startRunner(); the cancel path never does.
vi.mock("@/lib/beads/sync-engine", () => ({ startSyncEngine: () => {} }));

const { POST } = await import("./route");

const ctx = (slug: string) => paramsCtx({ slug });
const req = (body?: unknown) => jsonRequest("POST", body);

/** Seed a job row directly, returning its id. */
async function seedJob(projectId: string, status: string): Promise<string> {
  const id = randomUUID();
  await tdb.db.insert(schema.jobs).values({ id, type: "execute-epic", projectId, status });
  return id;
}

async function statusOf(id: string): Promise<string> {
  const rows = await tdb.db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
  return rows[0].status;
}

describe("POST /api/projects/[slug]/jobs/cancel", () => {
  beforeAll(() => {
    tdb = makeTestDb();
  });
  afterAll(() => tdb.close());

  beforeEach(async () => {
    await tdb.db.delete(schema.jobs);
    await tdb.db.delete(schema.projects);
    await tdb.db.insert(schema.projects).values([
      { id: "p-alpha", slug: "alpha", name: "Alpha", repoPath: "/tmp/alpha" },
      { id: "p-beta", slug: "beta", name: "Beta", repoPath: "/tmp/beta" },
    ]);
  });

  it("200 cancels every job in a clean batch and terminalizes each row", async () => {
    const ids = [
      await seedJob("p-alpha", "queued"),
      await seedJob("p-alpha", "running"),
      await seedJob("p-alpha", "parked"),
    ];
    const res = await POST(req({ jobIds: ids }), ctx("alpha"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: ids, failed: [] });
    for (const id of ids) expect(await statusOf(id)).toBe("cancelled");
  });

  it("200 with both buckets populated when one job is already terminal", async () => {
    const terminal = await seedJob("p-alpha", "done");
    const live = [await seedJob("p-alpha", "queued"), await seedJob("p-alpha", "running")];

    const res = await POST(req({ jobIds: [live[0], terminal, live[1]] }), ctx("alpha"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      cancelled: live,
      failed: [
        {
          jobId: terminal,
          reason: "not-cancellable",
          error: "Job is not cancellable (already terminal)",
        },
      ],
    });
    // The one refusal never blocks the rest, and the terminal row keeps its own status.
    for (const id of live) expect(await statusOf(id)).toBe("cancelled");
    expect(await statusOf(terminal)).toBe("done");
  });

  it("reports another project's job as not-found without cancelling it", async () => {
    const mine = await seedJob("p-alpha", "queued");
    const foreign = await seedJob("p-beta", "running");

    const res = await POST(req({ jobIds: [mine, foreign] }), ctx("alpha"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      cancelled: [mine],
      failed: [{ jobId: foreign, reason: "not-found", error: "Job not found" }],
    });
    // Batching must not become a cross-project cancel.
    expect(await statusOf(foreign)).toBe("running");
    expect(await statusOf(mine)).toBe("cancelled");
  });

  it("is idempotent for duplicate ids — one kill, no spurious failure", async () => {
    const id = await seedJob("p-alpha", "queued");
    const res = await POST(req({ jobIds: [id, id, id] }), ctx("alpha"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: [id], failed: [] });
    expect(await statusOf(id)).toBe("cancelled");
  });

  it("404 for an unknown project slug", async () => {
    const id = await seedJob("p-alpha", "queued");
    const res = await POST(req({ jobIds: [id] }), ctx("nope"));
    expect(res.status).toBe(404);
    expect(await statusOf(id)).toBe("queued");
  });

  describe("400s", () => {
    it("rejects an empty jobIds array", async () => {
      const res = await POST(req({ jobIds: [] }), ctx("alpha"));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Invalid request");
    });

    it.each([
      ["a missing jobIds key", {}],
      ["a non-array jobIds", { jobIds: "abc" }],
      ["non-string ids", { jobIds: [1, 2] }],
      ["empty-string ids", { jobIds: [""] }],
    ])("rejects %s", async (_label, body) => {
      const res = await POST(req(body), ctx("alpha"));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Invalid request");
    });

    it("rejects a request with no body at all", async () => {
      const res = await POST(req(), ctx("alpha"));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Invalid JSON body");
    });

    it("rejects an over-cap batch rather than silently truncating it", async () => {
      const ids: string[] = [];
      for (let i = 0; i <= PAGE_SIZE; i++) ids.push(await seedJob("p-alpha", "queued"));
      expect(ids.length).toBe(PAGE_SIZE + 1);

      const res = await POST(req({ jobIds: ids }), ctx("alpha"));

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Invalid request");
      // Nothing was killed — an over-cap batch must not leave a half-killed page behind.
      const rows = await tdb.db.select().from(schema.jobs).where(inArray(schema.jobs.id, ids));
      expect(rows.every((r) => r.status === "queued")).toBe(true);
    });
  });
});
