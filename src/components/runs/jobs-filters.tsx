"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  JOB_STATUS_FILTER_OPTIONS,
  JOB_TYPE_FILTER_OPTIONS,
  jobFiltersFromSearchParams,
  jobsQueryString,
  normalizeJobFilters,
  type JobFilterOption,
} from "@/lib/jobs-filters";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

const selectClassName = cn(
  "h-8 min-w-28 rounded-lg border border-border bg-card px-2 text-xs text-foreground outline-none transition-colors",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
);

/**
 * Status/type filter toolbar for the Jobs page (anton-mjdo.3). Filters live in the URL so the
 * server page can apply them at the SQL layer — the list, the count and the pager all read the
 * same params. Every push drops `?page`, because page 3 of the old filter is meaningless under
 * the new one.
 */
export function JobsFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = jobFiltersFromSearchParams(searchParams);
  const hasFilters = Boolean(filters.status || filters.type);

  // Select values are raw strings; normalize before serializing so an option that no longer maps
  // to a queue value can't reach the URL.
  function apply(next: { status?: string; type?: string }) {
    router.push(`${pathname}${jobsQueryString(normalizeJobFilters(next))}`, { scroll: false });
  }

  return (
    <div
      role="search"
      aria-label="Filter jobs"
      className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-border px-5 py-3 sm:px-6"
    >
      <FilterSelect
        field="status"
        label="Status"
        value={filters.status ?? ""}
        options={JOB_STATUS_FILTER_OPTIONS}
        onChange={(value) => apply({ ...filters, status: value || undefined })}
      />
      <FilterSelect
        field="type"
        label="Type"
        value={filters.type ?? ""}
        options={JOB_TYPE_FILTER_OPTIONS}
        onChange={(value) => apply({ ...filters, type: value || undefined })}
      />

      {hasFilters && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => router.push(pathname, { scroll: false })}
          className="ml-auto text-subtle"
        >
          Clear all
        </Button>
      )}
    </div>
  );
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
  options: JobFilterOption[];
  onChange: (value: string) => void;
}) {
  const id = `job-filter-${field}`;
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="sr-only">
        {label}
      </Label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={selectClassName}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
