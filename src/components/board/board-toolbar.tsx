"use client";

import type { Board } from "@/lib/types";
import { BoardFilters } from "@/components/board/board-filters";
import { BoardGroupingToggle } from "@/components/board/board-grouping-toggle";
import { HealthPill } from "@/components/board/health-pill";
import { SyncStatusBadge } from "@/components/board/sync-status-badge";
import {
  BOARD_SORT_LABELS,
  type BoardFilters as BoardFilterState,
  type BoardGrouping,
  type BoardSort,
} from "@/components/board/board-utils";

const BOARD_SORTS: BoardSort[] = ["default", "risk", "size"];

const sortSelectClassName =
  "h-8 rounded-lg border border-border bg-card px-2 text-xs text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** How the board is arranged and how healthy it is — every control that changes the view, and none
 * that changes a card. */
export function BoardToolbar({
  slug,
  board,
  filters,
  query,
  grouping,
  onGroupingChange,
  sort,
  onSortChange,
}: {
  slug: string;
  /** The unfiltered board — the filter options and the health/sync reads all come off it. */
  board: Board;
  filters: BoardFilterState;
  query: string;
  grouping: BoardGrouping;
  onGroupingChange: (next: BoardGrouping) => void;
  sort: BoardSort;
  onSortChange: (next: BoardSort) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 pb-2">
      <BoardGroupingToggle value={grouping} onChange={onGroupingChange} />
      <BoardFilters columns={board.columns} filters={filters} query={query} />
      <span className="flex-1" />
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="text-subtle">Sort</span>
        <select
          aria-label="Sort epics"
          value={sort}
          onChange={(e) => onSortChange(e.target.value as BoardSort)}
          className={sortSelectClassName}
        >
          {BOARD_SORTS.map((option) => (
            <option key={option} value={option}>
              {BOARD_SORT_LABELS[option]}
            </option>
          ))}
        </select>
      </label>
      {/* Hygiene, the review trend, and the scan trend all live on the Health page now
          (anton-ue90.3) — this pill is their one doorway from the toolbar, sized and positioned
          like the sync badge it sits beside rather than opening a popover of its own. It rides
          the board payload so its count refreshes on the same 304-friendly poll as the cards. */}
      <HealthPill
        slug={slug}
        hygiene={board.hygiene}
        trajectory={board.reviewTrajectory}
        scanHealth={board.scanHealth}
      />
      <SyncStatusBadge sync={board.sync} />
    </div>
  );
}
