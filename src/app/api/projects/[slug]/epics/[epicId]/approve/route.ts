import { NextResponse } from "next/server";
import { getBoard } from "@/lib/board";
import { epicStandaloneBlockers, standaloneBlockers } from "@/lib/epic-graph";
import { refreshAllIssues } from "@/lib/beads/issues";
import { beads } from "@/lib/beads/bd";
import { conflictBody, ownerOf, withClaimLock } from "@/lib/beads/claim";
import { enqueueExecuteEpic } from "@/lib/jobs/service";
import { resolveOperator } from "@/lib/operator";
import { getProjectBySlug } from "@/lib/projects";
import { deriveStage } from "@/lib/ticket-view";
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
  // Settle ownership BEFORE the open-blocker readiness gate below. Approval is the run trigger and
  // normally enqueues execute-epic immediately, so a target with open blockers must not be approved.
  // But a pure ownership take-over — stealing an already-approved backlog target — only reassigns the
  // reservation and enqueues nothing (the take-over gate at the end suppresses the run). It starts no
  // work, so the blocker gate that guards a fresh approval must NOT reject it: a target that gained a
  // blocker AFTER its original approval has to stay transferable to a new owner, not sit stranded with
  // the old one until the blocker closes (the UI offers Take over on exactly these approved backlog
  // targets — claim-control.tsx `canTakeOver`). So read ownership here and derive the take-over first,
  // then let the gate skip it.
  //
  // Re-read the assignee HERE — a fresh `show` after the board load above — rather than reusing
  // `target` from the refreshAllIssues at the top: the board load in between is several bd reads wide,
  // and a teammate claiming inside that window would otherwise be invisible, so the auto-claim below
  // would silently steal their fresh reservation without `{ steal: true }` and enqueue a run under it.
  // Ownership must be settled from the state as it is at the moment we take it.
  const operator = await resolveOperator();
  const current = await beads.show(project.repoPath, epicId);
  if (!current) {
    return NextResponse.json({ error: `Ticket ${epicId} not found on the board` }, { status: 404 });
  }
  const owner = ownerOf(current);
  // Read before the approve below, which would otherwise make every request look like a re-approve.
  // See the enqueue gate at the end for what this distinguishes.
  const wasApproved = beads.isApproved(current);
  const steal = await readSteal(request);
  // A pure take-over reassigns the reservation and nothing more (the enqueue gate at the end skips its
  // run), so it bypasses the blocker gate — but never the steal-validity checks below, which still
  // confine it to a backlog target with a resolvable operator identity. Mirrors the enqueue-suppression
  // condition computed identically at the end.
  const takeOver = wasApproved && steal && !!owner && owner !== operator;

  if (!takeOver && epic) {
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
  if (!takeOver && standalone) {
    const blockers = standaloneBlockers(allBeads, epicId);
    if (blockers.length > 0) {
      return NextResponse.json(
        { error: `${epicId} is blocked by ${blockers.join(", ")}` },
        { status: 409 },
      );
    }
  }

  // Enforce the claim as a soft-lock at the run trigger, from the fresh ownership read above.
  if (owner && owner !== operator) {
    // Claimed by someone else → approving would silently run a teammate's reservation. Require an
    // explicit steal to take it over, mirroring the claim route's 409.
    if (!steal) {
      return NextResponse.json(
        {
          error: `${epicId} is claimed by ${owner} — pass { steal: true } to approve and take it over`,
          owner,
        },
        { status: 409 },
      );
    }
    // A steal only moves the reservation; it does not stop a run already executing under the current
    // owner. The `takeOver` gate below suppresses a *second* enqueue but never halts the first, so
    // reassigning an implementing/in-review target would strand that live run under a new owner —
    // exactly the takeover the runtime is mid-flight on. Only a backlog target (approved-but-unstarted,
    // or never started) is safe to take over. This mirrors the UI, which offers Take over solely on
    // backlog targets (claim-control.tsx `canTakeOver`); enforce that boundary here so a direct request
    // can't bypass it. Derive from the fresh `current` bead read above.
    const stage = deriveStage(current);
    if (stage !== "backlog") {
      return NextResponse.json(
        {
          error: `${epicId} is claimed by ${owner} and is already ${stage} — its run is in progress, so it can't be taken over; wait for it to finish or have ${owner} release it`,
          owner,
          stage,
        },
        { status: 409 },
      );
    }
    // Steal requested, but no operator identity resolves (no ANTON_OPERATOR, no global git user.name),
    // so we can't reassign the target. Approving anyway would enqueue a run under the teammate's
    // reservation while leaving them as assignee — a half-steal that breaks the soft-lock the response
    // text and DESIGN.md promise. Reject until an operator identity is set to take ownership.
    if (!operator) {
      return NextResponse.json(
        {
          error: `${epicId} is claimed by ${owner} — set ANTON_OPERATOR (or git user.name) to identify who is taking it over before approving`,
          owner,
        },
        { status: 409 },
      );
    }
  }
  // Auto-claim, then approve, both under the bead's claim-write lock.
  //
  // The claim: an unclaimed target (or one being stolen) gets assigned to the approver so the
  // reservation is set BEFORE the runtime execution-claim, closing the gap where a teammate could
  // claim between approve and the runner. It's conditional on the assignee still being `owner` —
  // the value the steal gate above decided from. `bd assign` is an unconditional assignee update,
  // so the re-read alone doesn't close the window: a teammate claiming between that read and this
  // write would have their fresh reservation overwritten without `{ steal: true }`. Losing the swap
  // means ownership moved after we checked, so the approval must not proceed on a stale decision —
  // 409 and let the operator re-decide against the state as it now is. Re-approving one you already
  // own swaps owner→owner: no write, just a verification that it's still yours.
  //
  // The lock has to span the label too, not just the swap. The `approved` label is what locks the
  // reservation (the claim route refuses to touch an approved target), so between a bare swap and
  // an unlocked `beads.approve` a teammate's steal would still be legal — it would land on a target
  // that isn't approved *yet*, and this request would then approve and enqueue a run under their
  // reservation, which they never approved. Holding the lock through the label leaves no such
  // window: a concurrent steal either lands first (and this swap 409s) or finds the target approved
  // and is refused.
  //
  // With no operator identity (no ANTON_OPERATOR, no git user.name) there's no one to assign, so
  // the swap is owner→owner: a verified no-op that still takes the lock and still serializes the
  // label against concurrent claims.
  const swap = await withClaimLock(project.repoPath, epicId, async (cas) => {
    const result = await cas(owner, operator ?? owner);
    if (result.ok) await beads.approve(project.repoPath, epicId);
    return result;
  });
  if (!swap.ok) return NextResponse.json(conflictBody(epicId, swap.owner), { status: 409 });

  await beads
    .sync(project.repoPath)
    .catch((err) => console.error(`[approve] beads dolt sync failed after approving ${epicId}`, err));

  // Approval is the trigger: enqueue the autonomous execute-epic run (DESIGN.md §2/§7). Every
  // approval enqueues EXCEPT a pure ownership take-over — stealing an already-approved target only
  // moves the reservation to the new owner, so it must reassign the bead and nothing more.
  // `enqueueExecuteEpicDeduped` alone can't carry that guarantee: it dedupes `queued`/`running`
  // only, so a take-over of an epic whose run has since parked/failed/finished would spawn a SECOND
  // run under the new owner. `wasApproved` is read from beads (shared across operators via dolt)
  // rather than the jobs table, which is machine-local and disposable (README/DESIGN §"Ephemeral")
  // and so reads "never enqueued" for a run living on another machine.
  //
  // The gate is deliberately scoped to the steal: a re-approve that ISN'T a take-over is the
  // operator asking for a run. Both epic-detail run buttons post here with no body (Force run on an
  // implementing epic, Run epic elsewhere — epic-detail-view.tsx), as does re-approving a target
  // whose enqueue previously failed. Gating those on `wasApproved` alone would report success with
  // no `jobId` and leave an approved epic with no way to retry from the UI. The dedupe covers the
  // double-click case; a cross-machine force-run is not deduped (anton-jz1).
  //
  // Best-effort — approving must still succeed even if the runner enqueue hiccups.
  // The autonomy master-switch (anton-y3l) gates at *claim* in the runner instead, so with autonomy
  // off the job waits `queued` and re-enabling resumes it.
  // `takeOver` was derived above (identical condition) so the blocker gate could skip a pure take-over.
  let jobId: string | undefined;
  try {
    if (!takeOver) jobId = await enqueueExecuteEpic(project.id, epicId);
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
