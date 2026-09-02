/**
 * What a run takes HOLD of once its lease is confirmed (anton-1lix — extracted from
 * execute-epic.ts): the checkout it executes in, and the reservations that stop every other worker
 * on a shared board from picking up the same tickets.
 *
 * Everything here writes — to the filesystem or to the board — so it runs strictly after the
 * read-only gates in {@link prepareEpicRun}: a refusal past this line has residue to hand back.
 */
import { beads, LABELS, unclaimableStatus } from "../beads/bd";
import { ownerOf } from "../beads/claim";
import { assignChildren, formatReservedChildren } from "../beads/child-assign";
import { resolveFreshBase } from "../git/ops";
import { acquireWorktreeClaim, createWorktree, type Worktree } from "../git/worktree";
import { resolveOperator } from "../operator";
import { updateRun } from "../runs";
import { PoisonEpic } from "./errors";
import { safe } from "./execute-epic-persist";
import type { EpicRun } from "./execute-epic-run";
import type { StepContext } from "./step-registry";

/**
 * Who a run is, as its worktree claim records it. The RUN id, not the epic's: a resumed attempt takes
 * a fresh claim of its own, and naming the run is what makes a leftover claim traceable to the
 * attempt that took it — the same reason review-fix keys its owner by job id.
 */
export function claimOwnerFor(runId: string): string {
  return `execute-epic#${runId}`;
}

/** Step 2. Warm (or reuse) the run's checkout and build the context every step is narrowed from. */
export async function warmRunWorktree(
  run: EpicRun,
): Promise<{ worktree: Worktree; runStep: Omit<StepContext, "tickets"> }> {
  const { db, clock, ctx, projectId, repo, runId, branch, project, settings, lease, target } = run;
  // 2. Warm worktree (idempotent — reused on resume). Branch off the FRESHEST base
  // (anton-x3o): resolveFreshBase fetches origin/<base> and returns `origin/<base>` so a run
  // whose local base is stale still starts at the remote tip; it's best-effort and falls back
  // to the local base offline. On resume this is moot — createWorktree short-circuits to the
  // existing worktree, so the base is never re-applied mid-run. Note the PR `base` below stays
  // the plain branch name (gh needs a branch, not a remote-tracking ref).
  const baseBranch = settings.baseBranch ?? project.defaultBranch;
  // Held for the review gate below too: it diffs the branch against this base's MERGE BASE, so
  // the remote-tracking ref is the accurate fork point even when the local base has drifted.
  const freshBase = await resolveFreshBase(repo, baseBranch);
  // Claim the checkout for the whole run (anton-hrun.1). The claim's `git worktree lock` is the
  // ONLY evidence a second anton process over this repository has that the directory is in use:
  // its teardown and its sweep judge residue from their own run rows and the board, which say
  // nothing about a run on this machine, so an unclaimed checkout on a still-open bead reads as
  // "release the worktree" and is force-removed with this run's uncommitted work in it.
  const worktreeClaim = claimOwnerFor(runId);
  run.worktreeClaim = worktreeClaim;
  await acquireWorktreeClaim(repo, branch, worktreeClaim);
  const worktree = await createWorktree({
    repoPath: repo,
    branch,
    baseBranch: freshBase,
    warm: true,
    claimedBy: worktreeClaim,
    // A cold install can run for minutes; without the job's signal an operator's kill would wait
    // it out, holding the run's concurrency slot the whole time.
    signal: ctx.signal,
  });
  run.worktree = worktree;
  await updateRun(db, clock, runId, {
    worktreePath: worktree.path,
    branch: worktree.branch,
    attempts: ctx.attempt,
  });
  await ctx.heartbeat();

  // Every step of the walk runs through the step registry (anton-4npr) — one entry point per step,
  // dispatched in the order the project's formula declares. This is what they all operate on; each
  // dispatch adds the ticket(s) in scope (and, per ticket, that ticket's session) plus the formula
  // step itself, which is where a `step:claude` reads its prompt.
  const runStep: Omit<StepContext, "tickets"> = {
    db,
    clock,
    ctx,
    projectId,
    runId,
    repoPath: repo,
    worktreePath: worktree.path,
    branch: worktree.branch,
    baseBranch,
    baseRef: freshBase,
    target,
    settings,
    assertLeaseHeld: lease.assertHeld,
  };
  return { worktree, runStep };
}

/** Step 3. Assert this process still owns the target, then claim it for the operator. */
export async function claimRunTarget(run: EpicRun): Promise<void> {
  const { repo, targetId: epicBeadId } = run;
  // 3. Assert this process still owns the epic, THEN claim it for the human operator (idempotent).
  //    An approved-but-unstarted (backlog) target can be TAKEN OVER — reassigned to another
  //    operator via the approve route's steal — after this run was queued but before it leased the
  //    epic (a queued or autonomy-paused job). The take-over enqueues a fresh run on the NEW
  //    owner's instance, but the jobs table is machine-local: THIS stale job still sits on the
  //    ORIGINAL operator's instance. Running it now would execute under the new owner's
  //    reservation — the exact "run under someone else's claim" state the soft-lock
  //    forbids (DESIGN.md §Soft-lock). So gate on ownership FIRST — like the ticket-claim hard gate
  //    in runTicket — AND make the claim itself hard (below): a steal landing between this read and
  //    the claim is caught by `bd update --claim` refusing to reassign, not swallowed by `safe`.
  //    Re-read the owner here (not from the job-start snapshot): the worktree warm
  //    above is several ops wide, so ownership settles against current state, mirroring the approve
  //    route re-reading the assignee at its own run trigger. PARK (not fail) on a mismatch —
  //    recoverable, it stops the stale run without stomping the new owner, and the current owner
  //    approving afresh enqueues a run under their identity on their instance. A runner with no
  //    operator identity can't assert ownership, so it falls through to the prior best-effort claim.
  //    The claim's own sync nudge (below) still makes it visible on teammates' boards within a
  //    heartbeat (anton-live-sync R6); fire-and-forget, the end-of-run sync is the backstop.
  const operator = await resolveOperator();
  const currentOwner = ownerOf(await beads.show(repo, epicBeadId));
  if (operator && currentOwner && currentOwner !== operator) {
    throw new PoisonEpic(
      `${epicBeadId} is reserved by ${currentOwner}, not ${operator} — it was taken over after ` +
        `this run was queued; refusing to run under another operator's claim. Approve ${epicBeadId} ` +
        `as ${currentOwner} to start a run under the current owner.`,
    );
  }
  if (operator) {
    // Fold the ownership gate INTO the claim so a take-over that lands in the window between the
    // read above and this write can't slip through. `bd update --claim` refuses to reassign a
    // bead a different operator now holds, so it — not the stale pre-read — is the operation that
    // actually observes a racing steal. That refusal MUST stop the run (like runTicket's ticket
    // hard gate), never be swallowed by `safe`: swallowing would tag and execute the epic under
    // the new owner's reservation, the exact state the soft-lock forbids. On the NORMAL path the
    // approve route already pre-assigned this same operator (approve/route.ts `cas(owner, operator)`),
    // so this is a same-actor re-claim — and `bd update --claim` is idempotent for the same actor
    // ("idempotent if already claimed by you" per its own help; verified on bd 1.0.4), so it
    // succeeds and the run proceeds. Same story on resume, so a retry re-claims cleanly. What a
    // refusal actually means is classified by {@link claimFailure}.
    try {
      await beads.claim(repo, epicBeadId, operator);
    } catch (e) {
      throw await claimFailure(repo, epicBeadId, operator, e);
    }
  } else if (currentOwner) {
    // No operator identity, but the epic is owned by someone. We can't assert we ARE that
    // owner, and a best-effort `safe` claim would swallow bd's refusal to reassign a foreign
    // bead — tagging and running the epic under the current owner's reservation, the exact
    // state the soft-lock forbids (DESIGN.md §Soft-lock). So mirror the pre-read gate above
    // and PARK: this is an older queued approved-but-unassigned job on an instance without
    // ANTON_OPERATOR/global user.name, and another operator took the epic over before the
    // lease. Poison (recoverable) — a human must re-approve as the current owner to enqueue a
    // run under their identity. Retrying is pointless: this runner still can't assert ownership.
    throw new PoisonEpic(
      `${epicBeadId} is reserved by ${currentOwner}, but this runner has no operator identity ` +
        `(set ANTON_OPERATOR or the global git user.name) to assert ownership — refusing to ` +
        `run under another operator's claim. Approve ${epicBeadId} as ${currentOwner} to start ` +
        `a run under the current owner.`,
    );
  } else {
    // No operator identity AND the epic is unowned → nobody's reservation to stomp, so keep
    // the prior best-effort claim (bd falls back to its own actor resolution).
    await safe(() => beads.claim(repo, epicBeadId, operator));
  }
  await safe(() => beads.tag(repo, epicBeadId, [LABELS.stage("implementing")]));
  run.operator = operator;
}

/**
 * Why `bd update --claim` refused, as the error the caller should throw. Three causes, and only the
 * transient one is worth a retry — returning the built error (rather than a discriminant the caller
 * re-expands) keeps each cause's remedy next to the check that detects it.
 */
async function claimFailure(
  repo: string,
  epicBeadId: string,
  operator: string,
  e: unknown,
): Promise<Error> {
  const cause = e instanceof Error ? e.message : String(e);
  // Re-read the owner to spot the first cause: if a DIFFERENT operator now holds the epic, this is
  // a confirmed take-over — retrying is pointless, so poison (human must re-approve as the current
  // owner). A racing steal is still caught either way: either this re-read sees it, or the pre-read
  // gate in claimRunTarget does on the next attempt. If the re-read ITSELF fails we can't confirm a
  // take-over, so fall through to the status check.
  const ownerNow = await beads
    .show(repo, epicBeadId)
    .then(ownerOf)
    .catch(() => undefined);
  if (ownerNow && ownerNow !== operator) {
    return new PoisonEpic(
      `${epicBeadId} is reserved by ${ownerNow}, not ${operator} — it was taken over after this ` +
        `run was queued; refusing to run under another operator's claim. Approve ${epicBeadId} as ` +
        `${ownerNow} to start a run under the current owner. (${cause})`,
    );
  }
  // The second cause: bd refused because the bead's STATUS isn't claimable (blocked, closed,
  // deferred), with no ownership change at all — so the re-read above sees nothing wrong and the
  // old code bucketed it as transient, retried it 3× against an error that can never change, and
  // parked telling the operator the Dolt DB was locked (anton-e5ix, observed on anton-f5f3). Poison
  // on the FIRST attempt instead, naming the status and the fix: only a human moving the bead out
  // of that status can make the claim succeed.
  const status = unclaimableStatus(e);
  if (status) {
    return new PoisonEpic(
      `${epicBeadId} cannot be claimed while its status is "${status}" — bd refuses the claim ` +
        `and no retry can change that. Reopen/unblock ${epicBeadId} (its status must be ` +
        `claimable, e.g. open) and approve it again to start a run. (${cause})`,
    );
  }
  // The third: a transient failure (a Dolt lock, a CLI timeout) with NO ownership change. Poisoning
  // those would park a valid approved epic that a retry would claim cleanly, so return a plain
  // retryable Error — the same call runTicket's hard gate makes.
  return new Error(
    `${epicBeadId} could not be claimed for ${operator} — the beads DB is locked or the claim ` +
      `command failed transiently; retrying. (${cause})`,
  );
}

/** Step 3b. Reserve the target's open children for the same actor, so bd stops offering them. */
export async function cascadeChildClaims(run: EpicRun): Promise<void> {
  const { targetId: epicBeadId, repo, tickets, standaloneRun, operator } = run;
  // 3b. Cascade the claim to the target's open children (anton-0d85). The claim above settles the
  //     FEATURE, but `bd ready --unassigned` filters on each TASK's assignee — so without this a
  //     running feature keeps offering its own children to every other worker on the board, and
  //     the only thing standing between them and a duplicate run is anton-side knowledge no plain
  //     `bd` client has. Assigning them makes bd's own readiness query exclude them natively.
  //     A child a DIFFERENT actor holds is left exactly as it is and reported here — a human's
  //     reservation outranks a run's, and clobbering it would hide the conflict that runTicket's
  //     hard claim gate is about to stop the run on anyway.
  //     Only for a grouped run: a standalone target IS its own ticket and was just claimed above.
  //     Skipped without an operator identity too — `bd assign` names an assignee, and there is
  //     none to name (the same reason that path keeps a best-effort claim).
  //     Fails CLOSED, like the run-lease publish and for the same reason: a run executing children
  //     the board still offers to everyone else is the duplicate-work hazard this exists to
  //     prevent, so half a cascade must stop the attempt rather than proceed quietly. Retryable
  //     (a plain Error, not poison) — a locked bd DB self-heals within the retry budget.
  if (operator && !standaloneRun) {
    const cascade = await assignChildren(repo, tickets, operator);
    // Recorded BEFORE the incomplete-cascade throw below, so the stopping path hands back the
    // reservations this cascade did take rather than stranding them.
    run.childCascade = { actor: operator, ids: cascade.held };
    if (cascade.reserved.length > 0) {
      console.warn(
        `[execute-epic] ${epicBeadId}: left ${cascade.reserved.length} child ticket(s) with ` +
          `another assignee untouched — ${formatReservedChildren(cascade.reserved)}`,
      );
    }
    if (cascade.failed.length > 0) {
      throw new Error(
        `${epicBeadId} could not reserve ${cascade.failed.map((f) => f.id).join(", ")} for ` +
          `${operator} — the beads DB is locked or the assign failed transiently; retrying ` +
          `rather than running a feature whose children the board still offers to other ` +
          `workers. (${cascade.failed[0].error})`,
      );
    }
  }
}

/** Step 3c. Publish the claim and the cascade before executing anything. */
export async function publishRunClaim(run: EpicRun): Promise<void> {
  const { repo, targetId: epicBeadId, operator } = run;
  // 3c. PUBLISH the claim and the cascade before executing anything (anton-0d85). A reservation
  //     only exists locally until it reaches the Dolt remote, so a fire-and-forget push would
  //     leave every other machine reading these beads as unassigned for the whole run — exactly
  //     the duplicate-work window 3a/3b are here to close, reopened at the last step. Await it
  //     and fail CLOSED, the same rule the run-lease publish follows and for the same reason.
  //     Retryable (a plain Error): the claim and the cascade are idempotent for this actor, so a
  //     retry re-publishes rather than re-reserving. `beads.sync` tolerates a no-remote
  //     workspace, so a single-machine run is unaffected.
  try {
    await beads.sync(repo);
  } catch (e) {
    throw new Error(
      `${epicBeadId} was claimed${operator ? ` for ${operator}` : ""} but the claim could not be ` +
        `published to the shared board — other machines would still see this work as unassigned; ` +
        `retrying rather than running it unpublished. ` +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
  }
}
