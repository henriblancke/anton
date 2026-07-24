import { NextResponse } from "next/server";
import { cancelJob } from "@/lib/jobs/service";
import { withProject } from "../../../resolve-project";

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
      return result.reason === "not-found"
        ? NextResponse.json({ error: "Job not found", cancelled: false }, { status: 404 })
        : NextResponse.json(
            { error: "Job is not cancellable (already terminal)", cancelled: false },
            { status: 409 },
          );
    }
    return NextResponse.json({ cancelled: true });
  },
);
