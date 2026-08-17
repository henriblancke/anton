/**
 * The one server-side epic dependency rollup. Both the Dependencies DAG page and the board's
 * blocked-badges/sort consume this, so epic→epic sequencing is derived once and correctly from
 * beads — never re-implemented per view. Read-only: it derives edges, it never writes them.
 *
 * Only `blocks` drives ordering. Every blocks edge is rolled up to its run target — the nearest
 * self-or-ancestor unit (see isUnit) — so a direct epic→epic block, a ticket-level block across two
 * epics, and a task-under-a-feature block all produce an edge between the units that actually ship.
 * related / discovered-from / parent-child never create ordering. The same rollup also reports each
 * run target's per-child readiness (see ChildReadiness), so "one gated tail child" and "nothing can
 * run" are one derivation apart instead of one conflated `blockedBy`. Direction mirrors
 * beads.edgesOf + dependency-graph.tsx (source=from=the blocked/dependent side, target=to=the
 * blocker) so both graphs read the same way.
 */
import { beads, type Bead } from "./beads/bd";
import { isPipelineArtifact } from "./beads/contract";
import { boardCards, deriveStage, isRunTicket } from "./ticket-view";
import type { Stage } from "./types";

/** Missing bead priority sorts after every explicit priority (bd uses 0=critical … 4=lowest). */
const DEFAULT_PRIORITY = 4;

/**
 * How much of a run target's work is actually runnable right now (anton-nywj).
 * `ready` — nothing outside this run is holding any ticket; `partially-blocked` — some tickets are
 * held but at least one can run; `blocked` — zero runnable tickets. The rollup's unit-level
 * `blockedBy` can't tell the last two apart: one cross-run-gated tail child makes the whole target
 * read blocked, which is what stalled a target whose other children were independent (issue #58).
 */
export type ChildReadiness = "ready" | "partially-blocked" | "blocked";

export interface EpicGraphNode {
  id: string;
  title: string;
  status: string; // raw bead status
  stage: Stage;
  priority: number;
  createdAt: string; // ISO timestamp
  /** Unit ids that currently block this one — a blocker counts only while its own unit isn't done. */
  blockedBy: string[];
  /** No open blockers. */
  ready: boolean;
  /** Topological rank (0 = no blockers). Degrades to a priority/created ordering on a cycle. */
  rank: number;
  /**
   * The tickets this run would dispatch that nothing outside it holds — dispatchable now, in board
   * order. A leaf target (a feature with no tickets shaped under it) IS its own ticket, so it
   * reports itself here; closed tickets are in neither set (the run skips them).
   */
  readyChildren: string[];
  /** The tickets held by an open blocker outside this run, or queued behind such a ticket. */
  blockedChildren: string[];
  /** ready / partially-blocked / blocked over those two sets — see {@link ChildReadiness}. */
  childReadiness: ChildReadiness;
}

export interface EpicGraphEdge {
  /** The blocked (dependent) unit — matches the beads/dependency-graph "blocks" direction. */
  from: string;
  /** The blocker unit. */
  to: string;
  /** The raw blocks edge already ran between two units (epic→epic, feature→feature, …). */
  direct: boolean;
  /** A ticket-level blocks edge, rolled up to its unit, produced this pair. */
  inferred: boolean;
  /** Part of a detected dependency cycle (see EpicGraph.hasCycle). */
  inCycle: boolean;
}

export interface EpicGraph {
  /** One node per rollup unit — every `feature` and every `epic` (see isUnit). */
  epics: EpicGraphNode[];
  edges: EpicGraphEdge[];
  /** True when the epic blocks-graph contains at least one cycle. */
  hasCycle: boolean;
}

/**
 * A rollup unit — a bead that can carry a node in this graph. Every `feature` (the run target under
 * the tier split: one worktree, one PR) and every `epic` (a legacy run target; a container epic is
 * not itself runnable but still carries epic→epic sequencing, so it keeps its node rather than
 * dropping its dependencies on the floor). A parentless task/bug is a run target too, but
 * deliberately NOT a unit: it has no node here, and `standaloneBlockers` derives its readiness from
 * its own edges instead.
 */
export function isUnit(b: Bead): boolean {
  return beads.isEpic(b) || b.issue_type === "feature";
}

/**
 * The rollup itself: the unit a bead's work ships in — its nearest self-or-ancestor unit. Walks the
 * whole parent chain, so in a three-level tree (epic → feature → task) a task attributes to its
 * FEATURE; a single hop attributed it to nothing and silently dropped the edge. undefined when no
 * unit ancestor exists (an unknown bead, or a task under a parentless task/bug), i.e. when the edge
 * can't be attributed to any node in this graph. Guards against a malformed parent cycle.
 *
 * Pipeline plumbing ships in NO unit, and neither does anything under it (anton-ve2r): a poured
 * molecule root can be parented under a feature, and attributing its gates and steps to that
 * feature would turn "step awaiting a human" into "feature A blocks feature B". A gate gates on
 * ITSELF — resolved (closed) ⇒ no longer blocking — which is exactly what the standalone-blocker
 * helpers below do with an unattributable blocker.
 */
function runTargetResolver(all: Bead[]): (id: string) => string | undefined {
  const byId = new Map(all.map((b) => [b.id, b]));
  return (id: string) => {
    const seen = new Set<string>();
    let b = byId.get(id);
    while (b && !seen.has(b.id)) {
      if (isPipelineArtifact(b)) return undefined;
      if (isUnit(b)) return b.id;
      seen.add(b.id);
      const parent = beads.parentOf(b);
      b = parent ? byId.get(parent) : undefined;
    }
    return undefined;
  };
}

/**
 * Derive the epic dependency graph from a full bead list (e.g. `listAllBeads` / `bd list --json`,
 * which carries each bead's parent + inline dependencies). Pure over its input — no bd spawn.
 */
export function computeEpicGraph(all: Bead[]): EpicGraph {
  const runTargetOf = runTargetResolver(all);
  const unitBeads = all.filter(isUnit);
  const unitIds = new Set(unitBeads.map((b) => b.id));

  // Roll every blocks edge up to its unit: keep only cross-unit pairs, dedupe by pair, drop
  // self-edges. A pair is `direct` when both raw endpoints were already units, `inferred` otherwise.
  const edgeMap = new Map<string, EpicGraphEdge>();
  for (const e of beads.edgesOf(all)) {
    if (e.type !== "blocks") continue;
    const from = runTargetOf(e.from);
    const to = runTargetOf(e.to);
    if (!from || !to || from === to) continue;
    const direct = unitIds.has(e.from) && unitIds.has(e.to);
    // JSON-encoded pair: unambiguous for any id content, and keeps this file plain text
    // (a raw NUL delimiter here once made git classify the whole module as binary).
    const key = JSON.stringify([from, to]);
    const existing = edgeMap.get(key);
    if (existing) {
      existing.direct ||= direct;
      existing.inferred ||= !direct;
    } else {
      edgeMap.set(key, { from, to, direct, inferred: !direct, inCycle: false });
    }
  }
  const edges = [...edgeMap.values()];

  const stageOf = new Map(unitBeads.map((b) => [b.id, deriveStage(b)]));

  // blockedBy: e.from is blocked by e.to; count the blocker only while its unit isn't done.
  const blockedBy = new Map<string, string[]>(unitBeads.map((b) => [b.id, []]));
  for (const e of edges) {
    if (stageOf.get(e.to) === "done") continue;
    blockedBy.get(e.from)?.push(e.to);
  }

  // Topological rank via Kahn's longest-path: a blocker (e.to) precedes what it blocks (e.from).
  const indeg = new Map<string, number>(unitBeads.map((b) => [b.id, 0]));
  const successors = new Map<string, string[]>(unitBeads.map((b) => [b.id, []]));
  for (const e of edges) {
    successors.get(e.to)?.push(e.from);
    indeg.set(e.from, (indeg.get(e.from) ?? 0) + 1);
  }
  const rank = new Map<string, number>();
  const queue: string[] = [];
  for (const id of unitIds) {
    if ((indeg.get(id) ?? 0) === 0) {
      rank.set(id, 0);
      queue.push(id);
    }
  }
  const settled = new Set<string>();
  while (queue.length) {
    const blocker = queue.shift() as string;
    settled.add(blocker);
    for (const blocked of successors.get(blocker) ?? []) {
      rank.set(blocked, Math.max(rank.get(blocked) ?? 0, (rank.get(blocker) ?? 0) + 1));
      const next = (indeg.get(blocked) ?? 0) - 1;
      indeg.set(blocked, next);
      if (next === 0) queue.push(blocked);
    }
  }

  const hasCycle = settled.size < unitIds.size;
  if (hasCycle) {
    // Flag every edge tangled in the unresolved region and degrade rank to a stable
    // priority-then-created ordering so the sequence is still meaningful without throwing.
    for (const e of edges) {
      if (!settled.has(e.from) && !settled.has(e.to)) e.inCycle = true;
    }
    const ordered = [...unitBeads].sort(compareByPriorityThenCreated);
    ordered.forEach((b, i) => rank.set(b.id, i));
  }

  const childReadiness = computeChildReadiness(all, unitBeads, runTargetOf);

  const epics: EpicGraphNode[] = unitBeads
    .map((b): EpicGraphNode => {
      const blockers = blockedBy.get(b.id) ?? [];
      const children = childReadiness.get(b.id) as ChildReadinessResult;
      return {
        id: b.id,
        title: b.title,
        status: b.status,
        stage: stageOf.get(b.id) ?? "backlog",
        priority: b.priority ?? DEFAULT_PRIORITY,
        createdAt: b.created_at ?? "",
        blockedBy: blockers,
        ready: blockers.length === 0,
        rank: rank.get(b.id) ?? 0,
        readyChildren: children.readyChildren,
        blockedChildren: children.blockedChildren,
        childReadiness: children.childReadiness,
      };
    })
    .sort((a, b) => a.rank - b.rank || a.priority - b.priority || (a.id < b.id ? -1 : 1));

  return { epics, edges, hasCycle };
}

interface ChildReadinessResult {
  readyChildren: string[];
  blockedChildren: string[];
  childReadiness: ChildReadiness;
}

/**
 * Per-run-target child readiness — the primitive that tells "one gated tail child" apart from
 * "nothing can run" (anton-nywj). The unit-level `blockedBy` above answers a coarser question: it
 * rolls every child's cross-run block up to the target, so a target whose other children are
 * independent still reads fully blocked, and every consumer stalls the whole run (issue #58).
 *
 * A ticket is held when a blocker OUTSIDE this run is still open — gated on the run target that
 * ships that blocker (a child closes at commit, but its code lands only when its target's PR merges,
 * matching {@link standaloneBlockers}), with an unknown blocker read as open (fail safe). A blocker
 * INSIDE the run is ordering, not a gate: the run's own ticket loop produces it, so it holds its
 * dependent only while it is itself held — propagated transitively, so a ticket queued behind a
 * gated sibling is never reported runnable.
 *
 * The target's own `blocks` edges gate every ticket in it: nothing in the run may start ahead of the
 * target's prerequisite.
 */
function computeChildReadiness(
  all: Bead[],
  unitBeads: Bead[],
  runTargetOf: (id: string) => string | undefined,
): Map<string, ChildReadinessResult> {
  const byId = new Map(all.map((b) => [b.id, b]));
  const isDone = (id: string): boolean => {
    const b = byId.get(id);
    return b !== undefined && deriveStage(b) === "done";
  };

  // `runTickets` for every unit in ONE pass — the same working-layer subtree the run dispatches and
  // the board counts, so readiness is reported over exactly the tickets that will run.
  const cards = boardCards(all);
  const ticketsOf = new Map<string, Bead[]>(unitBeads.map((b) => [b.id, []]));
  for (const b of all) {
    if (!isRunTicket(b, cards)) continue;
    const card = cards.cardOf(b);
    if (card !== undefined) ticketsOf.get(card)?.push(b);
  }

  const blockersOf = new Map<string, string[]>();
  for (const e of beads.edgesOf(all)) {
    if (e.type !== "blocks") continue;
    const existing = blockersOf.get(e.from);
    if (existing) existing.push(e.to);
    else blockersOf.set(e.from, [e.to]);
  }

  const readiness = new Map<string, ChildReadinessResult>();
  for (const unit of unitBeads) {
    const tickets = ticketsOf.get(unit.id) ?? [];
    // Same shape rule the run uses: a leaf target (a feature with nothing shaped under it) IS its
    // own single ticket, so it reports itself rather than an empty, unreadable set.
    const work = (beads.groupsChildren(unit, tickets) ? tickets : [unit]).filter(
      (b) => deriveStage(b) !== "done",
    );
    const workIds = new Set(work.map((b) => b.id));

    const heldExternally = (blockerId: string): boolean => {
      if (isOwnMergeWait(byId.get(blockerId))) return false; // the target's own PR, not a prerequisite
      const gate = runTargetOf(blockerId) ?? blockerId;
      if (gate === unit.id) return false; // inside this run — ordering, handled below
      return !isDone(gate);
    };
    const unitHeld = (blockersOf.get(unit.id) ?? []).some(heldExternally);

    const heldOutside = (b: Bead): boolean =>
      (blockersOf.get(b.id) ?? []).some(heldExternally);
    const blocked = new Set<string>(
      unitHeld ? workIds : work.filter(heldOutside).map((b) => b.id),
    );
    for (let grew = true; grew; ) {
      grew = false;
      for (const b of work) {
        if (blocked.has(b.id)) continue;
        if ((blockersOf.get(b.id) ?? []).some((id) => workIds.has(id) && blocked.has(id))) {
          blocked.add(b.id);
          grew = true;
        }
      }
    }

    const readyChildren = work.filter((b) => !blocked.has(b.id)).map((b) => b.id);
    const blockedChildren = work.filter((b) => blocked.has(b.id)).map((b) => b.id);
    readiness.set(unit.id, {
      readyChildren,
      blockedChildren,
      // Nothing left to dispatch (every ticket closed, or an epic with none shaped) reports the
      // TARGET's own gate: an empty set must never read as runnable while the target itself is held.
      childReadiness:
        work.length === 0
          ? unitHeld
            ? "blocked"
            : "ready"
          : readyChildren.length === 0
            ? "blocked"
            : blockedChildren.length === 0
              ? "ready"
              : "partially-blocked",
    });
  }
  return readiness;
}

/**
 * Open blockers of a standalone run target — a parentless task/bug run as an epic-of-one. The
 * graph above carries only unit nodes, so a standalone target never appears there and its
 * readiness can't be read from `computeEpicGraph`; derive it directly from the target's own
 * `blocks` edges. A blocker counts only while it isn't done (matching the unit-level rollup), so a
 * closed prerequisite stops blocking. A child blocker is rolled up to the unit that ships it and
 * gated on that unit (a child closes at commit, but its code only lands when its unit's PR merges),
 * matching computeEpicGraph — so the returned ids may be feature/epic ids. Returns the open blocker
 * ids, deduped (empty ⇒ ready). Shared by the approve route and execute-epic so a standalone target
 * is gated exactly the way `bd ready` would keep it blocked — never enqueued/started before its
 * prerequisite lands.
 */
export function standaloneBlockers(all: Bead[], id: string): string[] {
  const byId = new Map(all.map((b) => [b.id, b]));
  const runTargetOf = runTargetResolver(all);

  // The bead whose `done` actually satisfies a blocker. A child ticket is closed the moment its code
  // commits, but that code only lands on the base branch when its RUN TARGET's single PR MERGES —
  // so gating on the raw child would release this target too early. Mirror computeEpicGraph's
  // rollup: resolve a child blocker to the unit that ships it (a task under a feature gates on the
  // feature, not on the epic above it). A unit or an unattributable blocker gates on itself (it
  // already stays in-review until its own PR merges).
  const gateOf = (blockerId: string): string => runTargetOf(blockerId) ?? blockerId;

  const open = new Set<string>();
  for (const e of beads.edgesOf(all)) {
    // A `blocks` edge is (from = dependent, to = blocker); this bead is blocked by `to`.
    if (e.type !== "blocks" || e.from !== id) continue;
    if (isOwnMergeWait(byId.get(e.to))) continue;
    const gate = gateOf(e.to);
    const gateBead = byId.get(gate);
    // An unknown blocker (absent from the list) is treated as still open — fail safe.
    if (!gateBead || deriveStage(gateBead) !== "done") open.add(gate);
  }
  return [...open];
}

/**
 * Is this blocker the blocked bead's OWN merge wait rather than a prerequisite? A `gh:pr` gate
 * (anton-k0kj) awaits the pull request the blocked bead itself opened, so counting it as a blocker
 * would say a target is waiting on itself: its Force/recovery run would be refused (approve 409s,
 * execute-epic poisons) for as long as the gate is open — and bd leaves a gh:pr gate open FOREVER
 * when its PR is closed without merging, which is exactly the state the recovery run exists to fix.
 *
 * Narrow on purpose: only `gh:pr`. A `human` or `timer` gate is a real wait someone put in front of
 * the work and keeps blocking. `undefined` (a blocker absent from the board read) is not a gate we
 * can classify, so it stays a blocker under the fail-safe.
 */
function isOwnMergeWait(blocker: Bead | undefined): boolean {
  return blocker !== undefined && beads.isMergeWaitGate(blocker);
}

/**
 * Open standalone blockers of a graph unit (epic or feature) — parentless task/bug prerequisites the
 * unit, or any bead that rolls up to it, `blocks`-depends on. computeEpicGraph rolls every blocks
 * edge up to its unit and DROPS any whose blocker endpoint has no unit ancestor, so such a blocker
 * never lands in the unit's `blockedBy`/`ready`. This recovers exactly that dropped set, so the
 * approve route + execute-epic can gate a unit on an open standalone prerequisite the same way
 * `standaloneBlockers` gates a standalone target. The ids returned are disjoint from
 * computeEpicGraph's `blockedBy` (those are unit ids; these are ids the rollup can't attribute), so
 * callers concatenate the two lists without double-counting. Returns open blocker ids, deduped.
 */
export function epicStandaloneBlockers(all: Bead[], epicId: string): string[] {
  const byId = new Map(all.map((b) => [b.id, b]));
  const epicBead = byId.get(epicId);
  if (!epicBead || !isUnit(epicBead)) return [];

  const runTargetOf = runTargetResolver(all);
  // The endpoints whose blocks edges roll up to THIS unit in the graph — the unit itself plus the
  // beads under it that no nearer unit claims (a feature child owns its own subtree, so its
  // blockers gate the feature, not the epic above it).
  const members = new Set(all.filter((b) => runTargetOf(b.id) === epicId).map((b) => b.id));

  const open = new Set<string>();
  for (const e of beads.edgesOf(all)) {
    if (e.type !== "blocks" || !members.has(e.from)) continue;
    if (isOwnMergeWait(byId.get(e.to))) continue; // the unit's own PR, not a prerequisite
    // Anything the rollup CAN attribute is already an edge in the graph — skip it here or it would
    // be counted twice. An unknown blocker (absent from the list) is unattributable too, so it is
    // recovered here and treated as still open (fail safe).
    if (runTargetOf(e.to) !== undefined) continue;
    const blocker = byId.get(e.to);
    if (!blocker || deriveStage(blocker) !== "done") open.add(e.to);
  }
  return [...open];
}

function compareByPriorityThenCreated(a: Bead, b: Bead): number {
  const pa = a.priority ?? DEFAULT_PRIORITY;
  const pb = b.priority ?? DEFAULT_PRIORITY;
  if (pa !== pb) return pa - pb;
  const ca = a.created_at ?? "";
  const cb = b.created_at ?? "";
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}
