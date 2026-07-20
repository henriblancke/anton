/**
 * `park` semantics (anton-0oi). Park pauses an ACTIVE job for a human and reports whether it
 * actually did so. The regression this locks down: park used to match only `status = 'running'`, so
 * parking a job that had been requeued for a retry silently did nothing and returned `void` — the
 * caller could not tell, and a later `resumeJob` refused the job because it was still `queued`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../db/testing";
import * as schema from "../db/schema";
import { getJob, park, resumeJob, systemClock } from "./queue";

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
