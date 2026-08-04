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
import { isPipelineArtifact } from "../beads/contract";
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
  /**
   * Is `blockerId` recorded as a DIRECT blocker of `id`? Directed and direct, unlike both
   * {@link hasBlocksEdge} (undirected) and {@link isBlockedBy} (transitive). Asked in the one place
   * the direction decides the OUTCOME rather than safety: a proposal may only settle as "already
   * recorded" against the edge it actually asked for — the reverse edge is a contradiction to hand
   * back to a human, not the ask half-done.
   */
  recordsBlocker(id: string, blockerId: string): boolean;
  /**
   * Is `id` already blocked by `blockerId`, directly or through any chain of `blocks` edges?
   * DIRECTED, unlike {@link hasBlocksEdge}, and asked in the one place direction decides safety:
   * recording "X blocks Y" when X is itself already waiting on Y closes a dependency cycle, and bd
   * rejects cycles at every write path (bd-hygiene.integration.test.ts) — so a proposal that only
   * looked at the direct pair could be approved into a 500 and never apply.
   */
  isBlockedBy(id: string, blockerId: string): boolean;
  /**
   * Does the board record `id` as superseded BY `replacementId` — the directed edge `bd supersede`
   * writes alongside the close? A supersede's claim is narrower than "this bead settled": it names
   * WHERE the work landed, and this edge is the only thing that carries that. Asked at approve time,
   * because a subject closed by any other means since the filing carries no such pointer.
   */
  recordsSupersedes(id: string, replacementId: string): boolean;
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
  // The same edges, kept DIRECTED: `from` depends on `to` (bd's `blocks` edge points at the blocker,
  // matching beads.unblocksCount), which is what makes reachability — and so cycle detection —
  // answerable at all. A Set per bead so a direct-blocker lookup costs the same as every other edge
  // question here.
  const blockers = new Map<string, Set<string>>();
  // `bd supersede <id> --with <replacement>` writes (from = the superseded bead, to = the survivor).
  const supersedes = new Set<string>();
  const discoveries: Discovery[] = [];
  for (const edge of beads.edgesOf(all)) {
    if (edge.type === "blocks") {
      blocks.add(pairKey(edge.from, edge.to));
      const known = blockers.get(edge.from);
      if (known) known.add(edge.to);
      else blockers.set(edge.from, new Set([edge.to]));
    } else if (edge.type === "supersedes") {
      supersedes.add(directedKey(edge.from, edge.to));
    } else if (edge.type === "discovered-from") {
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
    recordsBlocker: (id, blockerId) => blockers.get(id)?.has(blockerId) ?? false,
    isBlockedBy: (id, blockerId) => {
      // Walks blocker-ward from `id`; `seen` also guards a graph that ALREADY holds a cycle (a merge
      // can leave one, see beads.depCycles), which must not spin this walk forever.
      const seen = new Set<string>([id]);
      const queue = [...(blockers.get(id) ?? [])];
      while (queue.length > 0) {
        const next = queue.shift() as string;
        if (next === blockerId) return true;
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(...(blockers.get(next) ?? []));
      }
      return false;
    },
    recordsSupersedes: (id, replacementId) => supersedes.has(directedKey(id, replacementId)),
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

/**
 * Directed edge key — unlike {@link pairKey}, `a → b` and `b → a` are different edges. The separator
 * is NUL, which no bead id can contain, so no two distinct pairs can collide on one key.
 */
function directedKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

/** A bead the board still holds as work to do. */
export function isOpenWork(bead: Bead): boolean {
  return bead.status !== "closed" && !beads.isAbandoned(bead);
}

/**
 * Is a run touching this bead right now — an unexpired run-lease, or a commit already on a branch
 * waiting for its PR? Never a proposal subject: the runner is mid-flight over it, and a proposal to
 * re-parent or retire work that is actively shipping would race the run that owns it.
 *
 * Answered from the bead ALONE, which is exactly what it cannot answer for a run's child tickets:
 * see {@link ticketOwnerOf} for the other half.
 */
export function isInFlight(bead: Bead, nowMs: number): boolean {
  return beads.isRunLive(bead, nowMs) || deriveStage(bead) === "in-review";
}

/**
 * The RUN TARGET whose ticket set this bead rides, or undefined when the bead is its own run target
 * (its own signals are then the whole answer) or hangs under nothing that runs.
 *
 * {@link isInFlight} is blind here by construction: a grouped run publishes ONE run-lease, on the
 * target its tickets hang under, and cascades only an assignee to the children it has selected — so
 * a not-yet-reached ticket of a live feature carries no lease, no PR ref and no claim, and reads as
 * free work to every per-bead signal. Acting on it anyway pulls a bead out of a set that run has
 * already selected, and the run aborts when its claim reaches a bead the board no longer holds.
 *
 * Resolved through `beads.isRunTarget` — the same predicate execute-epic and the approve route run
 * on — rather than through {@link BoardIndex.cards}, which is narrower: a parentless task/bug runs
 * without ever being a board card.
 */
export function ticketOwnerOf(index: BoardIndex, bead: Bead): Bead | undefined {
  const seen = new Set<string>();
  let current: Bead | undefined = bead;
  while (current && !seen.has(current.id)) {
    // Plumbing coordinates work rather than running it, and nothing above it runs this bead either.
    if (isPipelineArtifact(current)) return undefined;
    if (beads.isRunTarget(current, index.all)) return current.id === bead.id ? undefined : current;
    seen.add(current.id);
    const parent = beads.parentOf(current);
    current = parent ? index.byId.get(parent) : undefined;
  }
  return undefined;
}

/** bd's last-write stamp, falling back to creation — a bead carrying neither is simply undated. */
export function stampOf(bead: Bead): string | undefined {
  const updated = bead.updated_at;
  if (typeof updated === "string" && updated) return updated;
  return typeof bead.created_at === "string" && bead.created_at ? bead.created_at : undefined;
}

/**
 * The same stamp as epoch ms, or undefined when it is missing or unparseable. Both tiers ask WHEN a
 * bead was last written — the detectors to measure silence, apply to date a claim against the moment
 * its proposal was filed — so the parse lives in one place.
 */
export function stampMsOf(bead: Bead): number | undefined {
  const stamp = stampOf(bead);
  if (!stamp) return undefined;
  const at = Date.parse(stamp);
  return Number.isFinite(at) ? at : undefined;
}

const DAY_MS = 86_400_000;

/**
 * Whole days since the bead was last written, or undefined when it carries no readable stamp. An
 * undated bead yields NO age rather than a zero: "we can't measure this" must never read as "touched
 * today", which would silently exempt exactly the oldest rows from every age-gated detector.
 */
export function ageInDays(bead: Bead, nowMs: number): number | undefined {
  const at = stampMsOf(bead);
  return at === undefined ? undefined : Math.floor((nowMs - at) / DAY_MS);
}
