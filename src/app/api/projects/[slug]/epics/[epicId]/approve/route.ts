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

  // Validate the target is actually runnable *before* touching labels or enqueuing. Approval is the
  // run trigger, so labeling-and-enqueuing a bead that execute-epic will only poison-park is a false
  // green: the operator sees "approved" but no run ever reaches a PR. Reuse the same isRunTarget gate
  // execute-epic enforces (a shared helper, no duplicated type logic) so the route and the runner
  // agree on what "runnable" means. Read beads fresh (matching execute-epic's `--status all` load) so
  // a missing bead is distinguishable from a found-but-not-runnable one, and the message stays honest.
  const allBeads = await beads.list(project.repoPath, ["--status", "all"]);
  const target = allBeads.find((b) => b.id === epicId);
  if (!target) {
    return NextResponse.json({ error: `Ticket ${epicId} not found on the board` }, { status: 404 });
  }
  if (!beads.isRunTarget(target)) {
    const parent = (target.parent ?? target.parent_id) as string | undefined;
    const type = target.issue_type ?? "unknown";
    const reason =
      (type === "task" || type === "bug") && parent
        ? `${epicId} is a child ticket of ${parent} — approve its epic ${parent} instead; a child runs via its epic's PR, not on its own`
        : `${epicId} is not runnable: type "${type}" — only an epic or a parentless task/bug can be approved to run`;
    return NextResponse.json({ error: reason }, { status: 422 });
  }

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
