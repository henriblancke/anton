/**
 * `runScheduleNow` (Settings → Automation's "Run now"): fires a schedule's job immediately, outside
 * its cron, reusing the scheduler's own row shape and `lastRunAt` stamp so a manual fire reads
 * exactly like a cron fire to every downstream reader.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { makeProjectDb } from "@/lib/testing/project";
import { createSchedule, runScheduleNow } from "./schedules";

class FakeClock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
}

describe("runScheduleNow", () => {
  it("enqueues the schedule's job type and stamps lastRunAt", async () => {
    const { db, projectId } = makeProjectDb();
    const clock = new FakeClock(1_000_000);
    const id = await createSchedule(db, clock, {
      projectId,
      type: "nightly-stringer",
      cron: "0 3 * * *",
      enabled: true,
    });

    const result = await runScheduleNow(db, clock, id);
    expect(result).toEqual({ ok: true, jobId: expect.any(String) });

    const job = db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, result.ok ? result.jobId : ""))
      .all()[0];
    expect(job.type).toBe("nightly-stringer");
    expect(job.projectId).toBe(projectId);
    expect(job.status).toBe("queued");
    expect(JSON.parse(job.payloadJson)).toEqual({ projectId, scheduleId: id });

    const row = db.select().from(schema.schedules).where(eq(schema.schedules.id, id)).all()[0];
    expect(row.lastRunAt!.getTime()).toBe(Math.floor(clock.now() / 1000) * 1000);
  });

  it("does not move nextRunAt — a manual fire does not reschedule the cadence", async () => {
    const { db, projectId } = makeProjectDb();
    const clock = new FakeClock(1_000_000);
    const id = await createSchedule(db, clock, {
      projectId,
      type: "nightly-stringer",
      cron: "0 3 * * *",
      enabled: true,
    });
    const before = db.select().from(schema.schedules).where(eq(schema.schedules.id, id)).all()[0];

    await runScheduleNow(db, clock, id);

    const after = db.select().from(schema.schedules).where(eq(schema.schedules.id, id)).all()[0];
    expect(after.nextRunAt!.getTime()).toBe(before.nextRunAt!.getTime());
  });

  it("refuses a disabled automation", async () => {
    const { db, projectId } = makeProjectDb();
    const clock = new FakeClock(1_000_000);
    const id = await createSchedule(db, clock, {
      projectId,
      type: "gardener",
      cron: "0 5 * * *",
      enabled: false,
    });

    const result = await runScheduleNow(db, clock, id);
    expect(result).toEqual({ ok: false, reason: "disabled" });
    expect(db.select().from(schema.jobs).all()).toHaveLength(0);
  });

  it("refuses when a job of this type is already active for the project", async () => {
    const { db, projectId } = makeProjectDb();
    const clock = new FakeClock(1_000_000);
    const id = await createSchedule(db, clock, {
      projectId,
      type: "nightly-stringer",
      cron: "0 3 * * *",
      enabled: true,
    });

    const first = await runScheduleNow(db, clock, id);
    expect(first.ok).toBe(true);

    const second = await runScheduleNow(db, clock, id);
    expect(second).toEqual({ ok: false, reason: "already-running" });
    expect(db.select().from(schema.jobs).all()).toHaveLength(1);
  });

  it("404s (not-found) on an unknown schedule id", async () => {
    const { db } = makeProjectDb();
    const clock = new FakeClock(1_000_000);
    const result = await runScheduleNow(db, clock, "nope");
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("is refused when the caller vetoes the project (teardown race)", async () => {
    const { db, projectId } = makeProjectDb();
    const clock = new FakeClock(1_000_000);
    const id = await createSchedule(db, clock, {
      projectId,
      type: "nightly-stringer",
      cron: "0 3 * * *",
      enabled: true,
    });

    const result = await runScheduleNow(db, clock, id, { refuseProject: () => true });
    expect(result).toEqual({ ok: false, reason: "project-refused" });
    expect(db.select().from(schema.jobs).all()).toHaveLength(0);
  });
});
