"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";

import {
  STAGES,
  type Board,
  type Epic,
  type Stage,
  type StandaloneItem,
  type UpNextAbsence,
} from "@/lib/types";
import {
  boardFiltersFromSearchParams,
  emptyStageMap,
  filterBoard,
  groupBoardByEpic,
  sortEpics,
  takeUpNext,
  type BoardFilters,
  type BoardGrouping,
  type BoardSort,
  type EpicLane,
  type UpNextCard,
} from "@/components/board/board-utils";

/** The board as it is displayed: narrowed by the URL, ordered by the sort, arranged by the grouping. */
export interface BoardView {
  filters: BoardFilters;
  /** The URL's current query string, so a filter change preserves params the board doesn't own. */
  query: string;
  /** The stage columns the lane was taken out of — a bead renders in exactly one place. */
  columns: Record<Stage, Epic[]>;
  standalone: Record<Stage, StandaloneItem[]>;
  /** The same cards regrouped into product swimlanes; `null` while the stage grouping is on. */
  lanes: EpicLane[] | null;
  /** The Up Next lane's cards, in rank order; empty means there is no lane to draw. */
  upNext: UpNextCard[];
  /**
   * Every pick in the ranking by bead id, INCLUDING the ones the filters hide. A hidden pick still
   * spends the quota, so the lane's budget line is placed on this rather than on `upNext`.
   */
  upNextPlan: string[];
  /** The generation the picks on screen were drawn from, so a verdict names the plan it answers. */
  planId?: string;
  /**
   * Every bead the LIVE ranking names, whatever the grouping. In the stage view the lane's rows say
   * this by existing; the swimlanes have no rows, so their cards are told which of them are picks
   * (PR #226 review) — the half of "unrecorded pick" that a card cannot see for itself.
   */
  ranked: ReadonlySet<string>;
  /**
   * WHICH absence the lane is showing, when the server named one (anton-w579). Carried through
   * untouched: the states it names are about the PASS and the board, and no filter on this screen
   * clears any of them.
   */
  upNextAbsence?: UpNextAbsence;
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

  // The Up Next lane and the Backlog it was taken out of (anton-t9m4). Computed on the SORTED,
  // narrowed board so the lane obeys the same filters as everything else, and subtracted rather than
  // overlaid so no bead renders twice (R3.3). Only in the stage view: the lane is a column position
  // between Backlog and Implementing, and the epic swimlanes group by product rather than by stage —
  // so there the cards stay in Backlog, where they still appear exactly once. They are still PICKS
  // there, mark and all, so that layout carries the plan's generation itself rather than losing it
  // with the lane.
  //
  // In epic grouping the lane therefore never paints AT ALL — not for a frame (anton-wds3). That
  // holds because `grouping` is the operator's own choice from the very first render: the server
  // reads it from the cookie and hands it to `useBoardGrouping` as its server snapshot, so this
  // never computes a lane the next commit throws away.
  const upNext = useMemo(
    () =>
      takeUpNext(columns, narrowed.standalone, grouping === "stage" ? board?.upNext : undefined),
    [columns, narrowed, grouping, board?.upNext],
  );
  // The same ranking, UNFILTERED — what the lane places its budget line on. `upNext.cards` is only
  // what the narrowing left, and a hidden pick still spends the quota: charging the visible cards
  // from zero would show a target as affordable that the whole plan puts below the line.
  const upNextPlan = useMemo(
    () =>
      grouping === "stage" && board
        ? takeUpNext(board.columns, board.standalone, board.upNext).cards.map(
            (card) => card.entry.beadId,
          )
        : [],
    [grouping, board],
  );

  // Read off the board rather than off `upNext` above, which is empty in the epic grouping — the
  // ranking is a fact about the project, not about the arrangement the operator is looking at.
  const ranked = useMemo(
    () => new Set((board?.upNext ?? []).map((entry) => entry.beadId)),
    [board?.upNext],
  );

  // The swimlanes are a regrouping of the very cards above — the sorted columns feed both views, so
  // a lane's cards carry the chosen sort and there is no second board to keep in step.
  const lanes = useMemo(
    () => (grouping === "epic" ? groupBoardByEpic(columns, narrowed.standalone) : null),
    [grouping, columns, narrowed],
  );

  return {
    filters,
    query,
    columns: upNext.columns,
    standalone: upNext.standalone,
    lanes,
    upNext: upNext.cards,
    upNextPlan,
    ranked,
    ...(board?.upNextPlanId === undefined ? {} : { planId: board.upNextPlanId }),
    ...(board?.upNextAbsence === undefined ? {} : { upNextAbsence: board.upNextAbsence }),
  };
}
