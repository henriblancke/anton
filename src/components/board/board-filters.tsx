"use client";

import { usePathname, useRouter } from "next/navigation";

import type { Epic, Stage } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { FilterSelect, withActive } from "@/components/ui/filter-select";
import {
  boardAreaOptions,
  boardEpicOptions,
  boardFiltersQueryString,
  hasBoardFilters,
  type BoardFilters,
} from "@/components/board/board-utils";

/**
 * Epic and Area facets for the board. The URL is the single source of truth, so an epic badge is a
 * plain link into the same state these selects write — one narrowing, two ways in
 * (docs/design/2026-07-26-tier-and-linear-ux.md).
 *
 * Options are derived from the cards on the board rather than the full bead list: a facet that can
 * only ever narrow to nothing is noise on an execution surface.
 */
export function BoardFilters({
  columns,
  filters,
  query,
}: {
  /** The unfiltered columns — options must not shrink to whatever the current filter left behind. */
  columns: Record<Stage, Epic[]>;
  filters: BoardFilters;
  /** The URL's current query string, so a filter change preserves params this bar doesn't own. */
  query: string;
}) {
  const router = useRouter();
  const pathname = usePathname();

  // An active facet always stays selectable, even when nothing on the board carries it any more —
  // otherwise a shared link to a since-emptied epic reads as "Epic: All" over an empty board.
  const epicOptions = withActive(
    boardEpicOptions(columns).map((epic) => ({ value: epic.id, label: epic.title })),
    filters.epic,
  );
  const areaOptions = withActive(
    boardAreaOptions(columns).map((area) => ({ value: area, label: area })),
    filters.area,
  );
  if (epicOptions.length === 0 && areaOptions.length === 0) return null;

  function apply(next: BoardFilters) {
    router.push(`${pathname}${boardFiltersQueryString(next, query)}`, { scroll: false });
  }

  return (
    <>
      {epicOptions.length > 0 && (
        <FilterSelect
          idPrefix="board-filter"
          field="epic"
          label="Epic"
          emptyLabel="Epic: All"
          className="max-w-40"
          value={filters.epic ?? ""}
          options={epicOptions}
          onChange={(epic) => apply({ ...filters, epic: epic || undefined })}
        />
      )}
      {areaOptions.length > 0 && (
        <FilterSelect
          idPrefix="board-filter"
          field="area"
          label="Area"
          emptyLabel="Area: All"
          className="max-w-40"
          value={filters.area ?? ""}
          options={areaOptions}
          onChange={(area) => apply({ ...filters, area: area || undefined })}
        />
      )}
      {hasBoardFilters(filters) && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => apply({})}
          className="text-subtle"
        >
          Clear
        </Button>
      )}
    </>
  );
}
