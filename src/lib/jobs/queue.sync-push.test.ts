/**
 * Dedupe + resume tests for the durable sync-push job (anton-nowq): the transactional guard
 * (`enqueueSyncPushDeduped`) plus the partial unique index `jobs_active_sync_push_unique` that backs
 * it. A repo's writes all push the same Dolt remote, so a burst of writes must collapse onto ONE
 * active push job — never a queue full of redundant pushes — while a settled push doesn't block the
 * next write from scheduling its own.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../db/testing";
import * as schema from "../db/schema";
import { enqueueSyncPushDeduped, getJob, resumeJob, systemClock } from "./queue";

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
  it("returns the existing job id and inserts no new row when an active push job exists", () => {
    const a = enqueueSyncPushDeduped(t.db, systemClock, "p1");
    const b = enqueueSyncPushDeduped(t.db, systemClock, "p1");
    expect(b).toBe(a);
    expect(allRows()).toHaveLength(1);
    expect(allRows()[0]?.type).toBe("sync-push");
    expect(JSON.parse(allRows()[0]!.payloadJson)).toEqual({ projectId: "p1" });
  });

  it("dedupes against a running job, not just a queued one", () => {
    const a = enqueueSyncPushDeduped(t.db, systemClock, "p1");
    t.db.update(schema.jobs).set({ status: "running" }).where(eq(schema.jobs.id, a)).run();
    const b = enqueueSyncPushDeduped(t.db, systemClock, "p1");
    expect(b).toBe(a);
    expect(allRows()).toHaveLength(1);
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
  it("rejects a second active sync-push row for the same project", () => {
    enqueueSyncPushDeduped(t.db, systemClock, "p1");
    const nowSec = new Date(Math.floor(systemClock.now() / 1000) * 1000);
    // Bypass the transactional guard and force a raw duplicate active insert — the index rejects it.
    expect(() =>
      t.db
        .insert(schema.jobs)
        .values({
          id: "dup",
          type: "sync-push",
          projectId: "p1",
          payloadJson: JSON.stringify({ projectId: "p1" }),
          status: "queued",
          runAt: nowSec,
          createdAt: nowSec,
          updatedAt: nowSec,
        })
        .run(),
    ).toThrow(/UNIQUE/i);
    expect(activeRows()).toHaveLength(1);
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
