import { NextResponse } from "next/server";
import { z } from "zod";

import { cancelJob } from "@/lib/jobs/service";
import { PAGE_SIZE } from "@/lib/pagination";
import { withProject } from "../../resolve-project";
import { CANCEL_FAILURE_MESSAGES, type CancelFailureReason } from "../cancel-outcome";

export const dynamic = "force-dynamic";

/**
 * A batch may only ever cover rows the founder can see and select, so one page of the jobs list
 * bounds it. Derived from PAGE_SIZE rather than restated, so the two can't drift apart.
 */
const MAX_BATCH = PAGE_SIZE;

const batchSchema = z.object({
  jobIds: z
    .array(z.string().min(1))
    .min(1, "Select at least one job to cancel")
    .max(MAX_BATCH, `Cannot cancel more than ${MAX_BATCH} jobs in one request`),
});

interface BatchFailure {
  jobId: string;
  reason: CancelFailureReason;
  error: string;
}

/**
 * Force-kill a selected set of jobs in one call (anton-mjdo.4), reporting honestly on each one so
 * the client never has to reconcile N independent cancels itself. Each id goes through the same
 * {@link cancelJob} the single-job route uses — identical project scoping, runner abort, and
 * durable `cancelled` write — so batching can never become a cross-project kill: another project's
 * job is reported `not-found` and its row is left untouched.
 *
 * A per-job refusal never fails the batch: the response is always 200 with a `cancelled` bucket and
 * a `failed` bucket, because one already-terminal job must not stop the rest from dying. Only a bad
 * request (empty/malformed `jobIds`, or more than one page's worth) is rejected outright — an
 * over-cap batch is refused rather than silently truncated, so nothing is left half-killed.
 */
export const POST = withProject<{ slug: string }>(async (request, { project }) => {
  let jobIds: string[];
  try {
    jobIds = batchSchema.parse(await request.json()).jobIds;
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request", issues: err.issues }, { status: 400 });
    }
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const cancelled: string[] = [];
  const failed: BatchFailure[] = [];
  // Deduped so a repeated id is killed once: a second pass would find its own terminal row and
  // report a spurious "already terminal" failure. Sequential — cancel writes the terminal row and
  // aborts a live child, and the batch is small enough that fanning out only adds db contention.
  for (const jobId of new Set(jobIds)) {
    const result = await cancelJob(project.id, jobId);
    if (result.ok) {
      cancelled.push(jobId);
    } else {
      failed.push({ jobId, reason: result.reason, error: CANCEL_FAILURE_MESSAGES[result.reason] });
    }
  }

  return NextResponse.json({ cancelled, failed });
});
