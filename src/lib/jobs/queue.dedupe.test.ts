/**
 * Dedupe tests for execute-epic enqueue (anton-761): the transactional guard
 * (`enqueueExecuteEpicDeduped`) plus the partial unique index `jobs_active_epic_unique` that backs
 * it at the DB level. A double approval or retrigger must not spawn duplicate concurrent runs of
 * the same epic.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../db/testing";
import * as schema from "../db/schema";
import {
  deferQueuedJobs,
  enqueueExecuteEpicDeduped,
  enqueueExecuteEpicIfAbsent,
  getJob,
  resumeJob,
  systemClock,
  toMs,
} from "./queue";

let t: TestDb;
beforeEach(() => {
  t = makeTestDb();
  // Seed project rows so the jobs.project_id FK is satisfied.
  for (const id of ["p1", "p2"]) {
    t.db
      .insert(schema.projects)
      .values({ id, slug: id, name: id, repoPath: `/tmp/${id}` })
      .run();
  }
});
afterEach(() => t.close());

function activeRows() {
  return t.db.select().from(schema.jobs).all();
}

describe("enqueueExecuteEpicDeduped", () => {
  it("returns the existing job id and inserts no new row when an active job exists", () => {
    const a = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1");
    const b = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1");
    expect(b).toBe(a);
    expect(activeRows()).toHaveLength(1);
  });

  it("dedupes against a running job, not just a queued one", () => {
    const a = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1");
    t.db.update(schema.jobs).set({ status: "running" }).where(eq(schema.jobs.id, a)).run();
    const b = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1");
    expect(b).toBe(a);
    expect(activeRows()).toHaveLength(1);
  });

  it("keeps epics and projects independent", () => {
    const a = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1");
    const b = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-2"); // other epic
    const c = enqueueExecuteEpicDeduped(t.db, systemClock, "p2", "epic-1"); // other project
    expect(new Set([a, b, c]).size).toBe(3);
    expect(activeRows()).toHaveLength(3);
  });

  it("creates a fresh job once the prior run is no longer active", () => {
    for (const status of ["done", "parked", "failed"] as const) {
      const prior = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-x");
      t.db.update(schema.jobs).set({ status }).where(eq(schema.jobs.id, prior)).run();
      const fresh = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-x");
      expect(fresh).not.toBe(prior);
    }
  });

  it("leaves non-epic job types unaffected (NULL epicBeadId never collides)", () => {
    // Two review-fix jobs for the same project: no epicBeadId in payload → distinct under the index.
    const nowSec = new Date(Math.floor(systemClock.now() / 1000) * 1000);
    const insertReviewFix = (id: string) =>
      t.db
        .insert(schema.jobs)
        .values({
          id,
          type: "review-fix",
          projectId: "p1",
          payloadJson: JSON.stringify({ prNumber: 7 }),
          status: "queued",
          runAt: nowSec,
          createdAt: nowSec,
          updatedAt: nowSec,
        })
        .run();
    expect(() => {
      insertReviewFix("rf-1");
      insertReviewFix("rf-2");
    }).not.toThrow();
    expect(activeRows()).toHaveLength(2);
  });
});

describe("bypassBudget payload flag (run-directly, anton-d8i4)", () => {
  function jobPayload(id: string): Record<string, unknown> {
    const row = t.db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).get();
    return JSON.parse(row?.payloadJson ?? "{}") as Record<string, unknown>;
  }

  it("omits the flag by default (paced) and sets it only when immediate", () => {
    const paced = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-paced");
    const now = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-now", { bypassBudget: true });
    expect(jobPayload(paced).bypassBudget).toBeUndefined();
    expect(jobPayload(now).bypassBudget).toBe(true);
  });

  it("promotes an already-queued paced job to immediate: sets the flag, pulls it due now, clears the budget defer", () => {
    const id = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1");
    // Simulate the governor having deferred it: pushed runAt out with a budget lastError.
    const future = new Date(systemClock.now() + 60 * 60_000);
    t.db
      .update(schema.jobs)
      .set({ runAt: future, lastError: "budget: weekly-on-track — resumes at …" })
      .where(eq(schema.jobs.id, id))
      .run();

    const again = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1", { bypassBudget: true });
    expect(again).toBe(id); // same job, promoted in place
    const job = t.db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).get();
    expect((JSON.parse(job!.payloadJson) as Record<string, unknown>).bypassBudget).toBe(true);
    expect(toMs(job!.runAt)).toBeLessThanOrEqual(systemClock.now()); // due now, no longer deferred
    expect(job!.lastError).toBeNull();
  });

  it("does not promote a paced re-approve (leaves the existing job untouched)", () => {
    const id = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1", { bypassBudget: true });
    const before = t.db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).get();
    const again = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1"); // paced re-approve
    expect(again).toBe(id);
    const after = t.db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).get();
    // A paced re-approve must not strip a prior immediate flag nor rewrite runAt.
    expect(after!.payloadJson).toBe(before!.payloadJson);
  });
});

describe("deferQueuedJobs bypass filter (anton-d8i4)", () => {
  async function deferMs(id: string) {
    return toMs((await getJob(t.db, id))?.runAt);
  }
  const RETRY = () => systemClock.now() + 2 * 60 * 60_000;

  it("bypass:'exclude' defers only paced rows; bypass:'only' defers only immediate rows", async () => {
    const paced = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-paced");
    const now = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-now", { bypassBudget: true });
    const retry = RETRY();

    const excluded = await deferQueuedJobs(t.db, systemClock, {
      types: ["execute-epic"],
      projectId: "p1",
      retryAtMs: retry,
      bypass: "exclude",
    });
    expect(excluded).toBe(1); // only the paced row moved
    expect(await deferMs(paced)).toBe(Math.floor(retry / 1000) * 1000);
    expect(await deferMs(now)).toBeLessThanOrEqual(systemClock.now()); // immediate row untouched

    const onlyImmediate = await deferQueuedJobs(t.db, systemClock, {
      types: ["execute-epic"],
      projectId: "p1",
      retryAtMs: retry,
      bypass: "only",
    });
    expect(onlyImmediate).toBe(1); // now the immediate row moves
    expect(await deferMs(now)).toBe(Math.floor(retry / 1000) * 1000);
  });
});

describe("enqueueExecuteEpicIfAbsent (take-over path, anton-i71)", () => {
  it.each(["queued", "running", "parked", "failed"] as const)(
    "reuses a %s prior job (covering) and enqueues nothing new",
    (status) => {
      const prior = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1");
      t.db.update(schema.jobs).set({ status }).where(eq(schema.jobs.id, prior)).run();

      expect(enqueueExecuteEpicIfAbsent(t.db, systemClock, "p1", "epic-1")).toBeUndefined();
      expect(activeRows()).toHaveLength(1);
    },
  );

  it("enqueues a fresh job when only a `done` prior run exists (not resumable)", async () => {
    // A machine that previously COMPLETED this epic holds a terminal `done` row. `done` is not
    // resumable, so a re-approved/stolen backlog target must still get a runnable job here — else
    // the take-over strands with nothing to run.
    const prior = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1");
    t.db.update(schema.jobs).set({ status: "done" }).where(eq(schema.jobs.id, prior)).run();

    const fresh = enqueueExecuteEpicIfAbsent(t.db, systemClock, "p1", "epic-1");
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(prior);
    expect((await getJob(t.db, fresh!))?.status).toBe("queued");
  });

  it("enqueues a runnable job when the instance holds no prior job at all", () => {
    const id = enqueueExecuteEpicIfAbsent(t.db, systemClock, "p1", "epic-solo");
    expect(id).toBeDefined();
    expect(activeRows()).toHaveLength(1);
  });
});

describe("jobs_active_epic_unique (DB backstop)", () => {
  it("rejects a second active row for the same (type, project, epicBeadId)", () => {
    enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1");
    const nowSec = new Date(Math.floor(systemClock.now() / 1000) * 1000);
    // Bypass the guard and force a raw duplicate active insert — the index must reject it.
    expect(() =>
      t.db
        .insert(schema.jobs)
        .values({
          id: "dup",
          type: "execute-epic",
          projectId: "p1",
          payloadJson: JSON.stringify({ projectId: "p1", epicBeadId: "epic-1" }),
          status: "queued",
          runAt: nowSec,
          createdAt: nowSec,
          updatedAt: nowSec,
        })
        .run(),
    ).toThrow(/UNIQUE/i);
    expect(activeRows()).toHaveLength(1);
  });

  it("serializes concurrent enqueues to exactly one active job", () => {
    // better-sqlite3 is a single synchronous connection, so the guard's transaction (select-existing
    // + insert) can't interleave — two approvals racing to enqueue the same epic yield one active
    // job, the second returning the first's id. The unique index (tested above) backstops any path
    // that would still attempt a duplicate insert.
    const winner = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-race");
    const second = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-race");
    expect(second).toBe(winner);
    expect(activeRows()).toHaveLength(1);
  });
});

describe("resumeJob vs the active-epic index (anton-ner)", () => {
  it("no-ops (returns false) when a fresh active job already covers the epic", async () => {
    // A job parks; the dedupe path (which ignores parked/failed) then spawns a fresh queued job for
    // the same project + epic. Reviving the parked row would be a *second* active job for that epic
    // and trip `jobs_active_epic_unique` — so resume must no-op cleanly rather than surface a 500.
    const parked = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1");
    t.db.update(schema.jobs).set({ status: "parked" }).where(eq(schema.jobs.id, parked)).run();

    const fresh = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1"); // allowed after parked
    expect(fresh).not.toBe(parked);

    expect(await resumeJob(t.db, systemClock, parked)).toBe(false);
    // The parked row is untouched; the fresh job stays the single active one for the epic.
    expect((await getJob(t.db, parked))?.status).toBe("parked");
    const active = activeRows().filter(
      (j) => j.status === "queued" || j.status === "running",
    );
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(fresh);
  });

  it("still un-parks an execute-epic job when no active duplicate exists", async () => {
    // The guard is scoped to a genuine duplicate — with no active job for the epic, resume works.
    const parked = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-solo");
    t.db.update(schema.jobs).set({ status: "parked" }).where(eq(schema.jobs.id, parked)).run();

    expect(await resumeJob(t.db, systemClock, parked)).toBe(true);
    const job = await getJob(t.db, parked);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(0);
  });
});
