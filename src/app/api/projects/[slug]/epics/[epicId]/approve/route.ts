import { NextResponse } from "next/server";
import { getBoard } from "@/lib/board";
import { refreshAllIssues } from "@/lib/beads/issues";
import { beads } from "@/lib/beads/bd";
import { enqueueExecuteEpic } from "@/lib/jobs/service";
import { getProjectBySlug } from "@/lib/projects";
import { STAGES } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string; epicId: string }> },
) {
  const { slug, epicId } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Gate approval on readiness: approving enqueues execute-epic immediately, so an epic with open
  // blockers must not be startable before its blocker completes. Locate it across stages first.
  // Force a fresh bead read first — this mutating gate must not decide readiness from a warm board
  // snapshot (up to ISSUE_SNAPSHOT_MAX_AGE_MS stale), which could miss a just-added cross-epic
  // `blocks` edge and approve a still-blocked epic.
  await refreshAllIssues(project.repoPath);
  const board = await getBoard(project);
  const epic = STAGES.map((stage) => board.columns[stage].find((e) => e.id === epicId)).find(
    Boolean,
  );
  if (!epic) {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }
  if (!epic.ready) {
    return NextResponse.json(
      { error: `Epic is blocked by ${epic.blockedBy.join(", ")}` },
      { status: 409 },
    );
  }

  await beads.approve(project.repoPath, epicId);
  await beads
    .sync(project.repoPath)
    .catch((err) => console.error(`[approve] beads dolt sync failed after approving ${epicId}`, err));

  // Approval is the trigger: enqueue the autonomous execute-epic run (DESIGN.md §2/§7).
  // Best-effort — approving must still succeed even if the runner enqueue hiccups.
  // Approval always enqueues; the autonomy master-switch (anton-y3l) gates at *claim* in the
  // runner instead, so with autonomy off the job waits `queued` and re-enabling resumes it.
  let jobId: string | undefined;
  try {
    jobId = await enqueueExecuteEpic(project.id, epicId);
  } catch (err) {
    console.error(`[approve] failed to enqueue execute-epic for ${epicId}`, err);
  }

  // Re-read so the response reflects the post-approval state.
  const updatedBoard = await getBoard(project);
  for (const stage of STAGES) {
    const updated = updatedBoard.columns[stage].find((e) => e.id === epicId);
    if (updated) {
      return NextResponse.json({ epic: updated, jobId });
    }
  }

  return NextResponse.json({ error: "Epic not found" }, { status: 404 });
}
