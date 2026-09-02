/**
 * What a merge DELIVERED, and what it did not (anton-67xj). A merged PR says the branch shipped,
 * not that every ticket under the run target ran — so finalization asks these three questions of
 * every child before it closes, rehomes or leaves one alone.
 */
import { beads, ownerOf, type Bead } from "../beads/bd";

/** A child whose commit is on the branch — `in_progress` included, see {@link undeliveredAtMerge}. */
const DELIVERED_AT_MERGE = new Set(["closed", "in_progress"]);

/**
 * Delivery evidence: a status that means a commit landed, and no verdict on top of it saying
 * otherwise. An abandoned child is closed but explicitly undelivered (execute-epic drops it from
 * `live` for the same reason), and a `not-delivered` child is the run that passed it over saying
 * so in as many words — neither carries a mechanism for the tickets behind it.
 */
export const deliveredAtMerge = (b: Bead | undefined): boolean =>
  !!b &&
  DELIVERED_AT_MERGE.has(b.status) &&
  !beads.isAbandoned(b) &&
  !beads.isNotDelivered(b);

/**
 * Of the children a merge preserves ({@link undeliveredAtMerge}), the ones anton may hand back to
 * the queue — nothing of theirs can be in the merged diff, so re-running them cannot redo shipped
 * work. Everything else stays on the manual-review path the run's own note already asks for.
 *
 * `not-delivered` is the only positive evidence of absence there is, and a run writes it exactly
 * when it rolled the ticket's work back or never dispatched it — a timeout or a failure that fired
 * AFTER the commit deliberately omits it, because that commit is on the branch. So a `blocked`
 * child without the marker is one whose work the merge may already carry (post-commit timeout,
 * post-commit failure) or one a human must rule on anyway (zero delivery, agent-declared blocked):
 * reopening and rehoming it would advertise a rerun that duplicates or conflicts with the diff.
 *
 * So the lane is an ALLOWLIST of the states that earn a rerun, never "not blocked" (anton-67xj):
 * `open` — a dependent that was never dispatched — and the marker-bearing timed-out ticket whose
 * work was rolled back. That one is normally `blocked`, but need not be: the timeout writes the
 * status best-effort while it RETRIES the marker, so a run whose `blocked` write failed leaves the
 * ticket on the claim it was dispatched under, `in_progress` and marked. Rejecting that shape would
 * strand a ticket with nothing in the diff on the manual-review path over a bookkeeping failure — so
 * it earns the rerun too, but only while the claim is still the dead run's own (or already gone).
 * Any other status a preserved ticket can be in is somebody's own decision about it — a `deferred`
 * snooze, an `in_progress` claim held by another operator — and rehoming or reopening one would
 * overwrite that decision with a rerun nobody asked for.
 */
export const safeToRerunAtMerge = (
  b: Bead,
  runOwner: string | undefined,
): boolean => {
  if (b.status === "open") return true;
  if (!beads.isNotDelivered(b)) return false;
  if (b.status === "blocked") return true;
  const owner = ownerOf(b);
  return (
    b.status === "in_progress" && (owner === undefined || owner === runOwner)
  );
};

/** A child the run itself stopped — the seed of the undelivered set, before its dependents. */
const undeliveredSeed = (b: Bead): boolean =>
  b.status === "blocked" || beads.isNotDelivered(b);

/**
 * Blocker id → the run's own tickets waiting on it. Edges leaving the run are another gate's
 * business: a ticket held on an outside blocker was never in this run's dispatch set.
 */
function blockedDependents(
  children: Bead[],
  byId: Map<string, Bead>,
): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const e of beads.edgesOf(children)) {
    if (e.type !== "blocks" || !byId.has(e.from) || !byId.has(e.to)) continue;
    dependents.set(e.to, [...(dependents.get(e.to) ?? []), e.from]);
  }
  return dependents;
}

/**
 * The children a merged target must NOT close — the tickets its run deliberately left for a human
 * (anton-67xj). A merge says the branch shipped, not that every ticket under the target ran, and
 * closing one that never ran turns the bd note it carries into a pointer at work the board now
 * reads as delivered.
 *
 * Two seeds, one rule. A ticket the run BLOCKED says so in its status — its budget ran out and its
 * work was rolled back (anton-t1mo), or it delivered nothing / self-reported blocked. Two narrower
 * sub-shapes — a timeout that fired after the commit, and a post-commit failure — do leave work on
 * the branch; they are held back for the same reason all the same, because their note asks a human
 * to review and close by hand, not because nothing landed. Held back is as far as it goes for them:
 * {@link safeToRerunAtMerge} keeps them off the rerun path, since their work is in the diff. A
 * ticket the run SKIPPED behind one of those says so in its `not-delivered` label instead: it was
 * never dispatched, so it keeps the `open` status the board keeps offering it under and carries no
 * other mark of its own.
 *
 * Then the transitive closure over the run's own `blocks` edges, which catches what neither seed
 * can — a dependent skipped by a run too old to write the label, or one whose marker never landed.
 *
 * A DELIVERED dependent stops the walk. Its commit is on the branch whatever its blocker did — the
 * run carries on past a timeout, so a ticket behind one still gets dispatched — and the tickets
 * behind IT have the mechanism they were written against. Delivery is `closed`, or `in_progress`:
 * a child close write is best-effort (execute-epic), so a transient bd failure leaves a ticket
 * that committed claimed and mid-stage. Reading that bookkeeping failure as "never ran" would
 * strand shipped work open, when the merge is precisely what repairs it. An ABANDONED child is the
 * exception (deliveredAtMerge): closed on a won't-do, with no commit behind it, so the walk passes
 * straight through to whatever waited on it.
 */
export function undeliveredAtMerge(children: Bead[]): Set<string> {
  const byId = new Map(children.map((c) => [c.id, c]));
  const keep = new Set(children.filter(undeliveredSeed).map((c) => c.id));
  const dependents = blockedDependents(children, byId);
  const queue = [...keep];
  while (queue.length) {
    for (const dependent of dependents.get(queue.shift()!) ?? []) {
      if (keep.has(dependent) || deliveredAtMerge(byId.get(dependent)))
        continue;
      keep.add(dependent); // never revisited, so a cycle terminates
      queue.push(dependent);
    }
  }
  return keep;
}
