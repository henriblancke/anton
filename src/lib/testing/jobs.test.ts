/**
 * The one thing `expectJobStatus` exists for: a job that settled somewhere unexpected must say WHY
 * in the assertion message. The job suites run their runner with no logger, so the row's
 * `lastError` is the only surviving copy of the reason — a refactor that drops it from the message
 * would put every future red back to reconstructing the failure from the surrounding log.
 */
import { expect, it } from "vitest";
import { makeTestDb } from "@/lib/db/testing";
import { enqueue, park } from "@/lib/jobs/queue";
import { expectJobStatus } from "@/lib/testing/jobs";

it("reports the row's lastError when the status does not match, and returns the row when it does", async () => {
  const tdb = makeTestDb();
  const clock = { now: () => 1 };
  const jobId = await enqueue(tdb.db, clock, { type: "sync-push", payload: {} });
  await park(tdb.db, clock, jobId, "the run could not publish its lease");

  await expect(expectJobStatus(tdb.db, jobId, "done")).rejects.toThrow(
    /the run could not publish its lease/,
  );

  const row = await expectJobStatus(tdb.db, jobId, "parked");
  expect(row.id).toBe(jobId);
});
