import { NextResponse } from "next/server";
import { cancelJob } from "@/lib/jobs/service";
import { resolveProject } from "../../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * Force-kill a running/queued/parked job (anton-a4jj). Aborts its in-flight child and durably marks
 * it `cancelled` so no durability path (lease reclaim, retry, resume) ever brings it back. A job that
 * doesn't belong to this project → 404; one that's already terminal (done/failed/cancelled) → 409.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string; jobId: string }> },
) {
  const { slug, jobId } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  const result = await cancelJob(project.id, jobId);
  if (!result.ok) {
    return result.reason === "not-found"
      ? NextResponse.json({ error: "Job not found", cancelled: false }, { status: 404 })
      : NextResponse.json(
          { error: "Job is not cancellable (already terminal)", cancelled: false },
          { status: 409 },
        );
  }
  return NextResponse.json({ cancelled: true });
}
