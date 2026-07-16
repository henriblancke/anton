import { NextResponse } from "next/server";
import { getBoard } from "@/lib/board";
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

  const board = await getBoard(project);
  for (const stage of STAGES) {
    const epic = board.columns[stage].find((e) => e.id === epicId);
    if (epic) {
      return NextResponse.json({ epic, jobId });
    }
  }

  return NextResponse.json({ error: "Epic not found" }, { status: 404 });
}
