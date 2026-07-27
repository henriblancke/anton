// @vitest-environment jsdom
/**
 * The epic badge on a feature card (anton-9pkk.3): context on the execution board, not structure.
 * The load-bearing assertions are that the badge and its hollow legacy counterpart both render, and
 * that clicking a badge actually narrows the board — the badge is a plain link into the same
 * `?epic=` state the filter bar's facets write, so one narrowing has two ways in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { STAGES, type Board, type Epic, type StandaloneItem, type Stage } from "@/lib/types";
import { TYPE_BADGE, boardEpicFilterHref } from "@/components/board/board-utils";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// A stateful stand-in for the App Router: `router.push` rewrites the query the board reads back
// through `useSearchParams`, so a badge click and a facet change are exercised end to end rather
// than asserted as an href alone.
let query = "";
const listeners = new Set<() => void>();

function navigate(url: string) {
  const q = url.indexOf("?");
  query = q === -1 ? "" : url.slice(q + 1);
  for (const listener of listeners) listener();
}

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(query),
  usePathname: () => "/projects/tmp",
  useRouter: () => ({ push: navigate, replace: navigate }),
}));

// next/link renders an <a> whose click jsdom can't follow; route it through the same fake router.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  ),
}));

// dnd-kit can't resolve droppables under jsdom's zero-size rects; drag is covered elsewhere.
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => children,
  DragOverlay: ({ children }: { children: React.ReactNode }) => children,
  KeyboardSensor: function KeyboardSensor() {},
  PointerSensor: function PointerSensor() {},
  closestCorners: () => [],
  defaultKeyboardCoordinateGetter: () => undefined,
  useSensor: () => ({}),
  useSensors: () => [],
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    setActivatorNodeRef: () => {},
    transform: null,
    isDragging: false,
  }),
}));
vi.mock("@dnd-kit/modifiers", () => ({ restrictToWindowEdges: {} }));
vi.mock("@dnd-kit/utilities", () => ({ CSS: { Translate: { toString: () => "" } } }));

const { EpicBoard } = await import("@/components/board/epic-board");

const ONTOLOGY = { id: "anton-epc", title: "Ontology editing for curators", area: "ontology" };
const RETRIEVAL = { id: "anton-ret", title: "Trustworthy retrieval", area: "knowledge" };

function epic(id: string, over: Partial<Epic> = {}): Epic {
  return {
    id,
    title: id,
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

/**
 * Three run targets — one under each product epic, one under none (the legacy card the transition
 * has to keep running) — plus a parentless chip.
 */
function fixture(): Board {
  const columns = Object.fromEntries(STAGES.map((s) => [s, [] as Epic[]])) as Record<Stage, Epic[]>;
  const chips = Object.fromEntries(
    STAGES.map((s) => [s, [] as StandaloneItem[]]),
  ) as Record<Stage, StandaloneItem[]>;

  columns.backlog = [
    epic("anton-1", { title: "Term merge", epic: ONTOLOGY }),
    epic("anton-2", { title: "Citation provenance", epic: RETRIEVAL }),
    epic("anton-3", { title: "Prune closed beads" }),
  ];
  chips.backlog = [
    {
      id: "anton-t3x",
      title: "Board drag snaps back on drop",
      type: "bug",
      status: "open",
      stage: "backlog",
      approved: false,
      assignee: null,
      createdAt: "2026-07-20T00:00:00.000Z",
      createdBy: null,
      blockedBy: [],
      ready: true,
      unread: false,
      deferred: false,
      abandoned: false,
    },
  ];

  return {
    projectSlug: "tmp",
    version: "1:sync",
    columns,
    standalone: chips,
    sync: { state: "synced", lastSyncedAt: 1, lastPushedAt: 1, unpushedCount: 0, lastError: null },
  };
}

/** Re-renders the board whenever the fake router rewrites the query. */
function Harness() {
  useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => query,
    () => query,
  );
  return <EpicBoard slug="tmp" initialBoard={fixture()} />;
}

/** The titles of the run-target cards currently on the board. */
function cardIds(): string[] {
  return [...document.querySelectorAll<HTMLAnchorElement>('a[href^="/projects/tmp/epics/"]')].map(
    (link) => link.getAttribute("href")!.split("/").pop()!,
  );
}

function badgeFor(epicCrumb: { id: string }): HTMLElement {
  const href = boardEpicFilterHref("tmp", epicCrumb.id);
  const badge = document.querySelector<HTMLElement>(`a[href="${href}"]`);
  if (!badge) throw new Error(`no epic badge linking to ${href}`);
  return badge;
}

beforeEach(() => {
  query = "";
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 304 })) as unknown as typeof fetch,
  );
});

afterEach(() => {
  cleanup();
  listeners.clear();
  vi.restoreAllMocks();
});

describe("epic badge on feature cards (anton-9pkk.3)", () => {
  it("shows each card's product epic as a badge, hollow when the run target has none", () => {
    render(<Harness />);

    // The filled badge carries the epic's title and links to the board narrowed to it.
    const badge = badgeFor(ONTOLOGY);
    expect(badge.textContent).toContain(ONTOLOGY.title);
    expect(badge.getAttribute("href")).toBe(`/projects/tmp?epic=${ONTOLOGY.id}`);

    // The legacy run target reads as unmigrated, not broken — and has no epic to link to.
    const hollow = screen.getByTitle(/no product epic above this run target/i);
    expect(hollow.textContent).toContain("No epic — legacy run target");
    expect(hollow.tagName).toBe("SPAN");
  });

  it("tints the badge with the shipped epic type token, never an agent hue", () => {
    render(<Harness />);
    const className = badgeFor(RETRIEVAL).className;

    // One iris hue for the whole tier (TYPE_BADGE.epic → --type-epic), which is the only palette
    // hue no agent: token uses — so the badge can never be misread as an agent chip.
    for (const token of TYPE_BADGE.epic.split(" ")) expect(className).toContain(token);
    expect(className).not.toMatch(/agent-/);
  });

  it("narrows the board to that epic when a badge is clicked", () => {
    render(<Harness />);
    expect(cardIds()).toEqual(["anton-1", "anton-2", "anton-3"]);

    act(() => {
      fireEvent.click(badgeFor(ONTOLOGY));
    });

    // Only the epic's own run target survives; the other epic, the epic-less card, and the
    // parentless chip (which carries no epic to match) all drop out.
    expect(cardIds()).toEqual(["anton-1"]);
    expect(screen.queryByText("Board drag snaps back on drop")).toBeNull();
  });

  it("offers Epic and Area facets that narrow the same way the badge does", () => {
    render(<Harness />);

    const epicFilter = screen.getByLabelText("Epic") as HTMLSelectElement;
    const areaFilter = screen.getByLabelText("Area") as HTMLSelectElement;
    expect([...epicFilter.options].map((o) => o.text)).toEqual([
      "Epic: All",
      ONTOLOGY.title,
      RETRIEVAL.title,
    ]);
    expect([...areaFilter.options].map((o) => o.text)).toEqual(["Area: All", "knowledge", "ontology"]);

    act(() => {
      fireEvent.change(areaFilter, { target: { value: "knowledge" } });
    });
    expect(cardIds()).toEqual(["anton-2"]);

    // Clearing restores the whole board, chips included.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    });
    expect(cardIds()).toEqual(["anton-1", "anton-2", "anton-3"]);
    expect(screen.getByText("Board drag snaps back on drop")).toBeTruthy();
  });

  it("keeps the swimlane view narrowed too — the facets filter cards, not one view", () => {
    render(<Harness />);
    act(() => {
      fireEvent.click(badgeFor(RETRIEVAL));
    });
    fireEvent.click(screen.getByRole("button", { name: "Epic" }));

    const lanes = screen.getAllByRole("region");
    expect(lanes.map((l) => l.getAttribute("aria-label"))).toEqual([`Epic ${RETRIEVAL.title}`]);
    expect(within(lanes[0]).getByText("Citation provenance")).toBeTruthy();
  });
});
