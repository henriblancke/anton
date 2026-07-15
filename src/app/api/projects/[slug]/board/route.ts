import { NextResponse } from "next/server";
import { getBoard, getBoardVersion } from "@/lib/board";
import { getProjectBySlug } from "@/lib/projects";
import { probeAllIssues, refreshAllIssues } from "@/lib/beads/issues";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const knownVersion = new URL(request.url).searchParams.get("version");
  if (knownVersion !== null) {
    // A stale TTL or completed sync starts one background comparison. Unchanged data keeps the
    // same version and therefore never causes a full board download.
    probeAllIssues(project.repoPath);
    const currentVersion = getBoardVersion(project.repoPath);
    if (knownVersion === currentVersion) {
      return new NextResponse(null, { status: 304 });
    }
    // Writes and completed pulls invalidate only after Dolt is done, so this refresh cannot
    // collide with the synchronization pass that changed the version.
    await refreshAllIssues(project.repoPath);
  }

  const board = await getBoard(project);
  return NextResponse.json({ board });
}
