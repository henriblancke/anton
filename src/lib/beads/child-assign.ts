/**
 * Feature-tier assignment cascade (anton-0d85) — the write that makes bd's view of a running feature
 * agree with anton's.
 *
 * A run claims its FEATURE, but `bd ready --unassigned` filters on the assignee of each TASK. So a
 * feature in flight kept serving every one of its children to anyone else polling the board: a second
 * anton instance, a headless job, or a plain Claude Code session in another clone. The fix has to be
 * NATIVE rather than an anton-side filter — assign the children to the claiming actor and bd's own
 * readiness query excludes them for every worker, including ones that have never heard of anton.
 *
 * Assignment is a RESERVATION, never a status change (`bd assign`, not `bd update --claim`): a child
 * that hasn't been dispatched yet must stay `open` so the board still derives it as backlog, and so
 * the run's own per-ticket claim stays the one thing that marks a ticket in flight.
 *
 * Every write goes through the claim guard's compare-and-swap ({@link ClaimGuard.setAssigneeIfOwner}),
 * which re-reads the assignee inside the bead's write lock. That is what makes the two halves honest:
 * a child a human reserved is REPORTED and left alone rather than clobbered, and a release gives back
 * only the children this run still holds — never one someone else has taken in the meantime.
 */
import { beads, type Bead } from "./bd";
import { claimGuard, type ClaimGuard } from "./claim";

/** A child left untouched because a different actor holds it. */
export interface ReservedChild {
  id: string;
  owner: string;
}

/** A child whose reservation write failed, with bd's own reason. */
export interface FailedChild {
  id: string;
  error: string;
}

/** What a cascade did: what the run now holds, what it deliberately did not touch, what broke. */
export interface ChildAssignment {
  /** Children the run holds — exactly the set {@link releaseChildren} hands back. */
  held: string[];
  /** Children a different actor reserved: reported to the operator, never overwritten. */
  reserved: ReservedChild[];
  /**
   * Children whose reservation write failed, so the cascade is INCOMPLETE. Reported rather than
   * thrown: what the cascade did manage to take is still in `held`, and a caller that decides an
   * incomplete cascade must stop the run needs that set to hand it back.
   */
  failed: FailedChild[];
}

/**
 * The children a cascade may touch: everything not already settled. A closed bead is out of
 * `bd ready` on its own, and an abandoned one carries a human's own decision — reserving either
 * would be a write with no effect on who can pick the work up.
 */
export function assignableChildren(children: Bead[]): Bead[] {
  return children.filter((c) => c.status !== "closed" && !beads.isAbandoned(c));
}

/**
 * Reserve every open child of a claimed run target for `actor`.
 *
 * The swap is always attempted against an UNASSIGNED expectation, never against the caller's
 * snapshot: a snapshot owner would be handed to the CAS as "expected" and the write would then
 * legitimately overwrite it — the clobber this cascade must not do. Against `undefined` the three
 * outcomes are exactly the three cases that matter: unheld → reserved for us; already ours (the
 * CAS's no-op short-circuit) → adopted, so a resumed attempt re-takes what a prior one left behind;
 * held by anyone else → reported.
 */
export async function assignChildren(
  repoPath: string,
  children: Bead[],
  actor: string,
  guard: ClaimGuard = claimGuard,
): Promise<ChildAssignment> {
  const held: string[] = [];
  const reserved: ReservedChild[] = [];
  const failed: FailedChild[] = [];
  for (const child of assignableChildren(children)) {
    const swap = await guard
      .setAssigneeIfOwner(repoPath, child.id, undefined, actor)
      .catch((e: unknown) => {
        failed.push({ id: child.id, error: e instanceof Error ? e.message : String(e) });
        return null;
      });
    // A refusal with no owner is the CAS's post-write read finding the assignee cleared again by
    // another client. We can't say we hold it, so it is neither held (the release stays honest) nor
    // reported (there is nobody to name).
    if (swap?.ok) held.push(child.id);
    else if (swap && swap.owner) reserved.push({ id: child.id, owner: swap.owner });
  }
  return { held, reserved, failed };
}

/**
 * Hand back the children a stopping run reserved — and only those. The CAS expects `actor`, so a
 * child a human has taken over since is left with its new owner, and one already unassigned costs a
 * read and no write.
 *
 * Returns the ids that are no longer held by this run, for the caller's log. Per-child failures are
 * swallowed: this runs on the stopping path, where one locked bd write must not hide the run's own
 * error or strand the remaining children.
 */
export async function releaseChildren(
  repoPath: string,
  ids: string[],
  actor: string,
  guard: ClaimGuard = claimGuard,
): Promise<string[]> {
  const released: string[] = [];
  for (const id of ids) {
    const swap = await guard.setAssigneeIfOwner(repoPath, id, actor, undefined).catch(() => null);
    if (swap?.ok) released.push(id);
  }
  return released;
}

/** `id → owner` pairs, for the run log line that surfaces what the cascade left alone. */
export function formatReservedChildren(reserved: ReservedChild[]): string {
  return reserved.map((r) => `${r.id} → ${r.owner}`).join(", ");
}
