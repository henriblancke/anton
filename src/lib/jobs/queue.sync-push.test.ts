/**
 * Dedupe + resume tests for the durable sync-push job (anton-nowq, anton-x7la): the transactional
 * guard (`enqueueSyncPushDeduped`) plus the partial unique index `jobs_active_sync_push_unique` that
 * backs it. A repo's writes all push the same Dolt remote, so a burst collapses onto at most one
 * QUEUED push job — never a queue full of redundant pushes. Dedupe is queued-only, NOT running: a
 * write that lands while a push is in flight schedules exactly one durable follow-up (bounded at
 * 1 running + 1 queued), so its work can't rest solely on a fire-and-forget pass; a settled push
 * never blocks the next write from scheduling its own.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../db/testing";
import * as schema from "../db/schema";
import { enqueueSyncPushDeduped, getJob, reschedule, resumeJob, systemClock } from "./queue";

let t: TestDb;
beforeEach(() => {
  t = makeTestDb();
  for (const id of ["p1", "p2"]) {
    t.db
      .insert(schema.projects)
      .values({ id, slug: id, name: id, repoPath: `/tmp/${id}` })
      .run();
  }
});
afterEach(() => t.close());

function allRows() {
  return t.db.select().from(schema.jobs).all();
}
function activeRows() {
  return allRows().filter((j) => j.status === "queued" || j.status === "running");
}

describe("enqueueSyncPushDeduped", () => {
  it("returns the existing job id and inserts no new row when a queued push job exists", () => {
    const a = enqueueSyncPushDeduped(t.db, systemClock, "p1");
    const b = enqueueSyncPushDeduped(t.db, systemClock, "p1");
    expect(b).toBe(a);
    expect(allRows()).toHaveLength(1);
    expect(allRows()[0]?.type).toBe("sync-push");
    expect(JSON.parse(allRows()[0]!.payloadJson)).toEqual({ projectId: "p1" });
  });

  it("enqueues a durable follow-up against a running job — does NOT dedupe onto it (anton-x7la)", () => {
    // A write that lands while a push is `running` must schedule a fresh queued follow-up: the running
    // job's push may have snapshotted before this write committed, so folding onto it would leave the
    // write's durability resting only on the fire-and-forget trailing pass. Bounded at 1 running + 1
    // queued — a second write while both exist dedupes onto the queued follow-up.
    const a = enqueueSyncPushDeduped(t.db, systemClock, "p1");
    t.db.update(schema.jobs).set({ status: "running" }).where(eq(schema.jobs.id, a)).run();

    const b = enqueueSyncPushDeduped(t.db, systemClock, "p1");
    expect(b).not.toBe(a); // fresh follow-up, not the running job
    expect(allRows()).toHaveLength(2);
    expect(activeRows()).toHaveLength(2); // 1 running + 1 queued

    // A further write while the running + queued pair exists coalesces onto the queued follow-up.
    const c = enqueueSyncPushDeduped(t.db, systemClock, "p1");
    expect(c).toBe(b);
    expect(allRows()).toHaveLength(2);
  });

  it("keeps repos (projects) independent", () => {
    const a = enqueueSyncPushDeduped(t.db, systemClock, "p1");
    const b = enqueueSyncPushDeduped(t.db, systemClock, "p2");
    expect(a).not.toBe(b);
    expect(activeRows()).toHaveLength(2);
  });

  it("schedules a fresh push once the prior one is no longer active", () => {
    for (const status of ["done", "parked", "failed"] as const) {
      const prior = enqueueSyncPushDeduped(t.db, systemClock, "p1");
      t.db.update(schema.jobs).set({ status }).where(eq(schema.jobs.id, prior)).run();
      const fresh = enqueueSyncPushDeduped(t.db, systemClock, "p1");
      expect(fresh).not.toBe(prior);
    }
  });

  it("does not collide with a same-project execute-epic job (different dedupe index)", () => {
    // execute-epic dedupes on (type, project, epicBeadId); sync-push on (project) partial to its
    // type. They must coexist for the same project without either shadowing the other.
    const nowSec = new Date(Math.floor(systemClock.now() / 1000) * 1000);
    t.db
      .insert(schema.jobs)
      .values({
        id: "ee-1",
        type: "execute-epic",
        projectId: "p1",
        payloadJson: JSON.stringify({ projectId: "p1", epicBeadId: "epic-1" }),
        status: "queued",
        runAt: nowSec,
        createdAt: nowSec,
        updatedAt: nowSec,
      })
      .run();
    const sp = enqueueSyncPushDeduped(t.db, systemClock, "p1");
    expect(sp).toBeDefined();
    expect(activeRows()).toHaveLength(2);
  });

  it("serializes concurrent enqueues to exactly one active push job", () => {
    const winner = enqueueSyncPushDeduped(t.db, systemClock, "p1");
    const second = enqueueSyncPushDeduped(t.db, systemClock, "p1");
    expect(second).toBe(winner);
    expect(activeRows()).toHaveLength(1);
  });
});

describe("jobs_active_sync_push_unique (DB backstop)", () => {
  const nowSec = () => new Date(Math.floor(systemClock.now() / 1000) * 1000);
  const rawInsert = (id: string, status: string) =>
    t.db
      .insert(schema.jobs)
      .values({
        id,
        type: "sync-push",
        projectId: "p1",
        payloadJson: JSON.stringify({ projectId: "p1" }),
        status,
        runAt: nowSec(),
        createdAt: nowSec(),
        updatedAt: nowSec(),
      })
      .run();

  it("rejects a second QUEUED sync-push row for the same project", () => {
    enqueueSyncPushDeduped(t.db, systemClock, "p1"); // one queued row
    // Bypass the transactional guard and force a raw duplicate queued insert — the index rejects it.
    expect(() => rawInsert("dup", "queued")).toThrow(/UNIQUE/i);
    expect(activeRows()).toHaveLength(1);
  });

  it("allows a queued follow-up alongside a running job (anton-x7la)", () => {
    // The index is queued-only: a running push + one queued follow-up is the intended bounded state,
    // so the follow-up insert must NOT be rejected. Overlap on the remote is prevented by the
    // per-repo coalescer, not this index.
    const a = enqueueSyncPushDeduped(t.db, systemClock, "p1");
    t.db.update(schema.jobs).set({ status: "running" }).where(eq(schema.jobs.id, a)).run();
    expect(() => rawInsert("followup", "queued")).not.toThrow();
    expect(activeRows()).toHaveLength(2); // 1 running + 1 queued
  });
});

describe("reschedule vs the queued follow-up (anton-x7la)", () => {
  it("discharges a failing running push as done when a queued follow-up already covers the repo", async () => {
    // A is running and about to be rescheduled after a failed push; a write during its run enqueued a
    // queued follow-up B into the project's single queued slot. Requeuing A (running → queued) would
    // collide with B on the queued-only unique index — reschedule must absorb that and discharge A
    // rather than throw on the settle path or leave A a zombie running row.
    const a = enqueueSyncPushDeduped(t.db, systemClock, "p1");
    t.db.update(schema.jobs).set({ status: "running" }).where(eq(schema.jobs.id, a)).run();
    const b = enqueueSyncPushDeduped(t.db, systemClock, "p1"); // queued follow-up
    expect(b).not.toBe(a);

    await expect(
      reschedule(t.db, systemClock, a, systemClock.now() + 2_000, { lastError: "remote down" }),
    ).resolves.toBeUndefined();

    expect((await getJob(t.db, a))?.status).toBe("done"); // superseded, discharged cleanly
    expect((await getJob(t.db, b))?.status).toBe("queued"); // the sole retry carrier, untouched
    expect(activeRows()).toHaveLength(1);
    expect(activeRows()[0]?.id).toBe(b);
  });

  it("still requeues a running push normally when no follow-up is queued", async () => {
    const a = enqueueSyncPushDeduped(t.db, systemClock, "p1");
    t.db.update(schema.jobs).set({ status: "running" }).where(eq(schema.jobs.id, a)).run();

    await reschedule(t.db, systemClock, a, systemClock.now() + 2_000, { lastError: "remote down" });

    const job = await getJob(t.db, a);
    expect(job?.status).toBe("queued"); // back on the retry path
    expect(job?.lastError).toBe("remote down");
  });
});

describe("resume vs the active-sync-push index (anton-nowq)", () => {
  it("re-queues a parked push job with a fresh attempt budget", async () => {
    const parked = enqueueSyncPushDeduped(t.db, systemClock, "p1");
    t.db
      .update(schema.jobs)
      .set({ status: "parked", attempts: 3 })
      .where(eq(schema.jobs.id, parked))
      .run();

    expect(await resumeJob(t.db, systemClock, parked)).toBe(true);
    const job = await getJob(t.db, parked);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(0); // fresh retry budget
  });

  it("no-ops (returns false) when a fresh active push job already covers the repo", async () => {
    // A push parks; the next write's dedupe (which ignores parked) spawns a fresh queued push.
    // Reviving the parked row would be a SECOND active push for the repo — the unique index would
    // reject it, so resume must no-op cleanly rather than surface an error or double-push.
    const parked = enqueueSyncPushDeduped(t.db, systemClock, "p1");
    t.db.update(schema.jobs).set({ status: "parked" }).where(eq(schema.jobs.id, parked)).run();

    const fresh = enqueueSyncPushDeduped(t.db, systemClock, "p1"); // allowed after parked
    expect(fresh).not.toBe(parked);

    expect(await resumeJob(t.db, systemClock, parked)).toBe(false);
    expect((await getJob(t.db, parked))?.status).toBe("parked"); // untouched
    expect(activeRows()).toHaveLength(1);
    expect(activeRows()[0]?.id).toBe(fresh);
  });
});
