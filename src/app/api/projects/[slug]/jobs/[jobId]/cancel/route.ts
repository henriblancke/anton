import { NextResponse } from "next/server";
import { cancelJob } from "@/lib/jobs/service";
import { withProject } from "../../../resolve-project";
import { CANCEL_FAILURE_MESSAGES } from "../../cancel-outcome";

export const dynamic = "force-dynamic";

/**
 * Force-kill a running/queued/parked job (anton-a4jj). Aborts its in-flight child and durably marks
 * it `cancelled` so no durability path (lease reclaim, retry, resume) ever brings it back. A job that
 * doesn't belong to this project → 404; one that's already terminal (done/failed/cancelled) → 409.
 */
export const POST = withProject<{ slug: string; jobId: string }>(
  async (_request, { project, params }) => {
    const result = await cancelJob(project.id, params.jobId);
    if (!result.ok) {
      return NextResponse.json(
        { error: CANCEL_FAILURE_MESSAGES[result.reason], cancelled: false },
        { status: result.reason === "not-found" ? 404 : 409 },
      );
    }
    return NextResponse.json({ cancelled: true });
  },
);
