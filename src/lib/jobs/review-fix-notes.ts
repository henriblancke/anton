/**
 * What a preserved ticket's bd note says after a merge finalized without it (anton-67xj). The
 * operator meets this ticket long after the run that skipped it, under a target that now reads as
 * done — so the note has to say what happened to it, where it lives now, and what they must do to
 * get the work picked back up.
 *
 * Three lanes, three different things to tell them: the rerun lane, the post-commit lane (no
 * marker — its work IS in the merged diff), and a ticket whose status is somebody's own decision,
 * which anton neither reruns nor asks a human to review against the branch.
 */
import { beads, LABELS, type Bead } from "../beads/bd";
import type { RehomePlan, Rehomed } from "./review-fix-rehome";

/**
 * What a preserved ticket's setup settled before the rehome detached it, held over so its note can
 * be written afterwards — once the rehome has said where the ticket ended up.
 */
export interface PreservedSetup {
  /** The assignee the sweep read, which the note names when the reservation outlived finalization. */
  owner: string | undefined;
  /** The reservation is still in place: this run's own claim that bd refused to release, or a foreign one. */
  stillOwned: boolean;
  /** That reservation belongs to someone other than the run — deliberately left alone. */
  foreignOwner: boolean;
  /**
   * The board moved this ticket on (another target, or a state change in place), so anton left its
   * claim alone whoever it names — under project concurrency the same actor string can be a second
   * run's live reservation.
   */
  heldElsewhere: boolean;
  /** The sentence the note adds when the ticket did not reach a claimable status (empty once it did). */
  statusNote: string;
}

/** Everything one preserved ticket's note is written from. */
export interface PreservedNoteArgs {
  epic: Bead;
  /** The sweep's snapshot of the ticket — the status the note reports is the one the run left. */
  bead: Bead;
  setup: PreservedSetup;
  /** Whether this ticket earned the rerun lane ({@link safeToRerunAtMerge}). */
  rerun: boolean;
  plan: RehomePlan;
  followUp: Rehomed;
}

/** The note itself: one lane, then whatever ownership and status anton could not settle. */
export function preservedNote(args: PreservedNoteArgs): string {
  if (!args.rerun && beads.isNotDelivered(args.bead))
    return decidedElsewhereNote(args);
  if (!args.rerun) return postCommitNote(args);
  return rerunNote(args);
}

/** Undelivered, but in a status somebody else chose — anton queues no rerun on top of that. */
function decidedElsewhereNote(args: PreservedNoteArgs): string {
  const { epic, bead } = args;
  return (
    `anton: the pull request for ${epic.id} merged WITHOUT this ticket — the run did not ` +
    `deliver it (see the note above), so none of its work is in that diff. Its status is ` +
    `\`${bead.status}\`, which is someone's own decision about this ticket rather than ` +
    `the run's, so anton left it under ${epic.id} and did NOT queue it for a rerun. Once ` +
    `that is settled, move it onto a fresh run target ` +
    `(\`bd update ${bead.id} --parent <new-epic>\`) to have anton pick the work back up.` +
    ownershipNote(bead, args.setup, "")
  );
}

/** Stopped after it committed: its work IS in the merged diff, so a rerun would redo it. */
function postCommitNote(args: PreservedNoteArgs): string {
  const { epic, bead } = args;
  return (
    `anton: the pull request for ${epic.id} merged while this ticket was still ` +
    `\`${bead.status}\` — the run stopped it and carried on (see the note above). It ` +
    `is NOT marked \`${LABELS.notDelivered}\`, so whatever it committed before it ` +
    `stopped is in that merged diff. Left on the board rather than closed, and ` +
    `deliberately NOT queued for a rerun: re-running it would redo work the merge ` +
    `already shipped. Review the branch against the note above, then close this by hand ` +
    `if it is complete, or file the remainder as a new ticket.` +
    ownershipNote(bead, args.setup, "")
  );
}

/** Nothing of it shipped: left open on purpose, and told where the rerun now lives. */
function rerunNote(args: PreservedNoteArgs): string {
  const { epic, bead } = args;
  return (
    `anton: the pull request for ${epic.id} merged WITHOUT this ticket — the run did ` +
    `not deliver it (see the note above), so none of its work is in that diff. Left ` +
    `open on purpose: closing it here would file work that was never done as shipped. ` +
    rehomeOutcome(args) +
    ownershipNote(bead, args.setup, ", so no other operator can claim it") +
    args.setup.statusNote
  );
}

/** Where the ticket ended up — in the order the rehome decides it, generic remedy last. */
function rehomeOutcome(args: PreservedNoteArgs): string {
  return (
    decidedByOthersNote(args) ??
    landedNote(args) ??
    heldBackNote(args) ??
    `It could NOT be rehomed onto a fresh run target, so nothing anton runs reaches it ` +
      `yet: move it under a new epic (\`bd update ${args.bead.id} --parent <new-epic>\`) ` +
      `or clear its parent to make it a run target of its own.`
  );
}

/** The plan's verdicts: somebody else owns this ticket now, or anton could not confirm it doesn't. */
function decidedByOthersNote(args: PreservedNoteArgs): string | undefined {
  return takenOverNote(args) ?? unconfirmedNote(args) ?? movedOnNote(args);
}

/** Another operator rehomed it while the PR sat in review — that target owns the work now. */
function takenOverNote(args: PreservedNoteArgs): string | undefined {
  const { bead, plan } = args;
  if (!plan.elsewhere.has(bead.id)) return undefined;
  return (
    `Another operator moved it under ` +
    `${plan.elsewhere.get(bead.id) ?? "a different target"} while the pull ` +
    `request was in review, so anton left it there rather than rehoming it — that ` +
    `target owns this work now.`
  );
}

/** A read anton could not take: nothing was decided, and the next sweep plans the move again. */
function unconfirmedNote(args: PreservedNoteArgs): string | undefined {
  const unknown = args.plan.unknown.get(args.bead.id);
  if (!unknown) return undefined;
  return (
    `It was NOT rehomed: ${unknown}, and anton does not move a ` +
    `ticket it cannot confirm is still this run's. ${args.epic.id} stays open ` +
    `for the next review-fix sweep, which plans the move again against a fresh ` +
    `read — no action is needed unless it keeps saying this.`
  );
}

/** Claimed, closed or snoozed in place since the sweep — somebody's own decision to settle. */
function movedOnNote(args: PreservedNoteArgs): string | undefined {
  const { epic, bead, plan } = args;
  const movedOn = plan.changed.get(bead.id);
  if (!movedOn) return undefined;
  return (
    `Its status is now ${movedOn} — someone's own decision about this ticket ` +
    `rather than the run's, so anton left it under ${epic.id}, status untouched, ` +
    `rather than queueing a rerun on top of it. Once that is settled, ` +
    `move it onto a fresh run target (\`bd update ${bead.id} --parent ` +
    `<new-epic>\`) to have anton pick the work back up.`
  );
}

/** It reached the follow-up — on its own reparent, or riding along on an ancestor's. */
function landedNote(args: PreservedNoteArgs): string | undefined {
  const { bead, followUp } = args;
  if (!followUp.id) return undefined;
  const parent = followUp.nested.get(bead.id);
  if (parent)
    return (
      `It stays nested under ${parent}, which anton moved ` +
      `onto ${followUp.id}, a fresh run target — approve that target to have anton ` +
      `pick this work back up.`
    );
  if (followUp.moved.has(bead.id))
    return (
      `It now lives under ${followUp.id}, a fresh run target — approve that ` +
      `target to have anton pick this work back up.`
    );
  return undefined;
}

/** The move was planned but not made: the board changed under it, or a descendant pinned it. */
function heldBackNote(args: PreservedNoteArgs): string | undefined {
  const { bead, followUp } = args;
  const stale = followUp.stale.get(bead.id);
  if (stale)
    return (
      `It was NOT rehomed: between planning the move and making it, ` +
      `${stale} — so anton left the ticket alone rather ` +
      `than moving work that may no longer be this run's. Settle that, then ` +
      `move it onto a fresh run target if it should still be re-run.`
    );
  const pinned = followUp.pinned.get(bead.id);
  if (pinned)
    return (
      `It was NOT rehomed: ${pinned} still hangs off ` +
      `it, and anton left that ticket where it is — moving this one would ` +
      `have carried it onto a fresh target too. Settle that ticket first, ` +
      `then move this one under a new epic ` +
      `(\`bd update ${bead.id} --parent <new-epic>\`) to have anton pick the ` +
      `work back up.`
    );
  return undefined;
}

/**
 * What a preserved ticket's note says about a reservation finalization did not clear — either an
 * assignee that is not the run's own (deliberately left alone) or this run's own claim that bd
 * refused to release. Silent when ownership is settled. `blocksClaim` is the per-lane consequence
 * clause, since only the rerun lane is stopped by a stale claim.
 */
function ownershipNote(
  bead: Bead,
  setup: PreservedSetup,
  blocksClaim: string,
): string {
  const { owner, stillOwned, foreignOwner, heldElsewhere } = setup;
  if (!stillOwned) return "";
  if (foreignOwner)
    return (
      ` It is also assigned to ${owner}, not to the actor this run reserved it for — anton ` +
      `releases only its own claim, so that reservation was left intact${blocksClaim}. If ` +
      `it is stale, clear it with \`bd assign ${bead.id} ""\`.`
    );
  // Named to the run's own actor, yet deliberately kept: the board moved this ticket on, and under
  // project concurrency the same actor can be a second run reserving it for work it is doing now.
  if (heldElsewhere)
    return (
      ` It is also still assigned to ${owner}, which anton left intact${blocksClaim}: the ` +
      `board moved this ticket on after the run stopped it, so that claim may be the live ` +
      `reservation of whoever owns it now. If it is stale, clear it with ` +
      `\`bd assign ${bead.id} ""\`.`
    );
  return (
    ` It is also still assigned to ${owner} and could not be released${blocksClaim}: clear ` +
    `that with \`bd assign ${bead.id} ""\`.`
  );
}
