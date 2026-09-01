// @vitest-environment jsdom
/**
 * The Up Next lane on the board (anton-t9m4 / R3.1–R3.4).
 *
 * Three things are load-bearing and each is pinned here: the lane sits BETWEEN Backlog and
 * Implementing (a card must never move left as it advances), a bead renders in exactly ONE lane, and
 * the lane is ABSENT — not empty — when there is no plan to show. The fourth is vocabulary: nothing
 * on this screen may call the lane "Ready", because `bd ready` already means *unblocked*.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import {
  STAGES,
  type Board,
  type Epic,
  type Stage,
  type StandaloneItem,
  type UpNextEntry,
} from "@/lib/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects/tmp",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

// dnd-kit can't resolve droppables under jsdom's zero-size rects; drag behaviour is covered in
// epic-board.test.tsx, so the whole surface is inert here.
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
    childReadiness: "ready",
    readyChildren: [],
    blockedChildren: [],
    rank: 0,
    priority: 2,
    abandoned: false,
    tickets: [],
    ...over,
  };
}

function entry(beadId: string, rank: number, over: Partial<UpNextEntry> = {}): UpNextEntry {
  return { beadId, rank, priority: 2, type: "feature", unblocks: 0, ...over };
}

/** Two ranked backlog targets, one unranked one beside them, and one already implementing. */
function fixture(upNext?: UpNextEntry[]): Board {
  const columns = Object.fromEntries(STAGES.map((s) => [s, [] as Epic[]])) as Record<Stage, Epic[]>;
  columns.backlog = [
    epic("anton-pick1", { title: "Term merge" }),
    epic("anton-pick2", { title: "Prune closed beads" }),
    epic("anton-rest", { title: "Ontology export" }),
  ];
  columns.implementing = [epic("anton-run", { title: "Ship the editor", stage: "implementing" })];

  return {
    projectSlug: "tmp",
    version: "1:sync",
    columns,
    standalone: Object.fromEntries(STAGES.map((s) => [s, [] as StandaloneItem[]])) as Record<
      Stage,
      StandaloneItem[]
    >,
    ...(upNext ? { upNext } : {}),
    sync: {
      state: "synced",
      lastSyncedAt: 1,
      lastPushedAt: 1,
      unpushedCount: 0,
      lastError: null,
      stalledForMs: null,
    },
  };
}

const PLAN = [
  entry("anton-pick2", 1, { priority: 0, unblocks: 3 }),
  entry("anton-pick1", 2, { priority: 2, unblocks: 0 }),
];

/** Every column heading on the board, left to right — the flow order R3.1 constrains. */
function laneOrder(): string[] {
  return [...document.querySelectorAll("h2")].map((h) => h.textContent ?? "");
}

/** Which lane a card's deep link sits under, by the lane's own name. */
function laneOf(cardId: string): string {
  const link = document.querySelector(`a[href="/projects/tmp/epics/${cardId}"]`);
  return link?.closest("[data-lane]")?.getAttribute("data-lane") ?? "";
}

function cardCount(cardId: string): number {
  return document.querySelectorAll(`a[href="/projects/tmp/epics/${cardId}"]`).length;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 304 })) as unknown as typeof fetch,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Up Next lane (anton-t9m4)", () => {
  it("renders between Backlog and Implementing", () => {
    render(<EpicBoard slug="tmp" initialBoard={fixture(PLAN)} />);
    expect(laneOrder()).toEqual(["Backlog", "Up Next", "Implementing", "In-review", "Done"]);
  });

  it("never calls itself Ready — `bd ready` already means unblocked", () => {
    render(<EpicBoard slug="tmp" initialBoard={fixture(PLAN)} />);

    const lane = screen.getByRole("region", { name: "Up Next" });
    expect(lane.querySelector("h2")?.textContent).toBe("Up Next");
    // The lane's own chrome, not the cards it borrows from Backlog.
    const chrome = [...lane.querySelectorAll("h2, p, [title], [aria-label]")]
      .flatMap((el) => [el.textContent, el.getAttribute("title"), el.getAttribute("aria-label")])
      .join(" ");
    expect(chrome).not.toMatch(/\bready\b/i);
  });

  it("takes its cards out of Backlog, so a bead renders in exactly one lane", () => {
    render(<EpicBoard slug="tmp" initialBoard={fixture(PLAN)} />);

    expect(cardCount("anton-pick1")).toBe(1);
    expect(cardCount("anton-pick2")).toBe(1);
    expect(laneOf("anton-pick1")).toBe("Up Next");
    expect(laneOf("anton-pick2")).toBe("Up Next");
    // An unranked backlog target stays where it was; a running one is untouched.
    expect(laneOf("anton-rest")).toBe("Backlog");
    expect(laneOf("anton-run")).toBe("Implementing");
  });

  it("orders its cards by the recorded rank and shows what each was ranked on", () => {
    render(<EpicBoard slug="tmp" initialBoard={fixture(PLAN)} />);

    const lane = screen.getByRole("region", { name: "Up Next" });
    const titles = [...lane.querySelectorAll("h4")].map((h) => h.textContent);
    expect(titles).toEqual(["Prune closed beads", "Term merge"]);

    // Rank, priority, type and unblocking count — one accessible name per pick.
    expect(screen.getByRole("group", { name: "Rank 1 — P0 · Feature · unblocks 3" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Rank 2 — P2 · Feature · unblocks 0" })).toBeTruthy();
  });

  it("says whose plan it is — a local projection, never shared board state", () => {
    render(<EpicBoard slug="tmp" initialBoard={fixture(PLAN)} />);

    const lane = screen.getByRole("region", { name: "Up Next" });
    expect(lane.textContent).toContain("This machine’s plan — not shared board state.");
    const caption = lane.querySelector("p[title]");
    expect(caption?.getAttribute("title")).toMatch(/not shared with your teammates/);
  });

  it("is absent, not empty, when no plan is recorded", () => {
    render(<EpicBoard slug="tmp" initialBoard={fixture()} />);

    expect(screen.queryByRole("region", { name: "Up Next" })).toBeNull();
    expect(laneOrder()).toEqual(["Backlog", "Implementing", "In-review", "Done"]);
    expect(laneOf("anton-pick1")).toBe("Backlog");
  });

  it("is absent when the recorded plan admitted nothing", () => {
    render(<EpicBoard slug="tmp" initialBoard={fixture([])} />);
    expect(screen.queryByRole("region", { name: "Up Next" })).toBeNull();
  });

  it("is absent when every recorded pick has left the backlog", () => {
    render(<EpicBoard slug="tmp" initialBoard={fixture([entry("anton-run", 1)])} />);

    expect(screen.queryByRole("region", { name: "Up Next" })).toBeNull();
    expect(laneOf("anton-run")).toBe("Implementing");
  });
});
