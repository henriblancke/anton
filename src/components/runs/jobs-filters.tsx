"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  JOB_STATUS_FILTER_OPTIONS,
  JOB_TYPE_FILTER_OPTIONS,
  jobFiltersFromSearchParams,
  jobsQueryString,
  normalizeJobFilters,
} from "@/lib/jobs-filters";
import { Button } from "@/components/ui/button";
import { FilterSelect } from "@/components/ui/filter-select";

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
        idPrefix="job-filter"
        field="status"
        label="Status"
        className="min-w-28"
        wrapperClassName="flex flex-col gap-1"
        value={filters.status ?? ""}
        options={JOB_STATUS_FILTER_OPTIONS}
        onChange={(value) => apply({ ...filters, status: value || undefined })}
      />
      <FilterSelect
        idPrefix="job-filter"
        field="type"
        label="Type"
        className="min-w-28"
        wrapperClassName="flex flex-col gap-1"
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
