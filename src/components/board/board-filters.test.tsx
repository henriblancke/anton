// @vitest-environment jsdom
/**
 * The board's Epic/Area facets (anton-xhm4 regression anchor). `epic-filter.test.tsx` covers what
 * the facets DO to the board; this pins what the bar RENDERS — the `board-filter-*` ids, the
 * "<facet>: All" empty option and the wrapper-less layout — now that the control is shared with the
 * jobs and tickets bars.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { STAGES, type Epic, type Stage } from "@/lib/types";
import { BoardFilters } from "@/components/board/board-filters";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/projects/anton",
}));

const ONTOLOGY = { id: "anton-epc", title: "Ontology editing", area: "ontology" };
const RETRIEVAL = { id: "anton-ret", title: "Trustworthy retrieval", area: "knowledge" };

function epic(id: string, over: Partial<Epic> = {}): Epic {
  return {
    id,
    title: id,
    type: "feature",
    approved: false,
    stage: "backlog",
    assignee: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    createdBy: null,
    blockedBy: [],
    ready: true,
    rank: 0,
    priority: 2,
    abandoned: false,
    tickets: [],
    ...over,
  };
}

function columns(cards: Epic[] = []): Record<Stage, Epic[]> {
  const empty = Object.fromEntries(STAGES.map((s) => [s, [] as Epic[]])) as Record<Stage, Epic[]>;
  return { ...empty, backlog: cards };
}

const CARDS = [epic("anton-1", { epic: ONTOLOGY }), epic("anton-2", { epic: RETRIEVAL })];

beforeEach(() => {
  push.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("BoardFilters", () => {
  it("renders both facets with the board's own ids and 'All' options", () => {
    render(<BoardFilters columns={columns(CARDS)} filters={{}} query="" />);

    const epicSelect = screen.getByLabelText("Epic") as HTMLSelectElement;
    const areaSelect = screen.getByLabelText("Area") as HTMLSelectElement;
    expect(epicSelect.id).toBe("board-filter-epic");
    expect(areaSelect.id).toBe("board-filter-area");
    expect([...epicSelect.options].map((o) => o.text)).toEqual([
      "Epic: All",
      ONTOLOGY.title,
      RETRIEVAL.title,
    ]);
    expect([...areaSelect.options].map((o) => o.text)).toEqual(["Area: All", "knowledge", "ontology"]);
  });

  it("keeps label and select as bare siblings so the bar owns the layout", () => {
    const { container } = render(<BoardFilters columns={columns(CARDS)} filters={{}} query="" />);
    expect(container.querySelector("label + select")).toBeTruthy();
    expect(container.querySelector("div")).toBeNull();
  });

  it("pushes the picked facet, preserving params the bar doesn't own", () => {
    render(<BoardFilters columns={columns(CARDS)} filters={{}} query="sort=age" />);

    fireEvent.change(screen.getByLabelText("Epic"), { target: { value: ONTOLOGY.id } });
    expect(push).toHaveBeenCalledWith(`/projects/anton?sort=age&epic=${ONTOLOGY.id}`, {
      scroll: false,
    });
  });

  it("keeps an active facet selectable after its cards leave the board", () => {
    render(<BoardFilters columns={columns(CARDS)} filters={{ area: "gone" }} query="" />);

    const areaSelect = screen.getByLabelText("Area") as HTMLSelectElement;
    expect([...areaSelect.options].map((o) => o.text)).toEqual([
      "Area: All",
      "knowledge",
      "ontology",
      "gone",
    ]);
    expect(areaSelect.value).toBe("gone");
  });

  it("renders nothing when the board offers no facet at all", () => {
    const { container } = render(<BoardFilters columns={columns()} filters={{}} query="" />);
    expect(container.innerHTML).toBe("");
  });

  it("clears every facet, and offers Clear only while one is active", () => {
    const { unmount } = render(<BoardFilters columns={columns(CARDS)} filters={{}} query="" />);
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    unmount();

    render(<BoardFilters columns={columns(CARDS)} filters={{ epic: ONTOLOGY.id }} query="" />);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(push).toHaveBeenCalledWith("/projects/anton", { scroll: false });
  });
});
