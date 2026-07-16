/**
 * Pure display helpers for the epic board. Kept dependency-free so they're trivially testable
 * (see board-utils.test.ts) and reusable from both the board and card client components.
 */
import { STAGES, type Epic, type Stage, type Ticket } from "@/lib/types";

export const STAGE_LABELS: Record<Stage, string> = {
  backlog: "Backlog",
  implementing: "Implementing",
  "in-review": "In-review",
  done: "Done",
};

/** Per-stage accent dot color — theme-aware semantic tokens from the Atelier design system. */
export const STAGE_ACCENT_DOT: Record<Stage, string> = {
  backlog: "bg-stage-backlog",
  implementing: "bg-stage-implementing",
  "in-review": "bg-stage-in-review",
  done: "bg-stage-done",
};

/** Inset left-border color per stage — mirrors the board card's `box-shadow: inset 2px 0`. */
export const STAGE_INSET_SHADOW: Record<Stage, string> = {
  backlog: "shadow-[inset_2px_0_0_var(--stage-backlog)]",
  implementing: "shadow-[inset_2px_0_0_var(--stage-implementing)]",
  "in-review": "shadow-[inset_2px_0_0_var(--stage-in-review)]",
  done: "shadow-[inset_2px_0_0_var(--stage-done)]",
};

/** Left-border color per stage — used by dependency-graph nodes (`border-l-3`). */
export const STAGE_BORDER_LEFT: Record<Stage, string> = {
  backlog: "border-l-stage-backlog",
  implementing: "border-l-stage-implementing",
  "in-review": "border-l-stage-in-review",
  done: "border-l-stage-done",
};

/** Dot color per agent tag — a stable, warm-matched hue so an agent reads at a glance.
 * Falls back to the neutral subtle color for unknown/absent agents. */
export function agentDotClass(agent?: string): string {
  switch (agent) {
    case "fastapi":
      return "bg-agent-fastapi";
    case "supabase":
      return "bg-agent-supabase";
    case "pydantic":
      return "bg-agent-pydantic";
    case "terraform":
      return "bg-agent-terraform";
    case "docker":
      return "bg-agent-docker";
    case "kubernetes":
      return "bg-agent-kubernetes";
    default:
      return "bg-subtle";
  }
}

/** Ticket completion for an epic: how many of its tickets are `done`, and the total. */
export function ticketProgress(epic: { tickets: Ticket[] }): {
  done: number;
  total: number;
  pct: number;
} {
  const total = epic.tickets.length;
  const done = epic.tickets.filter((t) => t.stage === "done").length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return { done, total, pct };
}

/**
 * Dependency-aware backlog order, shared by the server board build (board.ts) and the client
 * optimistic reconcile so both agree on one order: ready epics first, then topological rank (a
 * blocker precedes what it blocks), then priority, then created-at, with id as a stable tiebreak.
 */
export function compareBacklogEpics(a: Epic, b: Epic): number {
  if (a.ready !== b.ready) return a.ready ? -1 : 1;
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/** User-selectable board ordering. `default` keeps the server/dependency-aware order. */
export type BoardSort = "default" | "risk" | "size";

export const BOARD_SORT_LABELS: Record<BoardSort, string> = {
  default: "Default order",
  risk: "Risk",
  size: "Size",
};

// Highest-impact first (rank 0 sorts to the top). Unknown/absent values sort last within
// their block. `med`/`medium` and the size aliases are folded so label spelling never matters.
const RISK_RANK: Record<string, number> = { high: 0, med: 1, medium: 1, low: 2 };
const SIZE_RANK: Record<string, number> = { xl: 0, l: 1, lg: 1, m: 2, md: 2, s: 3, sm: 3, xs: 4 };

function tierRank(value: string | undefined, table: Record<string, number>): number {
  const key = value?.toLowerCase();
  const rank = key ? table[key] : undefined;
  return rank ?? Number.POSITIVE_INFINITY;
}

/**
 * Compare two epics for a chosen board sort. Blocked epics (open blockers, `ready === false`)
 * always sink to the bottom regardless of the criteria; within each block, epics order by the
 * selected criteria (risk high→low or size large→small) and fall back to the shared
 * dependency-aware order so ties stay stable across re-renders.
 */
export function compareEpicsBy(sort: Exclude<BoardSort, "default">, a: Epic, b: Epic): number {
  if (a.ready !== b.ready) return a.ready ? -1 : 1;
  const table = sort === "risk" ? RISK_RANK : SIZE_RANK;
  const field = sort === "risk" ? a.risk : a.size;
  const otherField = sort === "risk" ? b.risk : b.size;
  const delta = tierRank(field, table) - tierRank(otherField, table);
  if (delta !== 0) return delta;
  return compareBacklogEpics(a, b);
}

/** Returns the epics reordered for the chosen sort. `default` returns the input order unchanged. */
export function sortEpics(epics: Epic[], sort: BoardSort): Epic[] {
  if (sort === "default") return epics;
  return [...epics].sort((a, b) => compareEpicsBy(sort, a, b));
}

/** Moves an epic (by id) to another stage column, immutably. Used for optimistic
 * drag-and-drop updates before the move API call resolves. No-op if the epic isn't found.
 * A move that lands in the backlog is re-sorted (compareBacklogEpics) so the prepended card
 * settles into dependency-aware order instead of jumping to the top; other columns keep
 * insertion order (newest-moved first). */
export function moveEpicBetweenColumns(
  columns: Record<Stage, Epic[]>,
  epicId: string,
  toStage: Stage,
): Record<Stage, Epic[]> {
  let moved: Epic | undefined;
  const next = Object.fromEntries(STAGES.map((stage) => [stage, [] as Epic[]])) as Record<
    Stage,
    Epic[]
  >;

  for (const stage of STAGES) {
    for (const epic of columns[stage] ?? []) {
      if (epic.id === epicId) {
        moved = epic;
      } else {
        next[stage].push(epic);
      }
    }
  }

  if (!moved) return columns;
  const inserted = [{ ...moved, stage: toStage }, ...next[toStage]];
  next[toStage] = toStage === "backlog" ? inserted.sort(compareBacklogEpics) : inserted;
  return next;
}
