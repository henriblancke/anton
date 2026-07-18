import { NextResponse } from "next/server";
import { getRunDetail } from "@/lib/runs";
import { listSessions, toSessionSummary } from "@/lib/sessions";
import { resolveProject } from "../../resolve-project";

export const dynamic = "force-dynamic";

/** A run's meta (worktree/branch/model/agent/lease) plus its sessions, for the run-detail screen. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; runId: string }> },
) {
  const { slug, runId } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  const run = await getRunDetail(project.id, runId);
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const sessionRows = await listSessions(project.id, runId);
  const sessions = sessionRows.map(toSessionSummary);
  return NextResponse.json({ run, sessions });
}
