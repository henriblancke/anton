// @vitest-environment jsdom
/**
 * Jobs filter toolbar (anton-mjdo.3): URL is the single source of truth for the filter, so every
 * assertion here is about what lands in `router.push`.
 *
 * next/navigation MUST be mocked — under jsdom there's no App Router provider, so the real
 * `useSearchParams()` returns null (typed non-null, so tsc happily lets the suite die at runtime).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { JobsFilters } from "@/components/runs/jobs-filters";

const push = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/projects/anton/jobs",
  useSearchParams: () => new URLSearchParams(search),
}));

function statusSelect() {
  return screen.getByLabelText("Status") as HTMLSelectElement;
}

function typeSelect() {
  return screen.getByLabelText("Type") as HTMLSelectElement;
}

beforeEach(() => {
  push.mockClear();
  search = "";
});

afterEach(() => {
  cleanup();
});

describe("JobsFilters", () => {
  it("selects Active and All types when the URL carries no filter", () => {
    render(<JobsFilters />);
    expect(statusSelect().value).toBe("");
    expect(statusSelect().selectedOptions[0].textContent).toBe("Active");
    expect(typeSelect().value).toBe("");
    expect(typeSelect().selectedOptions[0].textContent).toBe("All types");
  });

  it("reflects the filter already in the URL", () => {
    search = "status=failed&type=review-fix";
    render(<JobsFilters />);
    expect(statusSelect().value).toBe("failed");
    expect(typeSelect().value).toBe("review-fix");
  });

  it("pushes the picked status", () => {
    render(<JobsFilters />);
    fireEvent.change(statusSelect(), { target: { value: "running" } });
    expect(push).toHaveBeenCalledWith("/projects/anton/jobs?status=running", { scroll: false });
  });

  it("pushes status=all for the full audit log", () => {
    render(<JobsFilters />);
    fireEvent.change(statusSelect(), { target: { value: "all" } });
    expect(push).toHaveBeenCalledWith("/projects/anton/jobs?status=all", { scroll: false });
  });

  it("pushes the picked type alongside the current status", () => {
    search = "status=all";
    render(<JobsFilters />);
    fireEvent.change(typeSelect(), { target: { value: "nightly-stringer" } });
    expect(push).toHaveBeenCalledWith(
      "/projects/anton/jobs?status=all&type=nightly-stringer",
      { scroll: false },
    );
  });

  it("returns to Active — no status param — when the status is cleared", () => {
    search = "status=done&type=execute-epic";
    render(<JobsFilters />);
    fireEvent.change(statusSelect(), { target: { value: "" } });
    expect(push).toHaveBeenCalledWith("/projects/anton/jobs?type=execute-epic", { scroll: false });
  });

  it("drops the page param when a filter changes", () => {
    search = "page=3&status=running";
    render(<JobsFilters />);
    fireEvent.change(typeSelect(), { target: { value: "review-fix" } });
    expect(push).toHaveBeenCalledWith(
      "/projects/anton/jobs?status=running&type=review-fix",
      { scroll: false },
    );
  });

  it("ignores a status the queue doesn't define", () => {
    search = "status=pending";
    render(<JobsFilters />);
    expect(statusSelect().value).toBe("");
  });

  it("offers Clear all only while a filter is active", () => {
    render(<JobsFilters />);
    expect(screen.queryByRole("button", { name: /clear all/i })).toBeNull();
    cleanup();

    search = "type=orphan-grooming";
    render(<JobsFilters />);
    fireEvent.click(screen.getByRole("button", { name: /clear all/i }));
    expect(push).toHaveBeenCalledWith("/projects/anton/jobs", { scroll: false });
  });
});
