"use client";

import { usePathname, useRouter } from "next/navigation";

import type { Epic, Stage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  boardAreaOptions,
  boardEpicOptions,
  boardFiltersQueryString,
  hasBoardFilters,
  type BoardFilters,
} from "@/components/board/board-utils";

const selectClassName = cn(
  "h-8 min-w-24 max-w-40 rounded-lg border border-border bg-card px-2 text-xs text-foreground outline-none transition-colors",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
);

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
          field="epic"
          label="Epic"
          value={filters.epic ?? ""}
          options={epicOptions}
          onChange={(epic) => apply({ ...filters, epic: epic || undefined })}
        />
      )}
      {areaOptions.length > 0 && (
        <FilterSelect
          field="area"
          label="Area"
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

type SelectOption = { value: string; label: string };

function withActive(options: SelectOption[], active?: string): SelectOption[] {
  if (!active || options.some((option) => option.value === active)) return options;
  return [...options, { value: active, label: active }];
}

function FilterSelect({
  field,
  label,
  value,
  options,
  onChange,
}: {
  field: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const id = `board-filter-${field}`;
  return (
    <>
      <Label htmlFor={id} className="sr-only">
        {label}
      </Label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={selectClassName}
      >
        <option value="">{label}: All</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </>
  );
}
