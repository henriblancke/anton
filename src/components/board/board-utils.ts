/**
 * Pure display helpers for the epic board. Kept dependency-free so they're trivially testable
 * (see board-utils.test.ts) and reusable from both the board and card client components.
 */
import {
  STAGES,
  type BeadProvenance,
  type Epic,
  type EpicCrumb,
  type IssueType,
  type Stage,
  type StandaloneItem,
  type Ticket,
  type UpNextEntry,
} from "@/lib/types";

/**
 * The Up Next lane's heading (anton-t9m4 / R3.2). NOT "Ready": `bd ready` already means *unblocked*,
 * and two meanings of ready on one screen is the confusion `.beads/PRIME.md` opens by warning about.
 * Lives beside STAGE_LABELS but deliberately outside it — Up Next is not a stage.
 */
export const UP_NEXT_LABEL = "Up Next";

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

// ── Work-type language (epic / feature / task / bug / chore) ───────────────
//
// One shared vocabulary so every board item reads its type at a glance: a human label, a left rail
// inset, a compact-badge tint, and an icon/text hue — all keyed on the same `--type-*` tokens. The
// icon components live in type-language.tsx (JSX); these string maps stay pure so board-utils is
// trivially testable and shareable by server + client.

export const TYPE_LABELS: Record<IssueType, string> = {
  epic: "Epic",
  feature: "Feature",
  task: "Task",
  bug: "Bug",
  chore: "Chore",
};

/** Left-rail inset color per work type — mirrors the stage rail's `box-shadow: inset 2px 0`. */
export const TYPE_RAIL: Record<IssueType, string> = {
  epic: "shadow-[inset_2px_0_0_var(--type-epic)]",
  feature: "shadow-[inset_2px_0_0_var(--type-feature)]",
  task: "shadow-[inset_2px_0_0_var(--type-task)]",
  bug: "shadow-[inset_2px_0_0_var(--type-bug)]",
  chore: "shadow-[inset_2px_0_0_var(--type-chore)]",
};

/** Icon/text hue per work type. */
export const TYPE_TEXT: Record<IssueType, string> = {
  epic: "text-type-epic",
  feature: "text-type-feature",
  task: "text-type-task",
  bug: "text-type-bug",
  chore: "text-type-chore",
};

/** Compact type-badge tint (border + fill + text), one per work type. */
export const TYPE_BADGE: Record<IssueType, string> = {
  epic: "border-type-epic/30 bg-type-epic/10 text-type-epic",
  feature: "border-type-feature/30 bg-type-feature/10 text-type-feature",
  task: "border-type-task/30 bg-type-task/10 text-type-task",
  bug: "border-type-bug/30 bg-type-bug/10 text-type-bug",
  chore: "border-type-chore/30 bg-type-chore/10 text-type-chore",
};

/**
 * The board, narrowed to one product epic. Every epic badge points here, so "click the badge to see
 * this epic's work" has a single URL shape across the detail breadcrumb and the feature cards
 * (docs/design/2026-07-26-tier-and-linear-ux.md).
 */
export function boardEpicFilterHref(slug: string, epicId: string): string {
  return `/projects/${slug}?epic=${encodeURIComponent(epicId)}`;
}

// ── Filtering: the board narrowed to one product epic or one area ─────────

/**
 * What the board is narrowed to, mirrored in the URL so an epic badge is a plain link and the
 * narrowed board is shareable. Both facets are absent by default — the board's job is execution,
 * so it shows everything until asked otherwise.
 */
export interface BoardFilters {
  /** A single product epic id (`?epic=`) — where every epic badge points. */
  epic?: string;
  /** A single `area:` designator (`?area=`), matched against each card's epic. */
  area?: string;
}

export const BOARD_FILTER_KEYS: (keyof BoardFilters)[] = ["epic", "area"];

/** Reads the board filters out of a URLSearchParams (e.g. from useSearchParams). */
export function boardFiltersFromSearchParams(searchParams: URLSearchParams): BoardFilters {
  const filters: BoardFilters = {};
  for (const key of BOARD_FILTER_KEYS) {
    const value = searchParams.get(key)?.trim();
    if (value) filters[key] = value;
  }
  return filters;
}

export function hasBoardFilters(filters: BoardFilters): boolean {
  return BOARD_FILTER_KEYS.some((key) => Boolean(filters[key]?.trim()));
}

/**
 * `?epic=x&area=y`, preserving any unrelated params already on the URL (sort, dialog state) so a
 * filter change never silently drops another surface's state. Empty facets are removed, not blanked.
 */
export function boardFiltersQueryString(filters: BoardFilters, currentQuery = ""): string {
  const params = new URLSearchParams(currentQuery);
  for (const key of BOARD_FILTER_KEYS) {
    const value = filters[key]?.trim();
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function matchesBoardFilters(epic: Epic, filters: BoardFilters): boolean {
  // Match a card by its OWN id too: a legacy epic (no feature children) is itself the board card and
  // carries no parent epic crumb, so keying only on the crumb would open an empty board on the very
  // card the roadmap row links to (`?epic=<row.id>`).
  if (filters.epic && epic.epic?.id !== filters.epic && epic.id !== filters.epic) return false;
  if (filters.area && epic.epic?.area !== filters.area) return false;
  return true;
}

/**
 * The board narrowed to the active filters. Standalone chips are parentless by definition — they
 * carry no epic and so no area — so any active filter drops them entirely rather than leaving a
 * column of chips that don't belong to the epic being read.
 */
export function filterBoard(
  columns: Record<Stage, Epic[]>,
  standalone: Record<Stage, StandaloneItem[]> | undefined,
  filters: BoardFilters,
): { columns: Record<Stage, Epic[]>; standalone: Record<Stage, StandaloneItem[]> } {
  const active = hasBoardFilters(filters);
  const next = emptyStageMap<Epic>();
  const chips = emptyStageMap<StandaloneItem>();
  for (const stage of STAGES) {
    next[stage] = (columns[stage] ?? []).filter((epic) => matchesBoardFilters(epic, filters));
    chips[stage] = active ? [] : (standalone?.[stage] ?? []);
  }
  return { columns: next, standalone: chips };
}

/** The product epics present on the board, sorted by title — the Epic filter's options. */
export function boardEpicOptions(columns: Record<Stage, Epic[]>): EpicCrumb[] {
  const byId = new Map<string, EpicCrumb>();
  for (const stage of STAGES) {
    for (const epic of columns[stage] ?? []) {
      if (epic.epic) byId.set(epic.epic.id, epic.epic);
    }
  }
  return [...byId.values()].sort(
    (a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
  );
}

/** The `area:` designators present on the board, sorted — the Area filter's options. */
export function boardAreaOptions(columns: Record<Stage, Epic[]>): string[] {
  const areas = new Set<string>();
  for (const stage of STAGES) {
    for (const epic of columns[stage] ?? []) {
      if (epic.epic?.area) areas.add(epic.epic.area);
    }
  }
  return [...areas].sort((a, b) => a.localeCompare(b));
}

/** Left-border color per stage — used by dependency-graph nodes (`border-l-3`). */
export const STAGE_BORDER_LEFT: Record<Stage, string> = {
  backlog: "border-l-stage-backlog",
  implementing: "border-l-stage-implementing",
  "in-review": "border-l-stage-in-review",
  done: "border-l-stage-done",
};

/** Inset left-rail per stage — the active-stage cue on epic cards. Only implementing (orange) and
 * in-review (blue) carry it; backlog/done cards stay railless. */
export const STAGE_INSET_SHADOW: Record<Stage, string> = {
  backlog: "shadow-[inset_2px_0_0_var(--stage-backlog)]",
  implementing: "shadow-[inset_2px_0_0_var(--stage-implementing)]",
  "in-review": "shadow-[inset_2px_0_0_var(--stage-in-review)]",
  done: "shadow-[inset_2px_0_0_var(--stage-done)]",
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

/**
 * Ticket completion for an epic: how many of its tickets are `done`, and the total. Abandoned
 * tickets leave the count entirely (anton-a5vc) — they are closed, so counting them would inflate
 * `done` with work that shipped nothing; leaving them in the denominator would instead pin the epic
 * below 100% forever. A won't-do ticket is out of scope, not outstanding.
 */
export function ticketProgress(epic: { tickets: Ticket[] }): {
  done: number;
  total: number;
  pct: number;
} {
  const counted = epic.tickets.filter((t) => !t.abandoned);
  const total = counted.length;
  const done = counted.filter((t) => t.stage === "done").length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return { done, total, pct };
}

/**
 * Can the operator start this run target now? A partially-gated target IS startable: the executor
 * dispatches the tickets nothing holds and parks only the rest (issue #58), so hiding Approve on it
 * would strand runnable work behind an unrelated blocker. Only a fully blocked target — zero
 * runnable tickets — refuses. Reads the rollup's verdict, which is the same field the approve route
 * gates on, so the card can never advertise a run approval will reject (or hide one it would take).
 */
export function canStartRun(epic: Pick<Epic, "childReadiness">): boolean {
  return epic.childReadiness !== "blocked";
}

/**
 * Is this card one of the board-picker's current picks — the targets the Up Next projection holds?
 *
 * Read off the provenance the board already attaches (`◈ policy`, board-provenance.ts), which is set
 * for exactly the beads in the recorded plan. A second signal on the card would be a second answer to
 * "did the picker choose this", and the badge and the `[Release]` button beside it must never
 * disagree about that.
 *
 * What it gates is shadow mode's affordance: while nothing starts unattended, a pick is offered with
 * `[Release]` rather than the plain `Approve` every other backlog card carries (R3.5).
 */
export function isPickerPick(provenance: BeadProvenance[] | undefined): boolean {
  return provenance?.some((mark) => mark.kind === "policy") ?? false;
}

/**
 * The N-of-M behind a partially-gated card: how many of the tickets this run would dispatch can
 * start now, of how many in total. Counted off the rollup's own child sets so the badge can never
 * disagree with the verdict it labels.
 */
export function childReadinessCounts(epic: Pick<Epic, "readyChildren" | "blockedChildren">): {
  ready: number;
  blocked: number;
  total: number;
} {
  const ready = epic.readyChildren.length;
  const blocked = epic.blockedChildren.length;
  return { ready, blocked, total: ready + blocked };
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
  // Subtracting the two tier ranks yields NaN only when BOTH are unknown (Infinity - Infinity);
  // guard on Number.isNaN so that pair falls through to the dependency-aware order. When exactly
  // one is unknown the delta is ±Infinity, which correctly sinks the unknown side last (the UI
  // promise), so we must NOT treat it as a fall-through — only the both-unknown NaN case does.
  const delta = tierRank(field, table) - tierRank(otherField, table);
  if (!Number.isNaN(delta) && delta !== 0) return Math.sign(delta);
  return compareBacklogEpics(a, b);
}

/** Returns the epics reordered for the chosen sort. `default` returns the input order unchanged. */
export function sortEpics(epics: Epic[], sort: BoardSort): Epic[] {
  if (sort === "default") return epics;
  return [...epics].sort((a, b) => compareEpicsBy(sort, a, b));
}

// ── Grouping: stage columns (default) vs epic swimlanes ───────────────────

/**
 * How the board arranges the same cards. `stage` is the daily execution view and stays the default;
 * `epic` regroups those cards into product swimlanes — opt-in and non-destructive
 * (docs/design/2026-07-26-tier-and-linear-ux.md).
 */
export type BoardGrouping = "stage" | "epic";

export const BOARD_GROUPINGS: BoardGrouping[] = ["stage", "epic"];

export const BOARD_GROUPING_LABELS: Record<BoardGrouping, string> = {
  stage: "Stage",
  epic: "Epic",
};

export function isBoardGrouping(value: unknown): value is BoardGrouping {
  return value === "stage" || value === "epic";
}

/** One epic swimlane: the same stage columns, narrowed to the run targets under one product epic. */
export interface EpicLane {
  /** The lane's product epic; absent on the final "No epic" lane. */
  epic?: EpicCrumb;
  columns: Record<Stage, Epic[]>;
  /** Standalone chips — parentless by definition, so only ever on the "No epic" lane. */
  standalone: Record<Stage, StandaloneItem[]>;
  /** Non-abandoned run targets in the lane — the rollup denominator. */
  features: number;
  /** How many of those shipped. */
  shipped: number;
  /** Non-abandoned standalone chips in the lane. */
  loose: number;
}

function emptyStageMap<T>(): Record<Stage, T[]> {
  return Object.fromEntries(STAGES.map((stage) => [stage, [] as T[]])) as Record<Stage, T[]>;
}

/**
 * Regroup the board's cards by their product epic, preserving each card's stage column and the
 * column order it was given. Lanes read alphabetically (stable as cards move between stages), and
 * every run target with no epic — including the standalone chips, which are parentless by
 * definition — collects in a final "No epic" lane.
 *
 * An abandoned card leaves both sides of the rollup for the same reason it leaves ticketProgress:
 * it is a won't-do outcome, so counting it would either inflate `shipped` or pin the lane below
 * 100% forever. It still renders — the lane shows the work, the rollup counts the deliveries.
 */
export function groupBoardByEpic(
  columns: Record<Stage, Epic[]>,
  standalone?: Record<Stage, StandaloneItem[]>,
): EpicLane[] {
  const NO_EPIC = "";
  const lanes = new Map<string, EpicLane>();

  const laneFor = (epic?: EpicCrumb): EpicLane => {
    const key = epic?.id ?? NO_EPIC;
    let lane = lanes.get(key);
    if (!lane) {
      lane = {
        epic,
        columns: emptyStageMap<Epic>(),
        standalone: emptyStageMap<StandaloneItem>(),
        features: 0,
        shipped: 0,
        loose: 0,
      };
      lanes.set(key, lane);
    }
    return lane;
  };

  for (const stage of STAGES) {
    for (const card of columns[stage] ?? []) {
      const lane = laneFor(card.epic);
      lane.columns[stage].push(card);
      if (card.abandoned) continue;
      lane.features += 1;
      if (card.stage === "done") lane.shipped += 1;
    }
    for (const item of standalone?.[stage] ?? []) {
      const lane = laneFor(undefined);
      lane.standalone[stage].push(item);
      if (!item.abandoned) lane.loose += 1;
    }
  }

  const noEpic = lanes.get(NO_EPIC);
  const sorted = [...lanes.values()]
    .filter((lane) => lane.epic)
    .sort((a, b) => {
      const byTitle = a.epic!.title.localeCompare(b.epic!.title);
      return byTitle !== 0 ? byTitle : a.epic!.id.localeCompare(b.epic!.id);
    });
  return noEpic ? [...sorted, noEpic] : sorted;
}

// ── Up Next: this machine's plan, taken out of Backlog ────────────────────

/** One card in the Up Next lane: the ranking's facts, plus whichever board item they describe. */
export type UpNextCard =
  | { entry: UpNextEntry; kind: "epic"; epic: Epic }
  | { entry: UpNextEntry; kind: "standalone"; item: StandaloneItem };

/** The lane and the board it was taken out of — `cards` empty means there is no lane to draw. */
export interface UpNextSplit {
  cards: UpNextCard[];
  columns: Record<Stage, Epic[]>;
  standalone: Record<Stage, StandaloneItem[]>;
}

/**
 * Split the board into the Up Next lane and the Backlog it leaves behind (anton-t9m4 / R3.3).
 *
 * SUBTRACTION, not an overlay: a bead lives in exactly one lane, so a card the plan claims is
 * removed from Backlog rather than drawn in both places. Done by id, against the backlog column
 * only — Up Next is a projection over Backlog, never a stage, so a target that has since started
 * stays in Implementing and simply drops out of the lane. That is also the staleness behaviour we
 * want: the plan is history, the columns are what is true now.
 *
 * `entries` absent (no plan recorded, or the picker disarmed) yields an empty lane and the board
 * untouched, which is what makes the lane's absence a single check for the caller.
 */
export function takeUpNext(
  columns: Record<Stage, Epic[]>,
  standalone: Record<Stage, StandaloneItem[]> | undefined,
  entries: UpNextEntry[] | undefined,
): UpNextSplit {
  const chips = standalone ?? emptyStageMap<StandaloneItem>();
  if (!entries?.length) return { cards: [], columns, standalone: chips };

  const epicsById = new Map((columns.backlog ?? []).map((epic) => [epic.id, epic]));
  const chipsById = new Map((chips.backlog ?? []).map((item) => [item.id, item]));

  const cards: UpNextCard[] = [];
  for (const entry of entries) {
    const epic = epicsById.get(entry.beadId);
    if (epic) {
      cards.push({ entry, kind: "epic", epic });
      continue;
    }
    const item = chipsById.get(entry.beadId);
    if (item) cards.push({ entry, kind: "standalone", item });
  }
  if (cards.length === 0) return { cards: [], columns, standalone: chips };

  const taken = new Set(cards.map((card) => card.entry.beadId));
  return {
    cards,
    columns: { ...columns, backlog: (columns.backlog ?? []).filter((e) => !taken.has(e.id)) },
    standalone: { ...chips, backlog: (chips.backlog ?? []).filter((i) => !taken.has(i.id)) },
  };
}

/**
 * The three ranking facts under a lane card's position — priority, work type, and how much open work
 * finishing it frees. One string so the visible line and the group's accessible name can never say
 * different things about the same pick.
 *
 * An unprioritized bead says so rather than borrowing a number: the ranking sorts it after every
 * explicit priority (beads/rank.ts), and printing `P4` would claim a decision nobody made.
 */
export function upNextMetaLabel(entry: UpNextEntry): string {
  const priority = entry.priority === undefined ? "no priority" : `P${entry.priority}`;
  return `${priority} · ${TYPE_LABELS[entry.type]} · unblocks ${entry.unblocks}`;
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
