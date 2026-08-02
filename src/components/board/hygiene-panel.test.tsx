// @vitest-environment jsdom
/**
 * The board's hygiene panel (anton-uwal): the gardener's report, on the page where work is approved
 * instead of in a job log. What matters here is that nothing the patrol saw is lost — every finding
 * class is counted in the collapsed header and every finding names the bead(s) it concerns — and
 * that "never patrolled" and "patrolled, clean" stay visibly different claims.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { HygienePanel } from "@/components/board/hygiene-panel";
import type { HygieneCounts, HygieneFinding, HygieneReport } from "@/lib/types";

afterEach(cleanup);

function countsOf(findings: HygieneFinding[]): HygieneCounts {
  const counts: HygieneCounts = {
    lint: 0,
    "stale-open": 0,
    "stale-in-progress": 0,
    orphan: 0,
    "dep-cycle": 0,
    duplicate: 0,
  };
  for (const f of findings) counts[f.kind] += 1;
  return counts;
}

/** One patrol that hit every finding class — sorted by kind then key, as the store returns them. */
const FINDINGS: HygieneFinding[] = [
  {
    kind: "dep-cycle",
    key: "dep-cycle:anton-a+anton-b",
    ids: ["anton-a", "anton-b"],
    detail: "dependency cycle: anton-a → anton-b → anton-a",
  },
  {
    kind: "duplicate",
    key: "duplicate:anton-c+anton-d",
    ids: ["anton-c", "anton-d"],
    title: "Export to CSV",
    detail: "2 beads with identical content: anton-c, anton-d — bd suggests keeping anton-c",
  },
  {
    kind: "lint",
    key: "lint:anton-e",
    beadId: "anton-e",
    title: "Add the export button",
    detail: "task is missing ## Acceptance",
  },
  {
    kind: "orphan",
    key: "orphan:anton-f",
    beadId: "anton-f",
    title: "Wire the webhook",
    detail: "named by a commit (abc1234) but still open",
  },
  {
    kind: "stale-in-progress",
    key: "stale-in-progress:anton-g",
    beadId: "anton-g",
    title: "Rework the queue",
    detail: "in progress and untouched for over 7 days (assignee alice)",
  },
  {
    kind: "stale-open",
    key: "stale-open:anton-h",
    beadId: "anton-h",
    title: "Old idea",
    detail: "open and untouched for over 30 days",
  },
];

function report(overrides: Partial<HygieneReport> = {}): HygieneReport {
  const findings = overrides.findings ?? FINDINGS;
  return {
    id: "r-1",
    projectId: "p-1",
    generatedAt: Math.floor(Date.now() / 1000) - 2 * 3600,
    actions: { closedEpics: [], rowsRecomputed: 0 },
    ...overrides,
    findings,
    counts: countsOf(findings),
  };
}

const renderPanel = (r: HygieneReport | undefined, onOpenBead = vi.fn()) => {
  render(<HygienePanel report={r} onOpenBead={onOpenBead} />);
  return onOpenBead;
};

describe("HygienePanel", () => {
  it("renders nothing for a project that has never been patrolled", () => {
    // The gardener schedule is opt-in — a project that never enabled it must not carry a permanent
    // empty panel it can do nothing about.
    const { container } = render(<HygienePanel report={undefined} onOpenBead={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("says a clean board is clean, with nothing to expand", () => {
    renderPanel(report({ findings: [] }));

    expect(screen.getByText("Board hygiene")).toBeDefined();
    expect(screen.getByText(/nothing to clean up/)).toBeDefined();
    expect(screen.queryByRole("button", { name: /details/i })).toBeNull();
  });

  it("counts every class of finding the patrol reported, without expanding", () => {
    renderPanel(report());

    expect(screen.getByText("1 contract gap")).toBeDefined();
    expect(screen.getByText("1 stale")).toBeDefined();
    expect(screen.getByText("1 abandoned run")).toBeDefined();
    expect(screen.getByText("1 shipped, not closed")).toBeDefined();
    expect(screen.getByText("1 dependency cycle")).toBeDefined();
    expect(screen.getByText("1 duplicate")).toBeDefined();
  });

  it("leads with what the patrol APPLIED, not just what it found", () => {
    renderPanel(
      report({
        findings: [],
        actions: { closedEpics: ["anton-e1", "anton-e2"], rowsRecomputed: 3 },
      }),
    );

    expect(screen.getByText(/closed 2 epics/)).toBeDefined();
    expect(screen.getByText(/repaired 3 blocked rows/)).toBeDefined();
    // Applied closures are worth naming: expanding lists the epics the sweep closed.
    fireEvent.click(screen.getByRole("button", { name: /show details/i }));
    expect(screen.getByRole("button", { name: "anton-e1" })).toBeDefined();
    expect(screen.getByRole("button", { name: "anton-e2" })).toBeDefined();
  });

  it("spells out every finding and its detail once expanded", () => {
    renderPanel(report());

    const toggle = screen.getByRole("button", { name: /show details/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: /hide details/i }).getAttribute("aria-expanded")).toBe(
      "true",
    );

    for (const finding of FINDINGS) {
      expect(screen.getByText(finding.detail), finding.key).toBeDefined();
    }
    expect(screen.getByText("Dependency cycle")).toBeDefined();
    expect(screen.getByText("Shipped, not closed")).toBeDefined();
  });

  it("links each finding to the bead it concerns", () => {
    const onOpenBead = renderPanel(report());
    fireEvent.click(screen.getByRole("button", { name: /show details/i }));

    fireEvent.click(screen.getByRole("button", { name: "anton-e" }));
    expect(onOpenBead).toHaveBeenCalledWith("anton-e");
  });

  it("links EVERY bead of a finding that spans several — a cycle's ring, a duplicate group", () => {
    const onOpenBead = renderPanel(report());
    fireEvent.click(screen.getByRole("button", { name: /show details/i }));

    const cycleRow = screen.getByText(/dependency cycle: anton-a/).closest("li")!;
    for (const id of ["anton-a", "anton-b"]) {
      expect(within(cycleRow).getByRole("button", { name: id })).toBeDefined();
    }

    const duplicateRow = screen.getByText(/2 beads with identical content/).closest("li")!;
    fireEvent.click(within(duplicateRow).getByRole("button", { name: "anton-d" }));
    expect(onOpenBead).toHaveBeenCalledWith("anton-d");
  });
});
