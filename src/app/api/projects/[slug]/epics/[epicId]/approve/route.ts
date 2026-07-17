import { NextResponse } from "next/server";
import { getBoard } from "@/lib/board";
import { epicStandaloneBlockers, standaloneBlockers } from "@/lib/epic-graph";
import { refreshAllIssues } from "@/lib/beads/issues";
import { beads } from "@/lib/beads/bd";
import { enqueueExecuteEpic } from "@/lib/jobs/service";
import { resolveOperator } from "@/lib/operator";
import { getProjectBySlug } from "@/lib/projects";
import { STAGES } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Read the optional `{ steal?: boolean }` body; a missing/invalid body means no steal. */
async function readSteal(request: Request): Promise<boolean> {
  try {
    const body = (await request.json()) as { steal?: unknown };
    return body?.steal === true;
  } catch {
    return false;
  }
}

export async function POST(
  request: Request,
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
  // The fresh read returns the loaded beads, so reuse them for the runnability gate below rather than
  // issuing a second `bd list`. Crucially, `refreshAllIssues` goes through `loadAllIssues`, which
  // falls back to separate open/closed reads where `--status all` fails; calling `beads.list` directly
  // here would skip that fallback and 500 the whole approval in exactly the scenario the board handles.
  const allBeads = await refreshAllIssues(project.repoPath);

  // Validate the target is actually runnable *before* touching labels or enqueuing. Approval is the
  // run trigger, so labeling-and-enqueuing a bead that execute-epic will only poison-park is a false
  // green: the operator sees "approved" but no run ever reaches a PR. Reuse the same isRunTarget gate
  // execute-epic enforces (a shared helper, no duplicated type logic) so the route and the runner
  // agree on what "runnable" means. Read beads fresh (matching execute-epic's `--status all` load) so
  // a missing bead is distinguishable from a found-but-not-runnable one, and the message stays honest.
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
  // A standalone task/bug (epic-of-one) lives in `standalone`, not `columns`, so it carries no
  // epic-graph readiness — but it can still hold cross-item `blocks` edges. It must be found here
  // or a valid run target 404s, and it must be gated on its own open blockers below.
  const standalone = epic
    ? undefined
    : STAGES.map((stage) => board.standalone[stage].find((e) => e.id === epicId)).find(Boolean);
  if (!epic && !standalone) {
    return NextResponse.json({ error: "Run target not found" }, { status: 404 });
  }
  if (epic) {
    // epic.blockedBy is the epic-graph rollup (epic→epic + cross-epic child blocks). That rollup
    // DROPS any blocks edge whose blocker is a parentless standalone task/bug, so an epic (or a
    // child of it) that depends on an open standalone item would otherwise read ready here. Gate on
    // those standalone blockers too — derived off the same fresh read — so the epic can't be
    // approved/enqueued before its standalone prerequisite is done.
    const blockers = [...epic.blockedBy, ...epicStandaloneBlockers(allBeads, epicId)];
    if (blockers.length > 0) {
      return NextResponse.json(
        { error: `Epic is blocked by ${blockers.join(", ")}` },
        { status: 409 },
      );
    }
  }
  // A standalone target's blockers aren't in the epic rollup, so derive them from its own `blocks`
  // edges off the fresh read above. Approving enqueues immediately, so a still-blocked standalone
  // must be rejected here — else we'd label + enqueue work `bd ready` would keep blocked, and the
  // runner's epic-only readiness check (a no-op for standalone) wouldn't catch it either.
  if (standalone) {
    const blockers = standaloneBlockers(allBeads, epicId);
    if (blockers.length > 0) {
      return NextResponse.json(
        { error: `${epicId} is blocked by ${blockers.join(", ")}` },
        { status: 409 },
      );
    }
  }

  // Enforce the claim as a soft-lock at the run trigger. `target` was read via refreshAllIssues
  // above (the same fresh path this route already uses), so a teammate's just-landed claim is
  // visible here — not read from a warm snapshot. Approval is the run trigger, so ownership must be
  // settled before we label + enqueue.
  const operator = await resolveOperator();
  const owner = target.assignee?.trim() || undefined;
  // Claimed by someone else → approving would silently run a teammate's reservation. Require an
  // explicit steal to take it over, mirroring the claim route's 409.
  if (owner && owner !== operator && !(await readSteal(request))) {
    return NextResponse.json(
      {
        error: `${epicId} is claimed by ${owner} — pass { steal: true } to approve and take it over`,
        owner,
      },
      { status: 409 },
    );
  }
  // Auto-claim before enqueuing: an unclaimed target (or one being stolen) gets assigned to the
  // approver so the reservation is set BEFORE the runtime execution-claim, closing the gap where a
  // teammate could claim between approve and the runner. Re-approving one you already own is a no-op
  // here (idempotent). Skipped when no operator identity resolves (can't name an assignee).
  if (operator && owner !== operator) {
    await beads.assign(project.repoPath, epicId, operator);
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

  // Re-read so the response reflects the post-approval state. The target is an epic or a standalone
  // chip; return whichever the board now carries. `epic` is kept for the existing epic-card client.
  const updatedBoard = await getBoard(project);
  for (const stage of STAGES) {
    const updatedEpic = updatedBoard.columns[stage].find((e) => e.id === epicId);
    if (updatedEpic) {
      return NextResponse.json({ epic: updatedEpic, item: updatedEpic, jobId });
    }
    const updatedItem = updatedBoard.standalone[stage].find((e) => e.id === epicId);
    if (updatedItem) {
      return NextResponse.json({ item: updatedItem, jobId });
    }
  }

  return NextResponse.json({ error: "Run target not found" }, { status: 404 });
}
