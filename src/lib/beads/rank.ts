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

/**
 * The `blocks` edges bd inlines on each bead, indexed both ways in one pass: `blocks` maps a
 * blocker to what it holds (the walk's direction), `heldBy` maps a dependent to everything holding
 * it (what the walk must have released before it may credit that dependent).
 */
function blocksGraph(board: Bead[]): { blocks: Map<string, string[]>; heldBy: Map<string, string[]> } {
  const blocks = new Map<string, string[]>();
  const heldBy = new Map<string, string[]>();
  const push = (index: Map<string, string[]>, key: string, value: string) => {
    const list = index.get(key);
    if (list) list.push(value);
    else index.set(key, [value]);
  };
  for (const bead of board) {
    for (const dep of bead.dependencies ?? []) {
      if (dep?.type !== "blocks" || !dep.issue_id || !dep.depends_on_id) continue;
      push(blocks, dep.depends_on_id, dep.issue_id);
      push(heldBy, dep.issue_id, dep.depends_on_id);
    }
  }
  return { blocks, heldBy };
}

/**
 * What each bead's status means to the walk.
 *
 * `waiting` is the work an unblocking count may credit. A closed dependent was never waiting, and a
 * `deferred` one is work a human pushed away — counting it would let a target whose whole value is
 * snoozed work outrank one that releases live work. `blocked` and `in_progress` DO wait: a
 * transitively blocked dependent is exactly the work being released, and bd reports it under those
 * statuses, not `open`.
 *
 * `halted` is where the walk STOPS rather than merely declining to count, so the chain only
 * propagates through beads the target actually holds. Finishing the target cannot release whatever
 * a deferred bead blocks — the deferral still does — and whatever a closed bead blocked, it stopped
 * blocking when it closed. Crediting either downstream would let a target whose reach dead-ends
 * outrank one that releases live work, which is the very thing excluding them from the count is for.
 */
function walkStates(board: Bead[]): { waiting: Set<string>; halted: Set<string> } {
  const waiting = new Set<string>();
  const halted = new Set<string>();
  for (const bead of board) {
    if (bead.status === "closed" || bead.status === "deferred") halted.add(bead.id);
    else waiting.add(bead.id);
  }
  return { waiting, halted };
}

/**
 * `heldBy` narrowed to the blockers that STILL hold: a closed one let go when it closed, and one
 * absent from this `--status all` snapshot does not exist to hold. A `deferred` blocker keeps its
 * grip — the deferral is a human's "not now", and finishing the target does not lift it.
 */
function stillHeldBy(heldBy: Map<string, string[]>, board: Bead[]): Map<string, string[]> {
  const gripping = new Set(board.filter((b) => b.status !== "closed").map((b) => b.id));
  const still = new Map<string, string[]>();
  for (const [dependent, blockers] of heldBy) {
    const holding = blockers.filter((blocker) => gripping.has(blocker));
    if (holding.length) still.set(dependent, holding);
  }
  return still;
}

/**
 * The closure of a target: the target itself plus every bead finishing it releases.
 *
 * A bead held by two blockers is freed by neither alone, so a dependent enters the closure only
 * once EVERY blocker still gripping it is already inside — reachability is not release. A dependent
 * whose blockers are not all released yet is simply left for the pass that follows the last of
 * them; every released blocker is itself enqueued, so the check runs again after each.
 *
 * The closure set is also what makes the walk terminate: a `blocks` cycle is a malformed board, not
 * an impossible one, and a picker that hung on one would take the whole pass down with it. Each
 * bead enters at most once, so each is enqueued at most once — which is equally why the two arms of
 * a diamond meeting again release their shared tail once.
 */
function releaseClosure(
  target: string,
  blocks: Map<string, string[]>,
  heldBy: Map<string, string[]>,
  halted: Set<string>,
): Set<string> {
  const released = new Set<string>([target]);
  const queue = [target];
  while (queue.length) {
    for (const next of blocks.get(queue.shift() as string) ?? []) {
      if (released.has(next) || halted.has(next)) continue;
      if (!(heldBy.get(next) ?? []).every((holder) => released.has(holder))) continue;
      released.add(next);
      queue.push(next);
    }
  }
  return released;
}

/**
 * `id → how many still-waiting beads it transitively unblocks`, built once per board.
 *
 * A `blocks` edge is (from = dependent, to = blocker), so the dependents of a target are what its
 * completion releases — `releaseClosure` above decides which ones, and this only counts them.
 * Counting on reachability instead would inflate a target that shares a dependent with unrelated
 * open work, and the inflated number outranks a target that genuinely frees something.
 *
 * The target itself is dropped from its own closure: a target does not unblock itself. What is left
 * is counted only where the board says it waits, so a bead that isn't on the board at all is
 * traversed but not counted — it is evidence of an edge, not of open work.
 */
export function unblockCounter(board: Bead[]): (id: string) => number {
  const { blocks, heldBy } = blocksGraph(board);
  const { waiting, halted } = walkStates(board);
  const gripped = stillHeldBy(heldBy, board);

  return (id: string): number => {
    let count = 0;
    for (const released of releaseClosure(id, blocks, gripped, halted)) {
      if (released !== id && waiting.has(released)) count++;
    }
    return count;
  };
}

/**
 * Everything the order sorts on, without the bead — so a surface holding only a projection of a
 * target (the Up Next lane's entries) can ask what the ranking WOULD do without reconstructing one.
 */
export interface PrimeKey {
  id: string;
  /** bd priority; `undefined` sorts after every explicit one, exactly as on {@link RankedTarget}. */
  priority?: number;
  unblocks: number;
  createdAt: string;
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
export function comparePrimeKeys(a: PrimeKey, b: PrimeKey): number {
  const priorityA = a.priority ?? UNPRIORITIZED;
  const priorityB = b.priority ?? UNPRIORITIZED;
  if (priorityA !== priorityB) return priorityA - priorityB; // P0 first, unset last
  if (a.unblocks !== b.unblocks) return b.unblocks - a.unblocks; // frees the most work first
  const ageA = a.createdAt || UNDATED;
  const ageB = b.createdAt || UNDATED;
  if (ageA !== ageB) return ageA < ageB ? -1 : 1; // oldest first
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** {@link comparePrimeKeys} over ranked beads — the comparator `rankTargets` sorts with. */
export function comparePrimeOrder(a: RankedTarget, b: RankedTarget): number {
  return comparePrimeKeys(
    { id: a.bead.id, priority: a.priority, unblocks: a.unblocks, createdAt: a.createdAt },
    { id: b.bead.id, priority: b.priority, unblocks: b.unblocks, createdAt: b.createdAt },
  );
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
