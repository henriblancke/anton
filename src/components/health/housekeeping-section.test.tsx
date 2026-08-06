// @vitest-environment jsdom
/**
 * The Health page's Housekeeping section: folded behind a Show/Hide disclosure exactly as the
 * board's attention strip folds it, and gone entirely when there is none — a project's tidy-up list
 * is real but never loud enough to earn a permanently-open panel.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { HousekeepingSection } from "@/components/health/housekeeping-section";
import type { AttentionItem } from "@/lib/attention";

afterEach(cleanup);

function item(kind: "lint" | "stale-open" | "orphan" | "duplicate", id: string): AttentionItem {
  return {
    key: `h:${id}`,
    severity: "housekeeping",
    source: "hygiene",
    finding: { kind, key: `${kind}:${id}`, detail: `${kind} on ${id}`, beadId: id },
  };
}

describe("HousekeepingSection", () => {
  it("renders nothing when there is no housekeeping", () => {
    const { container } = render(<HousekeepingSection items={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("folds the findings behind a summary line and reveals them on Show", () => {
    render(
      <HousekeepingSection
        items={[item("lint", "anton-a"), item("lint", "anton-b"), item("stale-open", "anton-c")]}
      />,
    );
    expect(screen.getByText("2 contract gaps · 1 stale")).toBeTruthy();
    expect(screen.queryByText("lint on anton-a")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /show/i }));
    expect(screen.getByText("lint on anton-a")).toBeTruthy();
    expect(screen.getByText("lint on anton-b")).toBeTruthy();
    expect(screen.getByText("stale-open on anton-c")).toBeTruthy();
  });

  it("hides the list again on Hide", () => {
    render(<HousekeepingSection items={[item("orphan", "anton-a")]} />);
    fireEvent.click(screen.getByRole("button", { name: /show/i }));
    expect(screen.getByText("orphan on anton-a")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /hide/i }));
    expect(screen.queryByText("orphan on anton-a")).toBeNull();
  });
});
