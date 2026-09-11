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
  BUDGET_DEFER_PREFIX,
  BUDGET_DEFER_PRIOR_SEP,
  deferQueuedJobs,
  enqueueExecuteEpicDeduped,
  enqueueExecuteEpicIfAbsent,
  enqueueReviewFixPrIfAbsent,
  enqueueScheduledTypeIfAbsent,
  getJob,
  resumeBudgetDeferredJobs,
  resumeJob,
  systemClock,
  toMs,
} from "./queue";
import { insertProject } from "@/lib/testing/project";

let t: TestDb;
beforeEach(() => {
  t = makeTestDb();
  // Seed project rows so the jobs.project_id FK is satisfied.
  for (const id of ["p1", "p2"]) {
    insertProject(t.db, { id, slug: id, name: id, repoPath: `/tmp/${id}` });
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

describe("deferQueuedJobs touches only due rows (PR #248 review)", () => {
  const BACKOFF = "usage-limit: resumes at 2026-01-01T00:00:00.000Z";
  const marker = `${BUDGET_DEFER_PREFIX}weekly-cap — resumes at …`;

  it("leaves a backed-off row alone until its backoff elapses, then defers it", async () => {
    // A row mid retry/usage-limit backoff cannot start before its runAt whatever the governor says,
    // and the marker reads as DEMAND to the quota split — so stamping it now would keep an idle
    // project in the divisor for a backoff it could never spend through.
    const clock = { now: () => systemClock.now() };
    const id = enqueueExecuteEpicDeduped(t.db, clock, "p1", "epic-1");
    const backoffAt = Math.floor((clock.now() + 60 * 60_000) / 1000) * 1000;
    t.db
      .update(schema.jobs)
      .set({ runAt: new Date(backoffAt), lastError: BACKOFF })
      .where(eq(schema.jobs.id, id))
      .run();

    const untouched = await deferQueuedJobs(t.db, clock, {
      types: ["execute-epic"],
      projectId: "p1",
      retryAtMs: clock.now() + 6 * 24 * 60 * 60_000,
      lastError: marker,
    });
    expect(untouched).toBe(0);
    const backedOff = await getJob(t.db, id);
    expect(toMs(backedOff?.runAt)).toBe(backoffAt);
    expect(backedOff?.lastError).toBe(BACKOFF);

    const later = { now: () => backoffAt };
    const retryAtMs = later.now() + 6 * 24 * 60 * 60_000;
    const deferred = await deferQueuedJobs(t.db, later, {
      types: ["execute-epic"],
      projectId: "p1",
      retryAtMs,
      lastError: marker,
    });
    expect(deferred).toBe(1);
    const held = await getJob(t.db, id);
    expect(toMs(held?.runAt)).toBe(Math.floor(retryAtMs / 1000) * 1000);
    expect(held?.lastError).toBe(`${marker}${BUDGET_DEFER_PRIOR_SEP}${BACKOFF}`);
  });
});

describe("deferQueuedJobs preserves prior-attempt evidence", () => {
  const REFUNDED = "usage-limit: resumes at 2026-01-01T00:00:00.000Z";
  const marker = (reason: string) => `${BUDGET_DEFER_PREFIX}${reason} — resumes at …`;

  async function lastErrorOf(id: string) {
    return (await getJob(t.db, id))?.lastError ?? null;
  }

  function setLastError(id: string, lastError: string) {
    t.db.update(schema.jobs).set({ lastError }).where(eq(schema.jobs.id, id)).run();
  }

  it("carries a refunded attempt's error alongside the marker instead of overwriting it", async () => {
    const id = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1");
    setLastError(id, REFUNDED); // a quota refund rewound attempts; this error is its only trace

    await deferQueuedJobs(t.db, systemClock, {
      types: ["execute-epic"],
      projectId: "p1",
      retryAtMs: systemClock.now() + 60 * 60_000,
      lastError: marker("weekly-on-track"),
    });

    const after = await lastErrorOf(id);
    expect(after).toBe(`${marker("weekly-on-track")}${BUDGET_DEFER_PRIOR_SEP}${REFUNDED}`);
  });

  it("does not accumulate markers across repeated deferrals", async () => {
    const id = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1");
    setLastError(id, REFUNDED);

    for (const [i, reason] of ["weekly-on-track", "session-headroom"].entries()) {
      await deferQueuedJobs(t.db, systemClock, {
        types: ["execute-epic"],
        projectId: "p1",
        retryAtMs: systemClock.now() + (i + 1) * 60 * 60_000,
        lastError: marker(reason),
      });
    }

    expect(await lastErrorOf(id)).toBe(
      `${marker("session-headroom")}${BUDGET_DEFER_PRIOR_SEP}${REFUNDED}`,
    );
  });

  it("leaves a never-run row carrying the bare marker", async () => {
    const id = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1");
    await deferQueuedJobs(t.db, systemClock, {
      types: ["execute-epic"],
      projectId: "p1",
      retryAtMs: systemClock.now() + 60 * 60_000,
      lastError: marker("weekly-on-track"),
    });
    expect(await lastErrorOf(id)).toBe(marker("weekly-on-track"));
  });

  it("restores the carried error when the deferral is undone, and clears a bare marker", async () => {
    const carried = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1");
    const bare = enqueueExecuteEpicDeduped(t.db, systemClock, "p2", "epic-2");
    setLastError(carried, REFUNDED);
    for (const projectId of ["p1", "p2"]) {
      await deferQueuedJobs(t.db, systemClock, {
        types: ["execute-epic"],
        projectId,
        retryAtMs: systemClock.now() + 60 * 60_000,
        lastError: marker("weekly-on-track"),
      });
      await resumeBudgetDeferredJobs(t.db, systemClock, {
        types: ["execute-epic"],
        projectId,
      });
    }

    expect(await lastErrorOf(carried)).toBe(REFUNDED);
    expect(await lastErrorOf(bare)).toBeNull();
    expect(toMs((await getJob(t.db, carried))?.runAt)).toBeLessThanOrEqual(systemClock.now());
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

  it("promotes a covering queued paced job when taking over with bypassBudget (run-now intent)", async () => {
    // Operator A queued the epic for optimal usage; the governor deferred it to the pace boundary.
    const paced = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1");
    const future = new Date(systemClock.now() + 60 * 60_000);
    t.db
      .update(schema.jobs)
      .set({ runAt: future, lastError: "budget: weekly-on-track — resumes at …" })
      .where(eq(schema.jobs.id, paced))
      .run();

    // Operator B takes it over with "Approve & run" (immediate → bypassBudget). No new job, but the
    // covering row must be promoted — flag set, due now — or the "run now" intent is silently dropped.
    expect(
      enqueueExecuteEpicIfAbsent(t.db, systemClock, "p1", "epic-1", { bypassBudget: true }),
    ).toBeUndefined();
    const job = await getJob(t.db, paced);
    expect((JSON.parse(job!.payloadJson) as Record<string, unknown>).bypassBudget).toBe(true);
    expect(toMs(job!.runAt)).toBeLessThanOrEqual(systemClock.now());
    expect(job!.lastError).toBeNull();
  });

  it.each(["running", "parked", "failed"] as const)(
    "does not promote a covering %s job on a bypassBudget take-over",
    async (status) => {
      const prior = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1");
      const before = await getJob(t.db, prior);
      t.db.update(schema.jobs).set({ status }).where(eq(schema.jobs.id, prior)).run();

      expect(
        enqueueExecuteEpicIfAbsent(t.db, systemClock, "p1", "epic-1", { bypassBudget: true }),
      ).toBeUndefined();
      const after = await getJob(t.db, prior);
      // Non-queued covering rows are left for their own lifecycle (running settles; parked resumes).
      expect(after!.payloadJson).toBe(before!.payloadJson);
      expect(toMs(after!.runAt)).toBe(toMs(before!.runAt));
    },
  );

  it("leaves a covering queued paced job untouched on a paced (non-bypass) take-over", async () => {
    const paced = enqueueExecuteEpicDeduped(t.db, systemClock, "p1", "epic-1");
    const before = await getJob(t.db, paced);

    expect(enqueueExecuteEpicIfAbsent(t.db, systemClock, "p1", "epic-1")).toBeUndefined();
    const after = await getJob(t.db, paced);
    expect(after!.payloadJson).toBe(before!.payloadJson);
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

/**
 * anton-f01t / anton-k0kj: the per-PR fix job. Both writers re-derive their list from the board on
 * every pass — the scheduled dispatcher and gate-check's merge dispatch — so overlapping passes must
 * converge on one job, and a SETTLED job must not hold a target back, or a finalize that failed once
 * would never be retried.
 */
describe("enqueueReviewFixPrIfAbsent", () => {
  it("enqueues one review-fix-pr job for the target and dedupes the next pass onto it", () => {
    const a = enqueueReviewFixPrIfAbsent(t.db, systemClock, "p1", "epic-1");
    expect(a).toBeDefined();
    expect(enqueueReviewFixPrIfAbsent(t.db, systemClock, "p1", "epic-1")).toBeUndefined();
    expect(activeRows()).toHaveLength(1);
    expect(activeRows()[0].type).toBe("review-fix-pr");
    expect(JSON.parse(activeRows()[0].payloadJson)).toEqual({
      projectId: "p1",
      epicBeadId: "epic-1",
    });
  });

  it("dedupes against a running job too", () => {
    const a = enqueueReviewFixPrIfAbsent(t.db, systemClock, "p1", "epic-1")!;
    t.db.update(schema.jobs).set({ status: "running" }).where(eq(schema.jobs.id, a)).run();
    expect(enqueueReviewFixPrIfAbsent(t.db, systemClock, "p1", "epic-1")).toBeUndefined();
    expect(activeRows()).toHaveLength(1);
  });

  it("re-dispatches after a settled attempt — a failed finalize must be retryable", () => {
    for (const status of ["done", "failed", "parked"] as const) {
      const id = enqueueReviewFixPrIfAbsent(t.db, systemClock, "p1", `epic-${status}`)!;
      t.db.update(schema.jobs).set({ status }).where(eq(schema.jobs.id, id)).run();
      expect(enqueueReviewFixPrIfAbsent(t.db, systemClock, "p1", `epic-${status}`)).toBeDefined();
    }
  });

  // The dispatcher only triages; treating its in-flight poll as coverage would strand this target
  // until the next slot (and it may have skipped the target on ownership in the first place).
  // The runner's teardown barrier is crossed inside the insert's own transaction (PR #250 review):
  // a dispatcher that read the barrier before its `gh` triage would still insert behind
  // quiesceProject's sweep, and teardown's leftover guard then fails the delete over that row.
  it("inserts nothing when refuseProject vetoes the project, and reports it as not dispatched", () => {
    const refused = enqueueReviewFixPrIfAbsent(t.db, systemClock, "p1", "epic-1", {
      refuseProject: (projectId) => projectId === "p1",
    });
    expect(refused).toBeUndefined();
    expect(activeRows()).toHaveLength(0);

    // The veto is per project: another project's dispatch goes through the same call unrefused.
    expect(
      enqueueReviewFixPrIfAbsent(t.db, systemClock, "p2", "epic-1", {
        refuseProject: (projectId) => projectId === "p1",
      }),
    ).toBeDefined();
  });

  it("does not treat the review-fix dispatcher as covering a target", () => {
    t.db
      .insert(schema.jobs)
      .values({
        id: "dispatcher",
        type: "review-fix",
        projectId: "p1",
        payloadJson: JSON.stringify({ projectId: "p1" }),
        status: "queued",
        runAt: new Date(),
        attempts: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    expect(enqueueReviewFixPrIfAbsent(t.db, systemClock, "p1", "epic-1")).toBeDefined();
  });

  it("keeps targets and projects independent — a fix on one PR never covers another", () => {
    const a = enqueueReviewFixPrIfAbsent(t.db, systemClock, "p1", "epic-1");
    const b = enqueueReviewFixPrIfAbsent(t.db, systemClock, "p1", "epic-2");
    const c = enqueueReviewFixPrIfAbsent(t.db, systemClock, "p2", "epic-1");
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

/**
 * PR #264 review: the board-change nudge (picker-nudge.ts) checked `queuedJobId` before calling its
 * injected `enqueue`, but that check and the insert were two separate operations with an await
 * between them — a scheduler tick or a manual "Run now" fire landing in that window was invisible to
 * it and could double-fire the pass. `enqueueScheduledTypeIfAbsent` closes that window with one
 * synchronous transaction, the same pattern `enqueueReviewFixPrIfAbsent` already uses.
 */
describe("enqueueScheduledTypeIfAbsent", () => {
  it("returns the existing job id and inserts no new row when one is already active", () => {
    const a = enqueueScheduledTypeIfAbsent(t.db, systemClock, "nightly-stringer", "p1", {});
    const b = enqueueScheduledTypeIfAbsent(t.db, systemClock, "nightly-stringer", "p1", {});
    expect(b).toBe(a);
    expect(t.db.select().from(schema.jobs).all()).toHaveLength(1);
  });

  it("dedupes against a running job, not just a queued one, under the default coveredBy", () => {
    const a = enqueueScheduledTypeIfAbsent(t.db, systemClock, "board-picker", "p1", {});
    t.db.update(schema.jobs).set({ status: "running" }).where(eq(schema.jobs.id, a)).run();
    const b = enqueueScheduledTypeIfAbsent(t.db, systemClock, "board-picker", "p1", {});
    expect(b).toBe(a);
    expect(t.db.select().from(schema.jobs).all()).toHaveLength(1);
  });

  it("coveredBy: ['queued'] does NOT treat a running job as covering — the nudge's own semantics", () => {
    const a = enqueueScheduledTypeIfAbsent(t.db, systemClock, "board-picker", "p1", {});
    t.db.update(schema.jobs).set({ status: "running" }).where(eq(schema.jobs.id, a)).run();
    const b = enqueueScheduledTypeIfAbsent(t.db, systemClock, "board-picker", "p1", {}, {
      coveredBy: ["queued"],
    });
    expect(b).not.toBe(a);
    expect(t.db.select().from(schema.jobs).all()).toHaveLength(2);
  });

  it("keeps types and projects independent", () => {
    const a = enqueueScheduledTypeIfAbsent(t.db, systemClock, "nightly-stringer", "p1", {});
    const b = enqueueScheduledTypeIfAbsent(t.db, systemClock, "orphan-grooming", "p1", {});
    const c = enqueueScheduledTypeIfAbsent(t.db, systemClock, "nightly-stringer", "p2", {});
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("refuses a project mid-teardown", () => {
    expect(() =>
      enqueueScheduledTypeIfAbsent(t.db, systemClock, "board-picker", "p1", {}, {
        refuseProject: (projectId) => projectId === "p1",
      }),
    ).toThrow(/being deleted/);
    expect(t.db.select().from(schema.jobs).all()).toHaveLength(0);
  });
});
