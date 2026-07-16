/**
 * Schedules route tests against a real in-memory anton.db: GET returns the project's real
 * schedule rows; PATCH flips schedules.enabled (clearing/reseeding nextRunAt so the scheduler
 * loop actually stops/starts enqueuing); a missing row is created explicitly (created: true),
 * not silently no-oped; bad input 400s and an unknown project 404s.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";
import type { Clock } from "@/lib/jobs/queue";
import { Scheduler } from "@/lib/jobs/scheduler";
import { seedDefaultSchedules } from "@/lib/schedules";
import type { Project } from "@/lib/types";

let project: Project | null = null;
let tdb: TestDb;

vi.mock("@/lib/projects", () => ({
  getProjectBySlug: async (slug: string) => (project && project.slug === slug ? project : null),
}));

// Point the shared getDb() (used by the route and by schedules.ts' UI read path) at the test db.
vi.mock("@/lib/db", () => ({
  getDb: () => tdb.db,
  schema,
}));

const { GET, PATCH } = await import("./route");

const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });

function patchReq(body: unknown): Request {
  return new Request("http://t/", { method: "PATCH", body: JSON.stringify(body) });
}

class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
}

function scheduleRow(type: string) {
  return tdb.db.select().from(schema.schedules).where(eq(schema.schedules.type, type)).all()[0];
}

function jobs() {
  return tdb.db.select().from(schema.jobs).all();
}

describe("schedules route", () => {
  beforeEach(async () => {
    tdb = makeTestDb();
    project = {
      id: "p1",
      slug: "tmp",
      name: "tmp",
      repoPath: "/tmp/p1",
      defaultBranch: "main",
      hasBeads: true,
      createdAt: 0,
    };
    await tdb.db.insert(schema.projects).values({
      id: "p1",
      slug: "tmp",
      name: "tmp",
      repoPath: "/tmp/p1",
    });
    await seedDefaultSchedules(tdb.db, { now: () => Date.now() }, "p1");
  });

  it("GET returns the project's real schedule rows", async () => {
    const res = await GET(new Request("http://t/"), ctx("tmp"));
    expect(res.status).toBe(200);
    const { schedules } = await res.json();
    expect(schedules).toHaveLength(3);
    const types = schedules.map((s: { type: string }) => s.type).sort();
    expect(types).toEqual(["nightly-stringer", "orphan-grooming", "review-fix"]);
    for (const s of schedules) expect(s.enabled).toBe(true);
  });

  it("GET 404s for an unknown project", async () => {
    const res = await GET(new Request("http://t/"), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("PATCH enabled:false disables the row and the scheduler skips it", async () => {
    const dueMs = Number(scheduleRow("nightly-stringer").nextRunAt!.getTime()) + 60_000;

    const res = await PATCH(patchReq({ type: "nightly-stringer", enabled: false }), ctx("tmp"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.schedule.enabled).toBe(false);

    const row = scheduleRow("nightly-stringer");
    expect(row.enabled).toBe(false);
    expect(row.nextRunAt).toBeNull();

    // Past the old due time, a tick enqueues nothing for the disabled schedule. (The other two
    // defaults are still enabled but not due at this instant only if dueMs precedes them — so
    // assert specifically that no nightly-stringer job exists.)
    const scheduler = new Scheduler({ db: tdb.db, clock: new FakeClock(dueMs) });
    await scheduler.tickOnce();
    expect(jobs().filter((j) => j.type === "nightly-stringer")).toHaveLength(0);
  });

  it("PATCH enabled:true re-enables and the scheduler enqueues when due", async () => {
    await PATCH(patchReq({ type: "nightly-stringer", enabled: false }), ctx("tmp"));
    const res = await PATCH(patchReq({ type: "nightly-stringer", enabled: true }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).schedule.enabled).toBe(true);

    const row = scheduleRow("nightly-stringer");
    expect(row.enabled).toBe(true);
    expect(row.nextRunAt).not.toBeNull();

    const scheduler = new Scheduler({
      db: tdb.db,
      clock: new FakeClock(row.nextRunAt!.getTime() + 60_000),
    });
    await scheduler.tickOnce();
    expect(jobs().filter((j) => j.type === "nightly-stringer")).toHaveLength(1);
  });

  it("PATCH creates a missing row explicitly instead of silently no-oping", async () => {
    await tdb.db.delete(schema.schedules).where(eq(schema.schedules.type, "review-fix"));
    expect(scheduleRow("review-fix")).toBeUndefined();

    const res = await PATCH(patchReq({ type: "review-fix", enabled: true }), ctx("tmp"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(body.schedule.enabled).toBe(true);
    expect(body.schedule.cron).toBe("*/15 * * * *");
    expect(scheduleRow("review-fix").enabled).toBe(true);
  });

  it("PATCH creates a missing row disabled when toggled off", async () => {
    await tdb.db.delete(schema.schedules).where(eq(schema.schedules.type, "review-fix"));

    const res = await PATCH(patchReq({ type: "review-fix", enabled: false }), ctx("tmp"));
    expect(res.status).toBe(200);
    expect((await res.json()).created).toBe(true);
    const row = scheduleRow("review-fix");
    expect(row.enabled).toBe(false);
    expect(row.nextRunAt).toBeNull();
  });

  it("PATCH with an unknown type 400s", async () => {
    const res = await PATCH(patchReq({ type: "execute-epic", enabled: false }), ctx("tmp"));
    expect(res.status).toBe(400);
  });

  it("PATCH with a non-boolean enabled 400s", async () => {
    const res = await PATCH(patchReq({ type: "review-fix", enabled: "no" }), ctx("tmp"));
    expect(res.status).toBe(400);
  });

  it("PATCH 404s for an unknown project", async () => {
    const res = await PATCH(patchReq({ type: "review-fix", enabled: false }), ctx("nope"));
    expect(res.status).toBe(404);
  });
});
