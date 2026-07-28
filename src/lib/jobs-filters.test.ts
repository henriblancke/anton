/**
 * Unit tests for the dependency-free Jobs filter helpers (anton-mjdo.1): the three `status`
 * resolutions, URL round-tripping, and rejection of values the queue doesn't define.
 */
import { describe, expect, it } from "vitest";
import {
  ACTIVE_JOB_STATUSES,
  JOB_STATUS_FILTER_OPTIONS,
  JOB_STATUSES,
  JOB_TYPE_FILTER_OPTIONS,
  JOB_TYPES,
  isActiveJob,
  isJobStatus,
  isJobType,
  jobFiltersFromSearchParams,
  jobsQueryString,
  normalizeJobFilters,
  resolveStatusFilter,
  searchParamsFromJobFilters,
} from "./jobs-filters";

describe("resolveStatusFilter", () => {
  it("resolves absent to the active set", () => {
    expect(resolveStatusFilter(undefined)).toEqual(["queued", "running", "parked"]);
  });

  it("resolves `all` to no status constraint", () => {
    expect(resolveStatusFilter("all")).toBeNull();
  });

  it("resolves a single known status to just that status", () => {
    expect(resolveStatusFilter("done")).toEqual(["done"]);
    expect(resolveStatusFilter("cancelled")).toEqual(["cancelled"]);
  });

  it("degrades an unrecognized status to the default (active) view", () => {
    expect(resolveStatusFilter("pending")).toEqual(["queued", "running", "parked"]);
    expect(resolveStatusFilter("")).toEqual(["queued", "running", "parked"]);
  });

  it("returns a fresh array so callers can't mutate the shared active set", () => {
    const resolved = resolveStatusFilter(undefined);
    resolved?.push("done");
    expect(ACTIVE_JOB_STATUSES).toEqual(["queued", "running", "parked"]);
  });
});

describe("normalizeJobFilters", () => {
  it("keeps known status and type values", () => {
    expect(normalizeJobFilters({ status: "failed", type: "review-fix" })).toEqual({
      status: "failed",
      type: "review-fix",
    });
    expect(normalizeJobFilters({ status: "all" })).toEqual({ status: "all" });
  });

  it("drops unknown, empty and prototype-shaped values", () => {
    expect(normalizeJobFilters({ status: "pending", type: "deploy" })).toEqual({});
    expect(normalizeJobFilters({ status: "", type: "  " })).toEqual({});
    expect(normalizeJobFilters({ status: "toString", type: "constructor" })).toEqual({});
    expect(normalizeJobFilters({ status: null, type: null })).toEqual({});
  });
});

describe("jobFiltersFromSearchParams", () => {
  it("reads status and type off the query string", () => {
    const filters = jobFiltersFromSearchParams(
      new URLSearchParams("status=running&type=execute-epic"),
    );
    expect(filters).toEqual({ status: "running", type: "execute-epic" });
  });

  it("ignores unknown values and unrelated keys", () => {
    const filters = jobFiltersFromSearchParams(
      new URLSearchParams("status=bogus&type=bogus&page=3&epic=anton-x"),
    );
    expect(filters).toEqual({});
  });

  it("returns the default view for an empty query string", () => {
    expect(jobFiltersFromSearchParams(new URLSearchParams())).toEqual({});
    expect(resolveStatusFilter(jobFiltersFromSearchParams(new URLSearchParams()).status)).toEqual([
      "queued",
      "running",
      "parked",
    ]);
  });
});

describe("searchParamsFromJobFilters / jobsQueryString", () => {
  it("round-trips filters through the query string", () => {
    const filters = { status: "parked", type: "nightly-stringer" } as const;
    const query = jobsQueryString(filters);
    expect(query).toBe("?status=parked&type=nightly-stringer");
    expect(jobFiltersFromSearchParams(new URLSearchParams(query))).toEqual(filters);
  });

  it("serializes the default view to an empty string", () => {
    expect(jobsQueryString({})).toBe("");
    expect(searchParamsFromJobFilters({}).toString()).toBe("");
  });

  it("drops values the queue doesn't define instead of emitting them", () => {
    const query = jobsQueryString({
      status: "pending",
      type: "deploy",
    } as unknown as Parameters<typeof jobsQueryString>[0]);
    expect(query).toBe("");
  });

  it("keeps the `all` sentinel, which is meaningful in the URL", () => {
    expect(jobsQueryString({ status: "all" })).toBe("?status=all");
  });
});

describe("option lists", () => {
  it("offers every status from the JobStatus union plus the two view-level choices", () => {
    expect(JOB_STATUSES).toEqual(["queued", "running", "parked", "done", "failed", "cancelled"]);
    expect(JOB_STATUS_FILTER_OPTIONS.map((o) => o.value)).toEqual(["", "all", ...JOB_STATUSES]);
    expect(JOB_STATUS_FILTER_OPTIONS.every((o) => o.label.length > 0)).toBe(true);
  });

  it("offers every job type the queue can enqueue", () => {
    expect(JOB_TYPES).toEqual([
      "execute-epic",
      "review-fix",
      "nightly-stringer",
      "orphan-grooming",
    ]);
    expect(JOB_TYPE_FILTER_OPTIONS.map((o) => o.value)).toEqual(["", ...JOB_TYPES]);
  });

  it("accepts exactly the offered values as valid filters", () => {
    expect(JOB_STATUSES.every(isJobStatus)).toBe(true);
    expect(JOB_TYPES.every(isJobType)).toBe(true);
    expect(isJobStatus("all")).toBe(false);
    expect(isJobType("all")).toBe(false);
  });
});

describe("isActiveJob", () => {
  it("treats queued/running/parked as active and the rest as terminal", () => {
    expect(JOB_STATUSES.filter(isActiveJob)).toEqual(["queued", "running", "parked"]);
  });
});
