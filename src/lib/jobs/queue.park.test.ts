/**
 * `park` semantics (anton-0oi). Park pauses an ACTIVE job for a human and reports whether it
 * actually did so. The regression this locks down: park used to match only `status = 'running'`, so
 * parking a job that had been requeued for a retry silently did nothing and returned `void` — the
 * caller could not tell, and a later `resumeJob` refused the job because it was still `queued`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../db/testing";
import * as schema from "../db/schema";
import { cancelJob, getJob, park, resumeJob, systemClock } from "./queue";

let t: TestDb;
beforeEach(() => {
  t = makeTestDb();
});
afterEach(() => t.close());

function seed(id: string, status: string, opts: { leaseExpiresAt?: Date; runAt?: Date } = {}) {
  t.db
    .insert(schema.jobs)
    .values({
      id,
      type: "execute-epic",
      status,
      runAt: opts.runAt ?? new Date(systemClock.now()),
      leaseExpiresAt: opts.leaseExpiresAt ?? null,
      attempts: 1,
    })
    .run();
}

describe("park", () => {
  it("parks a running job and clears its lease", async () => {
    seed("running-job", "running", { leaseExpiresAt: new Date(systemClock.now() + 30_000) });

    expect(await park(t.db, systemClock, "running-job", "boom")).toBe(true);

    const job = await getJob(t.db, "running-job");
    expect(job?.status).toBe("parked");
    expect(job?.leaseExpiresAt).toBeNull();
    expect(job?.lastError).toBe("boom");
  });

  it("parks a job that is queued awaiting a retry", async () => {
    // The regression case: a failed attempt is requeued with a future runAt, not left running.
    seed("retry-job", "queued", { runAt: new Date(systemClock.now() + 5_000) });

    expect(await park(t.db, systemClock, "retry-job", "stop the retry")).toBe(true);
    expect((await getJob(t.db, "retry-job"))?.status).toBe("parked");
  });

  it("a parked retry-pending job can then be resumed", async () => {
    // End-to-end of the broken chain: park → resumeJob. Before the fix the park no-oped, so
    // resumeJob saw a `queued` job and refused it.
    seed("chain-job", "queued", { runAt: new Date(systemClock.now() + 5_000) });

    expect(await park(t.db, systemClock, "chain-job", "pause")).toBe(true);
    expect(await resumeJob(t.db, systemClock, "chain-job")).toBe(true);

    const job = await getJob(t.db, "chain-job");
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(0); // fresh retry budget
  });

  it("reports false and changes nothing for a job that is not active", async () => {
    for (const status of ["done", "failed", "parked"]) {
      const id = `${status}-job`;
      seed(id, status);

      expect(await park(t.db, systemClock, id, "should not apply")).toBe(false);

      const job = await getJob(t.db, id);
      expect(job?.status).toBe(status);
      // A no-op park must not smear its error onto a job it did not touch.
      expect(job?.lastError ?? null).toBeNull();
    }
  });

  it("reports false for an unknown job id", async () => {
    expect(await park(t.db, systemClock, "does-not-exist", "nope")).toBe(false);
  });
});

describe("resumeJob — the boolean is the CAS, not the read", () => {
  it("reports false when a cancel takes the row between the read and the guarded UPDATE", async () => {
    // The window `resumeJob`'s status guard exists to close: the row still reads `parked` when the
    // job is loaded, and an operator cancels before the UPDATE lands. The WHERE then matches nothing.
    // Returning true there would let `resumeEpic` report `resumed-job` and skip its cancellation
    // re-read, so the escalation panel would claim it restarted a job that is still cancelled.
    seed("raced-job", "parked");
    const update = t.db.update.bind(t.db);
    vi.spyOn(t.db, "update").mockImplementationOnce((table) => {
      update(schema.jobs)
        .set({ status: "cancelled", lastError: "cancelled by operator" })
        .where(eq(schema.jobs.id, "raced-job"))
        .run();
      return update(table);
    });

    expect(await resumeJob(t.db, systemClock, "raced-job")).toBe(false);
    expect((await getJob(t.db, "raced-job"))?.status).toBe("cancelled");
  });

  it("still reports true for the resume it actually performed", async () => {
    seed("parked-job", "parked");

    expect(await resumeJob(t.db, systemClock, "parked-job")).toBe(true);
    expect((await getJob(t.db, "parked-job"))?.status).toBe("queued");
  });
});

/**
 * The status CAS a restricted cancel runs on (anton-wvcy). An escalation's "stop retrying" names the
 * statuses it was raised against, so it must reach BOTH of them — `failed` included, which the
 * unrestricted cancel treats as terminal — while still refusing a job that has since gone back to
 * work.
 */
describe("cancelJob — restricted by status", () => {
  const STOPPABLE_FROM = ["parked", "failed"] as const;

  it.each(["parked", "failed"] as const)("terminalizes a %s job it was raised against", async (status) => {
    seed(`${status}-job`, status);

    expect(await cancelJob(t.db, systemClock, `${status}-job`, STOPPABLE_FROM)).toBe(true);
    expect((await getJob(t.db, `${status}-job`))?.status).toBe("cancelled");
  });

  it("refuses a job that left those statuses, leaving it exactly as it is", async () => {
    for (const status of ["queued", "running", "done", "cancelled"]) {
      const id = `${status}-live`;
      seed(id, status);

      expect(await cancelJob(t.db, systemClock, id, STOPPABLE_FROM)).toBe(false);
      expect((await getJob(t.db, id))?.status).toBe(status);
    }
  });

  it("still refuses `failed` on an UNRESTRICTED cancel — only a caller that names it gets that reach", async () => {
    seed("failed-job", "failed");

    expect(await cancelJob(t.db, systemClock, "failed-job")).toBe(false);
    expect((await getJob(t.db, "failed-job"))?.status).toBe("failed");
  });

  it("acts on nothing when `only` intersects no cancellable status", async () => {
    seed("done-job", "done");

    expect(await cancelJob(t.db, systemClock, "done-job", ["done"])).toBe(false);
    expect((await getJob(t.db, "done-job"))?.status).toBe("done");
  });
});
