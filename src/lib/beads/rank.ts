/**
 * The PRIME rank order (anton-higu): the one answer to "which of these runs first?".
 *
 * `.beads/PRIME.md` §1 specifies it — priority → transitive unblocking value → age → id — and
 * specifies it for ANY worker, not just anton: a human at a terminal following that document and a
 * board-picker pass reading the same board must name the same target, or the two disagree about
 * what is next while both believe they are following the protocol. So the order lives here, once,
 * as a pure function, and both the claimable-set query (bd.ts) and the picker's decision module
 * compose it rather than restating it.
 *
 * Leaf module by construction — it imports nothing but the bead shapes. Ranking is a decision, and
 * a decision that could spawn `bd` would not be a function of its inputs.
 */
import type { Bead } from "./types";

/**
 * A target plus the facts it was ranked on, so "why is this next?" is answerable from the value
 * itself rather than by re-deriving the comparator at each consumer.
 */
export interface RankedTarget {
  bead: Bead;
  /**
   * bd priority: 0 = critical … 4 = lowest. `undefined` when the bead carries none, which sorts
   * after every explicit priority — including an explicit P4. Unset is the ABSENCE of a decision,
   * and unranked work must not tie with work somebody deliberately ranked lowest.
   */
  priority?: number;
  /** How many still-waiting beads this target transitively unblocks via `blocks` edges. */
  unblocks: number;
  /** The bead's `created_at`, the age tiebreak (oldest first); "" when bd reported none. */
  createdAt: string;
}

/** Sort key for a bead with no priority: after every real one (bd uses 0=critical … 4=lowest). */
const UNPRIORITIZED = Number.MAX_SAFE_INTEGER;

/** A bead with no `created_at` sorts LAST on the age tiebreak — an unstamped bead must not jump
 *  the queue ahead of work that has genuinely been waiting. */
const UNDATED = "\uffff";

/** `blocker id → the ids it blocks`, from the `blocks` edges bd inlines on each bead. */
function dependentIndex(board: Bead[]): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const bead of board) {
    for (const dep of bead.dependencies ?? []) {
      if (dep?.type !== "blocks" || !dep.issue_id || !dep.depends_on_id) continue;
      const list = dependents.get(dep.depends_on_id);
      if (list) list.push(dep.issue_id);
      else dependents.set(dep.depends_on_id, [dep.issue_id]);
    }
  }
  return dependents;
}

/**
 * `id → how many still-waiting beads it transitively unblocks`, built once per board.
 *
 * A `blocks` edge is (from = dependent, to = blocker), so the dependents of a target are what its
 * completion releases; the count is the transitive closure of that, restricted to beads that are
 * still WAITING. A closed dependent was never waiting, and a `deferred` one is work a human pushed
 * away — counting it would let a target whose whole value is snoozed work outrank one that releases
 * live work. `blocked` and `in_progress` DO count: a transitively blocked dependent is exactly the
 * work being released, and bd reports it under those statuses, not `open`. A bead reached twice —
 * the two arms of a diamond meeting again — is counted once, because finishing the target releases
 * it once.
 *
 * The walk STOPS at a closed or deferred dependent rather than merely declining to count it, so
 * the chain only propagates through beads the target actually holds. Finishing the target cannot
 * release whatever a deferred bead blocks — the deferral still does — and whatever a closed bead
 * blocked, it stopped blocking when it closed. Crediting either downstream would let a target
 * whose reach dead-ends outrank one that releases live work, which is the very thing excluding
 * them from the count is for.
 *
 * `seen` is what makes the walk terminate: a `blocks` cycle is a malformed board, not an
 * impossible one, and a picker that hung on one would take the whole pass down with it. A
 * dependent that isn't on the board is traversed but not counted — it is evidence of an edge, not
 * of open work.
 */
export function unblockCounter(board: Bead[]): (id: string) => number {
  const dependents = dependentIndex(board);
  const waitingIds = new Set<string>();
  const haltIds = new Set<string>();
  for (const b of board) {
    if (b.status === "closed" || b.status === "deferred") haltIds.add(b.id);
    else waitingIds.add(b.id);
  }

  return (id: string): number => {
    const seen = new Set<string>([id]);
    const queue = [id];
    let count = 0;
    while (queue.length) {
      for (const next of dependents.get(queue.shift() as string) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        if (haltIds.has(next)) continue;
        queue.push(next);
        if (waitingIds.has(next)) count++;
      }
    }
    return count;
  };
}

/**
 * The rank order itself — priority, then unblocking value, then age, then id.
 *
 * Total: two distinct beads never compare equal, because the id tiebreak cannot tie. That is not a
 * nicety — a comparator with ties leaves the outcome to the engine's sort, so two machines holding
 * the same board could return different queues and start different work.
 *
 * Age compares the raw `created_at` strings rather than parsed dates: bd emits ISO-8601 in UTC,
 * where lexicographic order IS chronological order, and parsing would make the answer depend on
 * how each machine's runtime reads a malformed stamp. `id` compares by code unit, never
 * `localeCompare`, for the same reason — a locale-sensitive order is not the same order twice.
 */
export function comparePrimeOrder(a: RankedTarget, b: RankedTarget): number {
  const priorityA = a.priority ?? UNPRIORITIZED;
  const priorityB = b.priority ?? UNPRIORITIZED;
  if (priorityA !== priorityB) return priorityA - priorityB; // P0 first, unset last
  if (a.unblocks !== b.unblocks) return b.unblocks - a.unblocks; // frees the most work first
  const ageA = a.createdAt || UNDATED;
  const ageB = b.createdAt || UNDATED;
  if (ageA !== ageB) return ageA < ageB ? -1 : 1; // oldest first
  if (a.bead.id === b.bead.id) return 0;
  return a.bead.id < b.bead.id ? -1 : 1;
}

/**
 * Rank an already-eligible set into the queue anton (or a human following `.beads/PRIME.md`) works
 * top-down. Pure: the same snapshot ranks to the same order, in any input order, every time.
 *
 * `eligible` is what a caller has already decided may be taken — the claimable set (bd.ts) or the
 * picker's policy-narrowed one. This function never re-litigates that; it only orders. `board` is
 * the full `--status all` list, which supplies the `blocks` edges and open/closed states the
 * unblocking count reads — a target's value comes from work that is NOT in the eligible set.
 */
export function rankTargets(eligible: Bead[], board: Bead[]): RankedTarget[] {
  const unblocks = unblockCounter(board);
  return eligible
    .map((bead) => ({
      bead,
      priority: bead.priority ?? undefined,
      unblocks: unblocks(bead.id),
      createdAt: bead.created_at ?? "",
    }))
    .sort(comparePrimeOrder);
}
