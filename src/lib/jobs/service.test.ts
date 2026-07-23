/**
 * Service test for getRunningJobInfo (anton-susu): the project-scoped live read over the real
 * service → runner singleton. A running job's handler reports its session id + cwd via ctx.report;
 * the service surfaces it only to the owning project, and the info clears once the job settles.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";

// One db for the whole file: the jobs service caches a runner singleton bound to getDb() on first
// use, so every test must share the same connection.
let tdb: TestDb;

vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));
// service.ts imports the sync engine only to start it in startRunner(); these tests never do.
vi.mock("@/lib/beads/sync-engine", () => ({ startSyncEngine: () => {} }));

const { getRunner, getRunningJobInfo } = await import("./service");

describe("getRunningJobInfo (service, project-scoped)", () => {
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

  it("returns the reported info for the owning project only, and clears on settle", async () => {
    const runner = getRunner();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reported!: () => void;
    const reportedGate = new Promise<void>((resolve) => (reported = resolve));
    // Replace the real execute-epic handler with a stub that reports, then stays in flight.
    runner.registerHandler("execute-epic", async (ctx) => {
      ctx.report({ sessionId: "sess-live", cwd: "/tmp/alpha/wt" });
      reported();
      await gate;
    });

    const id = await runner.enqueue({ type: "execute-epic", projectId: "p-alpha" });
    await runner.tickOnce();
    await reportedGate;

    expect(await getRunningJobInfo("p-alpha", id)).toEqual({
      sessionId: "sess-live",
      cwd: "/tmp/alpha/wt",
      type: "execute-epic",
    });
    // Project scoping: another project can't introspect this job by id; unknown ids read nothing.
    expect(await getRunningJobInfo("p-beta", id)).toBeUndefined();
    expect(await getRunningJobInfo("p-alpha", randomUUID())).toBeUndefined();

    release();
    await runner.whenIdle();
    // Settled → the live handle is gone; a done job reports nothing.
    expect(await getRunningJobInfo("p-alpha", id)).toBeUndefined();
  });

  it("is undefined for a job that exists but is not in flight on this instance", async () => {
    // A `running` row leased by another machine (or a since-restarted process): the row exists and
    // is project-scoped correctly, but this process holds no live handle for it.
    const id = randomUUID();
    await tdb.db.insert(schema.jobs).values({
      id,
      type: "execute-epic",
      projectId: "p-alpha",
      status: "running",
    });
    expect(await getRunningJobInfo("p-alpha", id)).toBeUndefined();
  });
});
