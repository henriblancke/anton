/**
 * The board read every detector shares (anton-02oc): parentage, edges and card attribution derived
 * ONCE from a `bd list --json` snapshot, so four detectors walking the same board don't each rebuild
 * the same maps — and, more importantly, can't each answer "is this a card?" slightly differently.
 *
 * Card attribution comes from `boardCards` (src/lib/ticket-view.ts), which is what the BOARD itself
 * renders from. That sharing is the point: a detector that re-implemented "rides no card" would
 * eventually propose re-parenting beads the board shows perfectly well, or miss the ones it hides.
 */
import { beads, type Bead } from "../beads/bd";
import { boardCards, deriveStage, type BoardCards } from "../ticket-view";

/** A `discovered-from` edge: `discovered` was filed while working on `source`. */
export interface Discovery {
  discovered: string;
  source: string;
}

export interface BoardIndex {
  /** The snapshot itself — closed beads included; container-ness is read off the whole graph. */
  all: Bead[];
  byId: Map<string, Bead>;
  cards: BoardCards;
  /** Direct children of a bead, in board order. */
  childrenOf(id: string): Bead[];
  /**
   * Every still-open bead beneath this one, at any depth. Retirement asks this before it settles a
   * bead: closing a parent with open children leaves them hanging off a card nothing will ever run,
   * which is the same unreachable state `detectContainerOrphans` exists to flag.
   */
  openDescendants(id: string): Bead[];
  /**
   * Is there a `blocks` edge between these two, in EITHER direction? Undirected on purpose: a
   * backwards edge is a contradiction, not a gap, and proposing the reverse of an edge someone
   * already drew would fight a human's recorded decision.
   */
  hasBlocksEdge(a: string, b: string): boolean;
  discoveries: Discovery[];
  /** Is `ancestorId` this bead, or anywhere on its parent chain? Cycle-guarded. */
  isAncestor(ancestorId: string, id: string): boolean;
  /** An epic that groups run targets rather than being one (`beads.isContainer`, board-wide). */
  isContainer(bead: Bead): boolean;
}

export function indexBoard(all: Bead[]): BoardIndex {
  const byId = new Map(all.map((b) => [b.id, b]));

  const children = new Map<string, Bead[]>();
  for (const bead of all) {
    const parent = beads.parentOf(bead);
    if (!parent) continue;
    const siblings = children.get(parent);
    if (siblings) siblings.push(bead);
    else children.set(parent, [bead]);
  }

  const blocks = new Set<string>();
  const discoveries: Discovery[] = [];
  for (const edge of beads.edgesOf(all)) {
    if (edge.type === "blocks") blocks.add(pairKey(edge.from, edge.to));
    else if (edge.type === "discovered-from") {
      discoveries.push({ discovered: edge.from, source: edge.to });
    }
  }

  const childrenOf = (id: string): Bead[] => children.get(id) ?? [];

  return {
    all,
    byId,
    cards: boardCards(all),
    childrenOf,
    openDescendants: (id) => {
      const found: Bead[] = [];
      const seen = new Set<string>([id]);
      const queue = [...childrenOf(id)];
      while (queue.length > 0) {
        const bead = queue.shift() as Bead;
        if (seen.has(bead.id)) continue; // a parent cycle must not spin this walk forever
        seen.add(bead.id);
        if (isOpenWork(bead)) found.push(bead);
        queue.push(...childrenOf(bead.id));
      }
      return found;
    },
    hasBlocksEdge: (a, b) => blocks.has(pairKey(a, b)),
    discoveries,
    isAncestor: (ancestorId, id) => {
      const seen = new Set<string>();
      let current: string | undefined = id;
      while (current && !seen.has(current)) {
        if (current === ancestorId) return true;
        seen.add(current);
        const bead = byId.get(current);
        current = bead ? beads.parentOf(bead) : undefined;
      }
      return false;
    },
    isContainer: (bead) => beads.isContainer(bead, all),
  };
}

/** Undirected edge key — `a|b` and `b|a` are the same edge to every question asked here. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** A bead the board still holds as work to do. */
export function isOpenWork(bead: Bead): boolean {
  return bead.status !== "closed" && !beads.isAbandoned(bead);
}

/**
 * Is a run touching this bead right now — an unexpired run-lease, or a commit already on a branch
 * waiting for its PR? Never a proposal subject: the runner is mid-flight over it, and a proposal to
 * re-parent or retire work that is actively shipping would race the run that owns it.
 */
export function isInFlight(bead: Bead, nowMs: number): boolean {
  return beads.isRunLive(bead, nowMs) || deriveStage(bead) === "in-review";
}

/** bd's last-write stamp, falling back to creation — a bead carrying neither is simply undated. */
export function stampOf(bead: Bead): string | undefined {
  const updated = bead.updated_at;
  if (typeof updated === "string" && updated) return updated;
  return typeof bead.created_at === "string" && bead.created_at ? bead.created_at : undefined;
}

const DAY_MS = 86_400_000;

/**
 * Whole days since the bead was last written, or undefined when it carries no readable stamp. An
 * undated bead yields NO age rather than a zero: "we can't measure this" must never read as "touched
 * today", which would silently exempt exactly the oldest rows from every age-gated detector.
 */
export function ageInDays(bead: Bead, nowMs: number): number | undefined {
  const stamp = stampOf(bead);
  if (!stamp) return undefined;
  const at = Date.parse(stamp);
  if (!Number.isFinite(at)) return undefined;
  return Math.floor((nowMs - at) / DAY_MS);
}
