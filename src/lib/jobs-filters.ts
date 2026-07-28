/**
 * Pure URL <-> filter mapping for the Jobs page (anton-mjdo.1), plus the filterable option lists.
 *
 * Dependency-free on purpose: this is imported by BOTH the server-side query layer (jobs-view.ts,
 * which drags better-sqlite3) and the client toolbar, so it must never import jobs-view, ./db, or
 * jobs/queue at runtime — only the erased `JobStatus`/`JobType` types.
 *
 * The option lists are keyed off `Record<JobStatus, …>` / `Record<JobType, …>` label maps, so
 * widening either union in jobs/queue.ts fails typecheck here instead of silently shipping a
 * filter that can't reach the new value.
 */
import type { JobStatus, JobType } from "./jobs/queue";

/** Statuses that are still in flight — the default Jobs view, and the active/terminal split. */
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ["queued", "running", "parked"];

/** Sentinel `status` value meaning "no status constraint at all", vs. the active-only default. */
export const ALL_STATUSES = "all";

/** A `status` the URL can carry: one concrete status, or the explicit "no constraint" sentinel. */
export type JobStatusFilter = JobStatus | typeof ALL_STATUSES;

/** Filters applied at the SQL layer, so counts, pages and the footer agree. */
export interface JobFilters {
  /** Absent → the active set; `all` → every status; otherwise that one status. */
  status?: JobStatusFilter;
  type?: JobType;
}

const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Running",
  parked: "Parked",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const JOB_TYPE_LABELS: Record<JobType, string> = {
  "execute-epic": "Execute epic",
  "review-fix": "Review fix",
  "nightly-stringer": "Nightly stringer",
  "orphan-grooming": "Orphan grooming",
};

export const JOB_STATUSES = Object.keys(JOB_STATUS_LABELS) as JobStatus[];
export const JOB_TYPES = Object.keys(JOB_TYPE_LABELS) as JobType[];

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && Object.hasOwn(JOB_STATUS_LABELS, value);
}

export function isJobType(value: unknown): value is JobType {
  return typeof value === "string" && Object.hasOwn(JOB_TYPE_LABELS, value);
}

export interface JobFilterOption {
  value: string;
  label: string;
}

/** Status choices in display order. The empty value is the default (active-only) view. */
export const JOB_STATUS_FILTER_OPTIONS: JobFilterOption[] = [
  { value: "", label: "Active" },
  { value: ALL_STATUSES, label: "All statuses" },
  ...JOB_STATUSES.map((status) => ({ value: status, label: JOB_STATUS_LABELS[status] })),
];

/** Type choices in display order. The empty value means "every type". */
export const JOB_TYPE_FILTER_OPTIONS: JobFilterOption[] = [
  { value: "", label: "All types" },
  ...JOB_TYPES.map((type) => ({ value: type, label: JOB_TYPE_LABELS[type] })),
];

/** Reads job filters off a URLSearchParams, dropping values the queue doesn't define. */
export function jobFiltersFromSearchParams(searchParams: URLSearchParams): JobFilters {
  return normalizeJobFilters({
    status: searchParams.get("status") ?? undefined,
    type: searchParams.get("type") ?? undefined,
  });
}

/**
 * Keeps only values the queue actually defines, so an unrecognized `?status=pending` degrades to
 * the default view instead of throwing or reaching the query layer.
 */
export function normalizeJobFilters(input: {
  status?: string | null;
  type?: string | null;
}): JobFilters {
  const status = input.status?.trim();
  const type = input.type?.trim();
  return {
    ...(status === ALL_STATUSES || isJobStatus(status) ? { status } : {}),
    ...(isJobType(type) ? { type } : {}),
  };
}

/** Serializes filters back to a URLSearchParams, dropping empty and unknown values. */
export function searchParamsFromJobFilters(filters: JobFilters): URLSearchParams {
  const params = new URLSearchParams();
  const normalized = normalizeJobFilters(filters);
  if (normalized.status) params.set("status", normalized.status);
  if (normalized.type) params.set("type", normalized.type);
  return params;
}

/** `?status=x&type=y` (or `""` when the default view is active), for links and fetch calls. */
export function jobsQueryString(filters: JobFilters): string {
  const query = searchParamsFromJobFilters(filters).toString();
  return query ? `?${query}` : "";
}

/**
 * The statuses a query must constrain to: `null` means no constraint (`all`). Absent or
 * unrecognized resolves to the active set — the default view.
 */
export function resolveStatusFilter(status?: string | null): JobStatus[] | null {
  if (status === ALL_STATUSES) return null;
  if (isJobStatus(status)) return [status];
  return [...ACTIVE_JOB_STATUSES];
}

/** Active vs. terminal (kept for audit) grouping. Re-exported by jobs-view for server callers. */
export function isActiveJob(status: JobStatus): boolean {
  return ACTIVE_JOB_STATUSES.includes(status);
}
