import { NextResponse } from "next/server";
import { beads, type Bead } from "@/lib/beads/bd";
import { conflictBody, ownerOf, withClaimLock, type SwapResult } from "@/lib/beads/claim";
import { refreshAllIssues } from "@/lib/beads/issues";
import { resolveOperator } from "@/lib/operator";
import { resolveProject } from "../../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * Human claim: reserve a run target for a person WITHOUT approving it for automation. Unlike
 * approve (which enqueues a run) or the runner's `claim` (which flips the bead to in_progress),
 * this only sets/clears the assignee via beads.assign/unassign — the bead stays `open` and never
 * triggers a run. POST claims the target for the requesting operator; DELETE releases it.
 *
 * Mirrors the approve route's shape (fresh bead read, isRunTarget 422 gate, best-effort sync
 * nudge) so the claim surface agrees with approve on what "runnable" means and reaches teammates
 * within a heartbeat.
 */

/** Build the 422 reason for a non-run-target, mirroring the approve route's wording. */
function notRunnableReason(id: string, target: Bead): string {
  const parent = (target.parent ?? target.parent_id) as string | undefined;
  const type = target.issue_type ?? "unknown";
  return (type === "task" || type === "bug") && parent
    ? `${id} is a child ticket of ${parent} — claim its epic ${parent} instead; a child is reserved via its epic, not on its own`
    : `${id} is not a run target: type "${type}" — only an epic or a parentless task/bug can be claimed`;
}

/** Read the optional `{ steal?: boolean }` body; a missing/invalid body means no steal. */
async function readSteal(request: Request): Promise<boolean> {
  try {
    const body = (await request.json()) as { steal?: unknown };
    return body?.steal === true;
  } catch {
    return false;
  }
}

/**
 * Resolve project + run target off a FRESH bead read, returning either the loaded target or a
 * ready-to-return error response. Shared by POST/DELETE so both gate identically to approve.
 */
async function loadTarget(
  slug: string,
  epicId: string,
): Promise<{ ok: true; repoPath: string; target: Bead } | { ok: false; response: NextResponse }> {
  const { project, response } = await resolveProject(slug);
  if (!project) return { ok: false, response };

  // Force a fresh read (not a warm board snapshot) so the steal check and run-target gate decide
  // from the true current state — a claim added by a teammate seconds ago must be visible here.
  const allBeads = await refreshAllIssues(project.repoPath);
  const target = allBeads.find((b) => b.id === epicId);
  if (!target) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Ticket ${epicId} not found on the board` },
        { status: 404 },
      ),
    };
  }
  if (!beads.isRunTarget(target)) {
    return {
      ok: false,
      response: NextResponse.json({ error: notRunnableReason(epicId, target) }, { status: 422 }),
    };
  }
  // Once approved, the reservation is locked in by the approve flow (soft-lock + steal-on-approve):
  // the human-claim route must NOT mutate an approved target's assignee. Approval queues a run, and
  // the runner swallows its own epic claim (`safe(() => beads.claim(...))` in execute-epic), so a
  // post-approval steal/release here would let a queued run execute under someone else's reservation
  // while the board shows a different owner. Ownership of an approved target changes only through
  // Approve (steal-on-approve), never through this route.
  if (beads.isApproved(target)) return { ok: false, response: approvedLockResponse(epicId) };
  return { ok: true, repoPath: project.repoPath, target };
}

/** The 409 for a claim write refused because approval has locked the target's reservation. */
function approvedLockResponse(epicId: string): NextResponse {
  return NextResponse.json(
    {
      error: `${epicId} is already approved for a run — its reservation is locked; take it over via Approve (steal-on-approve), not the claim control`,
    },
    { status: 409 },
  );
}

/**
 * The approved gate above reads a bead loaded before this route's own gates ran, so an approval
 * landing in that window would slip past it. Re-check under the claim-write lock — the same lock the
 * approve route holds across its swap AND its `approved` label — and only then swap. That makes the
 * two routes strictly ordered on one bead: a claim either wins the lock and writes while the target
 * is genuinely unapproved (and approve's swap then 409s on the changed owner), or it takes the lock
 * after the label and is refused here. Without the re-check, a steal could still land on a target
 * approve had already decided to run, leaving a queued run executing under an owner who never
 * approved it.
 */
async function swapUnlessApproved(
  repoPath: string,
  epicId: string,
  owner: string | undefined,
  next: string | undefined,
): Promise<SwapResult | "approved"> {
  return withClaimLock(repoPath, epicId, async (swap) => {
    if (beads.isApproved(await beads.show(repoPath, epicId))) return "approved" as const;
    return swap(owner, next);
  });
}

/** Best-effort sync so the claim/release reaches teammates within a heartbeat; never blocks. */
function nudgeSync(repoPath: string, epicId: string, verb: string): Promise<void> {
  return beads
    .sync(repoPath)
    .catch((err) => console.error(`[claim] beads dolt sync failed after ${verb} ${epicId}`, err));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; epicId: string }> },
) {
  const { slug, epicId } = await params;
  const loaded = await loadTarget(slug, epicId);
  if (!loaded.ok) return loaded.response;
  const { repoPath, target } = loaded;

  const operator = await resolveOperator();
  if (!operator) {
    return NextResponse.json(
      { error: "Could not resolve an operator identity to claim as (set ANTON_OPERATOR or git user.name)" },
      { status: 400 },
    );
  }

  const owner = ownerOf(target);
  // Already claimed by someone else → stealing must be explicit, so a claim can't silently stomp a
  // teammate's reservation. Re-claiming your own is idempotent and needs no steal.
  if (owner && owner !== operator && !(await readSteal(request))) {
    return NextResponse.json(
      { error: `${epicId} is already claimed by ${owner} — pass { steal: true } to take it over`, owner },
      { status: 409 },
    );
  }

  // Conditional write: `bd assign` is unconditional, so gating on `owner` alone would let two
  // operators both pass the check above against the same snapshot and have the later write stomp
  // the earlier claim — both answering 200. Swap only if the assignee is still what we gated on,
  // so the loser gets a 409 naming the winner. A steal is authorized against the owner the caller
  // was shown; if someone else has since taken it, that authorization doesn't carry over.
  const swap = await swapUnlessApproved(repoPath, epicId, owner, operator);
  if (swap === "approved") return approvedLockResponse(epicId);
  if (!swap.ok) return NextResponse.json(conflictBody(epicId, swap.owner), { status: 409 });
  // Fire-and-forget (like the runner's claim sync in execute-epic): the assignee write already
  // succeeded, so don't make the response wait on a shell-out to `bd dolt pull/commit/push` that a
  // slow/unreachable remote could stall — the sync engine's heartbeat is the backstop.
  void nudgeSync(repoPath, epicId, "claiming");

  return NextResponse.json({ item: await beads.show(repoPath, epicId) });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ slug: string; epicId: string }> },
) {
  const { slug, epicId } = await params;
  const loaded = await loadTarget(slug, epicId);
  if (!loaded.ok) return loaded.response;
  const { repoPath, target } = loaded;

  const owner = ownerOf(target);
  if (owner) {
    // Releasing another operator's claim is itself a steal — gate it the same way as taking one over
    // so a release can't silently clear a teammate's reservation. An unclaimed target is a no-op.
    const operator = await resolveOperator();
    if (owner !== operator) {
      if (!(await readSteal(request))) {
        return NextResponse.json(
          { error: `${epicId} is claimed by ${owner} — pass { steal: true } to release someone else's claim`, owner },
          { status: 409 },
        );
      }
      // A steal with no resolvable operator identity (no ANTON_OPERATOR, no global git user.name) is
      // an override nobody can be held to: without an identity we can't even tell whose claim this is
      // *not*, so `owner !== operator` is vacuously true and the steal gate above is the only thing
      // standing between a crafted body and a teammate's reservation. POST/approve both refuse a steal
      // they can't attribute; a release must too — clearing someone's claim is no less consequential.
      if (!operator) {
        return NextResponse.json(
          {
            error: `${epicId} is claimed by ${owner} — set ANTON_OPERATOR (or git user.name) to identify who is releasing someone else's claim`,
            owner,
          },
          { status: 409 },
        );
      }
    }
    // Same conditional write as POST: a release is a claim write too, so an unconditional
    // `unassign` here would clear a reservation that changed hands — or that approval locked —
    // after the gates above.
    const swap = await swapUnlessApproved(repoPath, epicId, owner, undefined);
    if (swap === "approved") return approvedLockResponse(epicId);
    if (!swap.ok) return NextResponse.json(conflictBody(epicId, swap.owner), { status: 409 });
    // Fire-and-forget for the same reason as POST: the unassign already landed locally, so don't
    // block the release response on the best-effort remote sync.
    void nudgeSync(repoPath, epicId, "releasing");
  }

  return NextResponse.json({ item: await beads.show(repoPath, epicId) });
}
