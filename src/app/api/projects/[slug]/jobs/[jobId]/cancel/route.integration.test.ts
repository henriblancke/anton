/**
 * Route test for POST /api/projects/[slug]/jobs/[jobId]/cancel, exercising the real service →
 * runner → queue → db stack over one in-memory anton.db (so the runner singleton binds to it).
 * Covers the HTTP contract from anton-a4jj: 200 acts + row terminalized, 409 when already terminal,
 * 404 for a job in another project (project-scoping) or an unknown slug.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";

// One db for the whole file: the jobs service caches a runner singleton bound to getDb() on first
// use, so every test must share the same connection.
let tdb: TestDb;

vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));
// service.ts imports the sync engine only to start it in startRunner(); the cancel path never does.
vi.mock("@/lib/beads/sync-engine", () => ({ startSyncEngine: () => {} }));

const { POST } = await import("./route");

const ctx = (slug: string, jobId: string) => ({ params: Promise.resolve({ slug, jobId }) });
const req = () => new Request("http://t/", { method: "POST" });

/** Seed a job row directly, returning its id. */
async function seedJob(projectId: string, status: string): Promise<string> {
  const id = randomUUID();
  await tdb.db.insert(schema.jobs).values({ id, type: "execute-epic", projectId, status });
  return id;
}

describe("POST /api/projects/[slug]/jobs/[jobId]/cancel", () => {
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

  it("200 cancels a queued job and terminalizes the row", async () => {
    const id = await seedJob("p-alpha", "queued");
    const res = await POST(req(), ctx("alpha", id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });
    const row = await tdb.db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(row[0].status).toBe("cancelled");
  });

  it("409 when the job is already terminal", async () => {
    const id = await seedJob("p-alpha", "done");
    const res = await POST(req(), ctx("alpha", id));
    expect(res.status).toBe(409);
    expect((await res.json()).cancelled).toBe(false);
    // The terminal row is left untouched.
    const row = await tdb.db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(row[0].status).toBe("done");
  });

  it("404 for a job that belongs to another project (project-scoping)", async () => {
    const id = await seedJob("p-alpha", "queued");
    const res = await POST(req(), ctx("beta", id)); // beta cannot cancel alpha's job
    expect(res.status).toBe(404);
    // Untouched — scoping refuses before any terminalization.
    const row = await tdb.db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(row[0].status).toBe("queued");
  });

  it("404 for an unknown project slug", async () => {
    const id = await seedJob("p-alpha", "queued");
    const res = await POST(req(), ctx("nope", id));
    expect(res.status).toBe(404);
  });
});
