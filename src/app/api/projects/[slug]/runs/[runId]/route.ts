import { NextResponse } from "next/server";
import { getProjectBySlug } from "@/lib/projects";
import { getRunDetail } from "@/lib/runs";
import { listSessions, toSessionSummary } from "@/lib/sessions";

export const dynamic = "force-dynamic";

/** A run's meta (worktree/branch/model/agent/lease) plus its sessions, for the run-detail screen. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; runId: string }> },
) {
  const { slug, runId } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const run = await getRunDetail(project.id, runId);
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const sessionRows = await listSessions(project.id, runId);
  const sessions = sessionRows.map(toSessionSummary);
  return NextResponse.json({ run, sessions });
}
