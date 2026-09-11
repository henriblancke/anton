/**
 * Route test for POST /api/projects/[slug]/schedules/[type]/run (Settings → Automation's "Run
 * now"), exercising the real service → runner → schedules → queue → db stack over one in-memory
 * anton.db. Covers the HTTP contract: 200 enqueues, 404 unknown type / no row yet, 409 when the
 * automation is off or already active, 404 for an unknown project slug.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";
import { jsonRequest, paramsCtx } from "@/lib/testing/integration";
import { seedDefaultSchedules } from "@/lib/schedules";

let tdb: TestDb;

vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));
vi.mock("@/lib/beads/sync-engine", () => ({ startSyncEngine: () => {} }));

const { POST } = await import("./route");

const ctx = (slug: string, type: string) => paramsCtx({ slug, type });
const req = () => jsonRequest("POST");

function scheduleRow(type: string) {
  return tdb.db.select().from(schema.schedules).where(eq(schema.schedules.type, type)).all()[0];
}

describe("POST /api/projects/[slug]/schedules/[type]/run", () => {
  beforeAll(() => {
    tdb = makeTestDb();
  });
  afterAll(() => tdb.close());

  beforeEach(async () => {
    await tdb.db.delete(schema.jobs);
    await tdb.db.delete(schema.schedules);
    await tdb.db.delete(schema.projects);
    await tdb.db.insert(schema.projects).values({ id: "p1", slug: "tmp", name: "tmp", repoPath: "/tmp/p1" });
    await seedDefaultSchedules(tdb.db, { now: () => Date.now() }, "p1");
  });

  it("200 enqueues the job and stamps lastRunAt", async () => {
    // nightly-stringer is enabled by default (schedules.ts).
    const res = await POST(req(), ctx("tmp", "nightly-stringer"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobId).toEqual(expect.any(String));

    const job = tdb.db.select().from(schema.jobs).where(eq(schema.jobs.id, body.jobId)).all()[0];
    expect(job.type).toBe("nightly-stringer");
    expect(job.projectId).toBe("p1");
    expect(job.status).toBe("queued");

    expect(scheduleRow("nightly-stringer").lastRunAt).not.toBeNull();
  });

  it("409 when the automation is off", async () => {
    // gardener ships disabled (schedules.ts).
    const res = await POST(req(), ctx("tmp", "gardener"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("disabled");
    expect(tdb.db.select().from(schema.jobs).all()).toHaveLength(0);
  });

  it("409 when a job of this type is already active for the project", async () => {
    const first = await POST(req(), ctx("tmp", "nightly-stringer"));
    expect(first.status).toBe(200);

    const second = await POST(req(), ctx("tmp", "nightly-stringer"));
    expect(second.status).toBe(409);
    expect((await second.json()).reason).toBe("already-running");
    expect(tdb.db.select().from(schema.jobs).all()).toHaveLength(1);
  });

  it("404 for an unknown schedule type", async () => {
    const res = await POST(req(), ctx("tmp", "not-a-type"));
    expect(res.status).toBe(404);
  });

  it("404 when the project has no row for this type yet", async () => {
    await tdb.db.delete(schema.schedules).where(eq(schema.schedules.type, "review-fix"));
    const res = await POST(req(), ctx("tmp", "review-fix"));
    expect(res.status).toBe(404);
    expect((await res.json()).reason).toBe("not-found");
  });

  it("404 for an unknown project slug", async () => {
    const res = await POST(req(), ctx("nope", "nightly-stringer"));
    expect(res.status).toBe(404);
  });
});
