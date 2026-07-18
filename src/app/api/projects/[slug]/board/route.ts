import { NextResponse } from "next/server";
import { getBoard, getBoardVersion } from "@/lib/board";
import { probeAllIssues, refreshAllIssues } from "@/lib/beads/issues";
import { resolveProject } from "../resolve-project";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  const knownVersion = new URL(request.url).searchParams.get("version");
  if (knownVersion !== null) {
    // A stale TTL or completed sync starts one background comparison. Unchanged data keeps the
    // same version and therefore never causes a full board download.
    probeAllIssues(project.repoPath);
    const currentVersion = getBoardVersion(project.repoPath);
    if (knownVersion === currentVersion) {
      return new NextResponse(null, { status: 304 });
    }
    // The version already advanced, so serve the current snapshot now and refresh in the
    // background — never await a cold bd list on the poll path (cold precisely after a write).
    // The client surfaces any newer data on its next poll.
    void refreshAllIssues(project.repoPath).catch(() => {});
  }

  const board = await getBoard(project);
  return NextResponse.json({ board });
}
