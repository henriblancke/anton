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
  // The poll path stays non-blocking end to end: getBoard must serve the retained snapshot instead
  // of awaiting the post-write load that a pending local write would otherwise force downstream.
  let blockOnPendingWrite = true;
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
    blockOnPendingWrite = false;
  } else {
    // A forced reload carries no version token — it follows a local mutation (TicketDialog
    // onSaved/onDeleted) or a manual retry. A local write RETAINS the pre-write snapshot
    // (invalidateIssueSnapshot only marks it stale), so building the board off it here would hand
    // back the old chip/title stamped with the already-advanced version, and the client would only
    // self-correct a poll later. Await a fresh read so this response reflects the write — but fall
    // back to the last-good snapshot on a transient bd failure rather than 500 the reload.
    await refreshAllIssues(project.repoPath).catch(() => {});
  }

  const board = await getBoard(project, { blockOnPendingWrite });
  return NextResponse.json({ board });
}
