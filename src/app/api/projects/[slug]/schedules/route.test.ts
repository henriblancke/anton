/**
 * Schedules route tests against a real in-memory anton.db: GET returns the project's real
 * schedule rows; PATCH edits cron and/or enabled (recomputing nextRunAt so the scheduler loop
 * actually starts/stops enqueuing, on the new cadence, without a restart); a missing row is
 * created explicitly (created: true) at the submitted cron, not silently no-oped; an invalid cron
 * 400s leaving the row untouched, and an unknown project 404s.
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
  /** Advance a live scheduler's clock so one instance can span several ticks. */
  set(t: number) {
    this.t = t;
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
    expect(schedules).toHaveLength(7);
    const types = schedules.map((s: { type: string }) => s.type).sort();
    expect(types).toEqual([
      "gardener",
      "gate-check",
      "nightly-stringer",
      "orphan-grooming",
      "review-fix",
      "run-health",
      "unstick",
    ]);
    // Enabled state comes straight off the seeded row: run-health is the opt-in one (anton-4ks0).
    // unstick (anton-wvcy) is armed by default but no-ops until run-health has written a report, so
    // turning the sweep on is the single switch that arms the whole detect → act loop.
    const enabledByType = Object.fromEntries(
      schedules.map((s: { type: string; enabled: boolean }) => [s.type, s.enabled]),
    );
    expect(enabledByType).toEqual({
      "nightly-stringer": true,
      "orphan-grooming": true,
      "review-fix": true,
      "run-health": false,
      unstick: true,
      // gate-check (anton-286r) is armed by default: nothing else resumes a run parked on a gate.
      "gate-check": true,
      // gardener (anton-3nv7) is the other opt-in: it is the only recurring job that writes to the
      // board unprompted, so an operator arms it deliberately.
      gardener: false,
    });
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

  it("PATCH cron persists the new cadence and advances nextRunAt", async () => {
    const before = scheduleRow("nightly-stringer");

    const res = await PATCH(patchReq({ type: "nightly-stringer", cron: "*/30 * * * *" }), ctx("tmp"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.schedule.cron).toBe("*/30 * * * *");
    expect(body.schedule.enabled).toBe(true);
    // The response carries the recomputed fire time, so the client renders it instead of guessing.
    expect(body.schedule.nextRunAt).toBeGreaterThan(0);

    const row = scheduleRow("nightly-stringer");
    expect(row.cron).toBe("*/30 * * * *");
    expect(row.nextRunAt!.getTime()).not.toBe(before.nextRunAt!.getTime());
    expect(body.schedule.nextRunAt).toBe(Math.floor(row.nextRunAt!.getTime() / 1000));
  });

  it("PATCH cron + enabled applies both in one patch", async () => {
    await PATCH(patchReq({ type: "nightly-stringer", enabled: false }), ctx("tmp"));

    const res = await PATCH(
      patchReq({ type: "nightly-stringer", cron: "5 4 * * *", enabled: true }),
      ctx("tmp"),
    );
    expect(res.status).toBe(200);
    const { schedule } = await res.json();
    expect(schedule.cron).toBe("5 4 * * *");
    expect(schedule.enabled).toBe(true);

    const row = scheduleRow("nightly-stringer");
    expect(row.cron).toBe("5 4 * * *");
    expect(row.nextRunAt).not.toBeNull();
  });

  it("PATCH with an invalid cron 400s and leaves the row untouched", async () => {
    const before = scheduleRow("nightly-stringer");

    const res = await PATCH(patchReq({ type: "nightly-stringer", cron: "99 * * * *" }), ctx("tmp"));
    expect(res.status).toBe(400);
    // The message names the problem rather than just "invalid".
    expect((await res.json()).error).toMatch(/99/);

    const after = scheduleRow("nightly-stringer");
    expect(after.cron).toBe(before.cron);
    expect(after.nextRunAt!.getTime()).toBe(before.nextRunAt!.getTime());
    expect(after.enabled).toBe(before.enabled);
  });

  it("PATCH with a non-string cron 400s", async () => {
    const res = await PATCH(patchReq({ type: "nightly-stringer", cron: 15 }), ctx("tmp"));
    expect(res.status).toBe(400);
    expect(scheduleRow("nightly-stringer").cron).toBe("0 3 * * *");
  });

  it("PATCH with neither cron nor enabled 400s", async () => {
    const res = await PATCH(patchReq({ type: "nightly-stringer" }), ctx("tmp"));
    expect(res.status).toBe(400);
  });

  it("PATCH creates a missing row at the SUBMITTED cron, not the default", async () => {
    await tdb.db.delete(schema.schedules).where(eq(schema.schedules.type, "review-fix"));

    const res = await PATCH(patchReq({ type: "review-fix", cron: "*/45 * * * *" }), ctx("tmp"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(body.schedule.cron).toBe("*/45 * * * *");
    expect(scheduleRow("review-fix").cron).toBe("*/45 * * * *");
  });

  it("PATCH creating an opt-in type's row by cron alone leaves it opt-in", async () => {
    await tdb.db.delete(schema.schedules).where(eq(schema.schedules.type, "gardener"));

    const res = await PATCH(patchReq({ type: "gardener", cron: "0 6 * * *" }), ctx("tmp"));
    expect(res.status).toBe(200);
    const row = scheduleRow("gardener");
    expect(row.cron).toBe("0 6 * * *");
    expect(row.enabled).toBe(false);
    expect(row.nextRunAt).toBeNull();
  });

  it("the scheduler enqueues on the new cadence after a cron edit, without a restart", async () => {
    // One instance, constructed BEFORE the edit and never restarted: it re-reads schedules per tick.
    const clock = new FakeClock(0);
    const scheduler = new Scheduler({ db: tdb.db, clock });

    await PATCH(patchReq({ type: "nightly-stringer", cron: "*/5 * * * *" }), ctx("tmp"));
    const row = scheduleRow("nightly-stringer");

    clock.set(row.nextRunAt!.getTime() - 60_000);
    await scheduler.tickOnce();
    expect(jobs().filter((j) => j.type === "nightly-stringer")).toHaveLength(0);

    clock.set(row.nextRunAt!.getTime());
    await scheduler.tickOnce();
    expect(jobs().filter((j) => j.type === "nightly-stringer")).toHaveLength(1);
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
