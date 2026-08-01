/**
 * Scheduler loop tests (anton-3t2.1) against a real in-memory anton.db: enabled schedules enqueue
 * their job when due and advance lastRun/nextRun; disabled ones never fire; a bad cron doesn't
 * wedge the loop. Uses a fake clock so "due" is deterministic.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../db/testing";
import * as schema from "../db/schema";
import { eq } from "drizzle-orm";
import type { Clock } from "./queue";
import { Scheduler } from "./scheduler";
import {
  backfillDefaultSchedules,
  createSchedule,
  DEFAULT_SCHEDULES,
  ensureSchedule,
  seedDefaultSchedules,
  updateSchedule,
} from "../schedules";

class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
  set(t: number) {
    this.t = t;
  }
}

async function seedProject(tdb: TestDb, id = "p1"): Promise<string> {
  await tdb.db.insert(schema.projects).values({
    id,
    slug: id,
    name: id,
    repoPath: `/tmp/${id}`,
  });
  return id;
}

function jobsFor(tdb: TestDb, projectId: string) {
  return tdb.db.select().from(schema.jobs).where(eq(schema.jobs.projectId, projectId)).all();
}

describe("Scheduler.tickOnce", () => {
  let tdb: TestDb;
  let clock: FakeClock;
  // 2026-07-11 02:59 local, one minute before a 03:00 daily schedule.
  const base = new Date(2026, 6, 11, 2, 59, 0, 0).getTime();

  beforeEach(async () => {
    tdb = makeTestDb();
    clock = new FakeClock(base);
    await seedProject(tdb);
  });

  it("enqueues a due schedule and advances lastRun/nextRun", async () => {
    const id = await createSchedule(tdb.db, clock, {
      projectId: "p1",
      type: "nightly-stringer",
      cron: "0 3 * * *", // daily 03:00
    });
    const sched = new Scheduler({ db: tdb.db, clock });

    // Not due yet at 02:59.
    expect(await sched.tickOnce()).toBe(0);
    expect(jobsFor(tdb, "p1").length).toBe(0);

    // Advance to 03:00 → due.
    clock.set(new Date(2026, 6, 11, 3, 0, 0, 0).getTime());
    expect(await sched.tickOnce()).toBe(1);

    const jobs = jobsFor(tdb, "p1");
    expect(jobs.length).toBe(1);
    expect(jobs[0].type).toBe("nightly-stringer");
    expect(JSON.parse(jobs[0].payloadJson)).toMatchObject({ projectId: "p1", scheduleId: id });

    // lastRun stamped; nextRun advanced to tomorrow 03:00.
    const row = tdb.db.select().from(schema.schedules).where(eq(schema.schedules.id, id)).get()!;
    expect(row.lastRunAt).not.toBeNull();
    const next = row.nextRunAt as Date;
    expect(next.getDate()).toBe(12);
    expect(next.getHours()).toBe(3);
  });

  it("does not double-enqueue on a second tick before the next slot", async () => {
    await createSchedule(tdb.db, clock, {
      projectId: "p1",
      type: "orphan-grooming",
      cron: "0 3 * * *",
    });
    const sched = new Scheduler({ db: tdb.db, clock });

    clock.set(new Date(2026, 6, 11, 3, 0, 0, 0).getTime());
    expect(await sched.tickOnce()).toBe(1);
    // A minute later, still the same day — not due again.
    clock.set(new Date(2026, 6, 11, 3, 1, 0, 0).getTime());
    expect(await sched.tickOnce()).toBe(0);
    expect(jobsFor(tdb, "p1").length).toBe(1);
  });

  it("does not enqueue a due schedule after project teardown raises its barrier", async () => {
    await createSchedule(tdb.db, clock, {
      projectId: "p1",
      type: "nightly-stringer",
      cron: "0 3 * * *",
    });
    const sched = new Scheduler({ db: tdb.db, clock });
    sched.quiesceProject("p1");
    clock.set(new Date(2026, 6, 11, 3, 0, 0, 0).getTime());

    expect(await sched.tickOnce()).toBe(0);
    expect(jobsFor(tdb, "p1")).toHaveLength(0);
  });

  it("coalesces — skips a due slot when a job of the same type+project is already in flight", async () => {
    const id = await createSchedule(tdb.db, clock, {
      projectId: "p1",
      type: "review-fix",
      cron: "*/5 * * * *",
    });
    // Simulate a still-running review-fix job for this project.
    await tdb.db.insert(schema.jobs).values({
      id: "inflight-1",
      type: "review-fix",
      projectId: "p1",
      status: "running",
      payloadJson: "{}",
    });
    const sched = new Scheduler({ db: tdb.db, clock });

    clock.set(base + 5 * 60_000);
    // Due, but overlapped → no new job enqueued.
    expect(await sched.tickOnce()).toBe(0);
    expect(jobsFor(tdb, "p1").filter((j) => j.type === "review-fix").length).toBe(1);
    // nextRunAt still advanced so we don't busy-check the same slot forever.
    const row = tdb.db.select().from(schema.schedules).where(eq(schema.schedules.id, id)).get()!;
    expect((row.nextRunAt as Date).getTime()).toBeGreaterThan(clock.now());

    // Once the in-flight job is done, the next due slot enqueues normally.
    await tdb.db.update(schema.jobs).set({ status: "done" }).where(eq(schema.jobs.id, "inflight-1"));
    clock.set(base + 60 * 60_000);
    expect(await sched.tickOnce()).toBe(1);
  });

  it("skips disabled schedules", async () => {
    const id = await createSchedule(tdb.db, clock, {
      projectId: "p1",
      type: "review-fix",
      cron: "* * * * *", // every minute
      enabled: false,
    });
    const sched = new Scheduler({ db: tdb.db, clock });
    clock.set(base + 5 * 60_000);
    expect(await sched.tickOnce()).toBe(0);
    expect(jobsFor(tdb, "p1").length).toBe(0);

    // Enabling seeds nextRunAt so it starts firing.
    await updateSchedule(tdb.db, clock, id, { enabled: true });
    clock.set(clock.now() + 2 * 60_000);
    expect(await sched.tickOnce()).toBe(1);
  });

  it("collapses missed slots — one enqueue after a long sleep, not one per slot", async () => {
    await createSchedule(tdb.db, clock, {
      projectId: "p1",
      type: "review-fix",
      cron: "*/5 * * * *", // every 5 min
    });
    const sched = new Scheduler({ db: tdb.db, clock });
    // Sleep for an hour, then tick once.
    clock.set(base + 60 * 60_000);
    expect(await sched.tickOnce()).toBe(1);
    expect(jobsFor(tdb, "p1").length).toBe(1);
  });

  it("seedDefaultSchedules seeds one per default type and is idempotent", async () => {
    await seedDefaultSchedules(tdb.db, clock, "p1");
    await seedDefaultSchedules(tdb.db, clock, "p1"); // second call must not duplicate
    const rows = tdb.db.select().from(schema.schedules).all();
    expect(rows.length).toBe(DEFAULT_SCHEDULES.length);
    expect(new Set(rows.map((r) => r.type))).toEqual(new Set(DEFAULT_SCHEDULES.map((d) => d.type)));
    // A seeded schedule is armed (nextRunAt computed) iff the default says it starts enabled — an
    // opt-in default like run-health seeds the ROW but never fires until the operator turns it on.
    for (const d of DEFAULT_SCHEDULES) {
      const row = rows.find((r) => r.type === d.type)!;
      const enabled = d.enabled ?? true;
      expect(row.enabled).toBe(enabled);
      expect(row.nextRunAt != null).toBe(enabled);
    }
  });

  it("seeds once when two boots race the backfill — the read and the inserts are one transaction", async () => {
    // `startRunner()` backfills before its process-wide re-entry guard, so a dev hot-reload (or any
    // second call) can enter this concurrently. There is no unique key on (projectId, type), so a
    // read that yielded before its inserts would let both callers seed the same types and the
    // scheduler would enqueue every duplicated slot twice.
    await Promise.all([
      backfillDefaultSchedules(tdb.db, clock),
      backfillDefaultSchedules(tdb.db, clock),
    ]);

    const rows = tdb.db.select().from(schema.schedules).all();
    expect(rows.length).toBe(DEFAULT_SCHEDULES.length);
  });

  it("backfillDefaultSchedules gives an EXISTING project a newly-shipped schedule type", async () => {
    // The upgrade path: seeding runs only while inserting a project and no migration adds schedule
    // rows, so without this an installed project never gets a new automation — enabling run-health
    // would leave unstick unscheduled and its reports would pile up with nothing acting on them.
    await seedProject(tdb, "p2");
    await createSchedule(tdb.db, clock, {
      projectId: "p1",
      type: "review-fix",
      cron: "*/15 * * * *",
      enabled: false, // an operator turned this one off
    });

    const backfills = await backfillDefaultSchedules(tdb.db, clock);

    expect(backfills.map((b) => b.projectId).sort()).toEqual(["p1", "p2"]);
    expect(backfills.find((b) => b.projectId === "p1")!.created).not.toContain("review-fix");
    for (const projectId of ["p1", "p2"]) {
      const rows = tdb.db
        .select()
        .from(schema.schedules)
        .where(eq(schema.schedules.projectId, projectId))
        .all();
      expect(new Set(rows.map((r) => r.type))).toEqual(
        new Set(DEFAULT_SCHEDULES.map((d) => d.type)),
      );
    }
    // The operator's own choice survives the backfill — it only ever inserts MISSING types.
    const reviewFix = tdb.db
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.projectId, "p1"))
      .all()
      .find((r) => r.type === "review-fix")!;
    expect(reviewFix.enabled).toBe(false);

    // Second run adds nothing: a boot-time backfill runs on every start.
    expect(await backfillDefaultSchedules(tdb.db, clock)).toEqual([]);
  });

  it("ensureSchedule is idempotent per (project,type)", async () => {
    const a = await ensureSchedule(tdb.db, clock, {
      projectId: "p1",
      type: "nightly-stringer",
      cron: "0 3 * * *",
    });
    const b = await ensureSchedule(tdb.db, clock, {
      projectId: "p1",
      type: "nightly-stringer",
      cron: "0 4 * * *",
    });
    expect(a).toBe(b);
    const rows = tdb.db.select().from(schema.schedules).all();
    expect(rows.length).toBe(1);
  });
});
