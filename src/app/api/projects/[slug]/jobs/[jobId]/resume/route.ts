import { NextResponse } from "next/server";
import { resumeJob } from "@/lib/jobs/service";
import { getProjectBySlug } from "@/lib/projects";

export const dynamic = "force-dynamic";

/**
 * Manually resume a parked/failed job (anton-ner.4). Un-parks it back to `queued` so the runner
 * re-leases and resumes it idempotently on the next tick (execute-epic reuses the open run/worktree
 * and skips closed tickets — no duplicate PR/commit). A no-op for a job that is already
 * queued/running/done, or one that doesn't belong to this project → 409.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string; jobId: string }> },
) {
  const { slug, jobId } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const resumed = await resumeJob(project.id, jobId);
  if (!resumed) {
    return NextResponse.json(
      { error: "Job is not resumable (must be parked or failed)", resumed: false },
      { status: 409 },
    );
  }
  return NextResponse.json({ resumed: true });
}
