"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";

import { STAGES, type Board, type Epic, type Stage, type StandaloneItem } from "@/lib/types";
import {
  boardFiltersFromSearchParams,
  emptyStageMap,
  filterBoard,
  groupBoardByEpic,
  sortEpics,
  type BoardFilters,
  type BoardGrouping,
  type BoardSort,
  type EpicLane,
} from "@/components/board/board-utils";

/** The board as it is displayed: narrowed by the URL, ordered by the sort, arranged by the grouping. */
export interface BoardView {
  filters: BoardFilters;
  /** The URL's current query string, so a filter change preserves params the board doesn't own. */
  query: string;
  columns: Record<Stage, Epic[]>;
  standalone: Record<Stage, StandaloneItem[]>;
  /** The same cards regrouped into product swimlanes; `null` while the stage grouping is on. */
  lanes: EpicLane[] | null;
}

/**
 * Everything the board renders, derived from the board it polls. Narrowing lives in the URL — so an
 * epic badge is a plain link and a narrowed board is shareable — and every step here is derived, so
 * drag/drop and polling keep operating on the unfiltered source.
 */
export function useBoardView(board: Board | null, sort: BoardSort, grouping: BoardGrouping): BoardView {
  const searchParams = useSearchParams();
  // Keyed on the serialized query so the derived board only recomputes on a real change.
  const query = searchParams.toString();
  const filters = useMemo(() => boardFiltersFromSearchParams(new URLSearchParams(query)), [query]);

  const narrowed = useMemo(
    () => filterBoard(board?.columns ?? emptyStageMap<Epic>(), board?.standalone, filters),
    [board, filters],
  );

  const columns = useMemo(
    () =>
      Object.fromEntries(
        STAGES.map((stage) => [stage, sortEpics(narrowed.columns[stage], sort)]),
      ) as Record<Stage, Epic[]>,
    [narrowed, sort],
  );

  // The swimlanes are a regrouping of the very cards above — the sorted columns feed both views, so
  // a lane's cards carry the chosen sort and there is no second board to keep in step.
  const lanes = useMemo(
    () => (grouping === "epic" ? groupBoardByEpic(columns, narrowed.standalone) : null),
    [grouping, columns, narrowed],
  );

  return { filters, query, columns, standalone: narrowed.standalone, lanes };
}
