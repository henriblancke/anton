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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DragEndEvent } from "@dnd-kit/core";

import type { BudgetSignal } from "@/lib/budget-line";
import {
  STAGES,
  type Board,
  type Epic,
  type Stage,
  type StandaloneItem,
  type UpNextEntry,
} from "@/lib/types";

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastMessage = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    message: (...a: unknown[]) => toastMessage(...a),
  },
}));

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects/tmp",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}));

// dnd-kit's sensors can't resolve a drop under jsdom's zero-size rects, so the surface is inert and
// the board's real onDragEnd is captured for the reorder tests to fire a synthetic drop into.
let dragEndHandler: ((e: DragEndEvent) => void | Promise<void>) | undefined;
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragEnd,
  }: {
    children: React.ReactNode;
    onDragEnd: (e: DragEndEvent) => void;
  }) => {
    dragEndHandler = onDragEnd;
    return children;
  },
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
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => children,
  verticalListSortingStrategy: {},
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    setActivatorNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));
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
  return {
    beadId,
    rank,
    priority: 2,
    type: "feature",
    unblocks: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

/** Two ranked backlog targets, one unranked one beside them, and one already implementing. */
/** The generation the fixture's lane is drawn from — what a veto off it must name. */
const PLAN_ID = "plan-gen-1";

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
    ...(upNext ? { upNext, upNextPlanId: PLAN_ID } : {}),
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

/**
 * The board's fetch surface. Everything the lane touches is answered explicitly: the board poll
 * 304s, and the budget signal is absent (204) unless a test hands one over.
 */
function stubFetch(routes: Record<string, () => Response> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [fragment, answer] of Object.entries(routes)) {
      if (url.includes(fragment)) return answer();
    }
    if (url.includes("/picker/budget")) return new Response(null, { status: 204 });
    return new Response(null, { status: 304 });
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A governor reading with `sessionPct` left and one run costing 20 session%-points. */
function budgetSignal(sessionPct: number): BudgetSignal {
  return {
    headroom: {
      sessionPct,
      sessionReason: "session-headroom",
      weeklyPct: null,
      weeklyReason: "weekly-cap",
      weeklyInclusive: true,
    },
    burn: { "execute-epic": { sessionPct: 20, weeklyPct: 3, seeded: false } },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  stubFetch();
});

afterEach(() => {
  cleanup();
  dragEndHandler = undefined;
  vi.clearAllMocks();
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

/**
 * The budget line, composed into the lane it was built for (anton-vlom / R3.6, anton-7bzg.1). The
 * placement arithmetic is `budget-line.test.ts`'s; what is pinned here is that the LANE reads the
 * signal, draws the divider at the position it computes, and words the wait on every card below it.
 */
describe("the budget line in the Up Next lane", () => {
  /** The lane's children in order, as `card:<id>` / `divider` / `waiting:<id>` markers. */
  function laneRows(): string[] {
    const lane = screen.getByRole("region", { name: "Up Next" });
    const rows: string[] = [];
    // One flat walk, so the order asserted is the order the operator reads down the lane.
    for (const node of lane.querySelectorAll("*")) {
      if (node.getAttribute("role") === "separator") {
        rows.push("divider");
        continue;
      }
      const href = node.tagName === "A" ? node.getAttribute("href") : null;
      if (!href?.startsWith("/projects/tmp/epics/")) continue;
      const id = href.split("/").pop()!;
      rows.push(node.closest('[aria-label^="Waiting"]') ? `waiting:${id}` : `card:${id}`);
    }
    return rows;
  }

  it("draws the dashed line where the remaining headroom runs out", async () => {
    // 20% headroom at 20% a run: the first pick spends the last of it (the governor admits the run
    // that crosses), so the second is the one waiting.
    stubFetch({ "/picker/budget": json(budgetSignal(20)) });
    render(<EpicBoard slug="tmp" initialBoard={fixture(PLAN)} />);

    await waitFor(() => expect(screen.getByRole("separator")).toBeTruthy());
    expect(laneRows()).toEqual(["card:anton-pick2", "divider", "waiting:anton-pick1"]);
    expect(screen.getByRole("separator").getAttribute("aria-label")).toMatch(/session headroom/);
    // The reason is on the waiting card too — never carried by the dimming alone.
    expect(screen.getByRole("group", { name: "Waiting — session headroom" })).toBeTruthy();
  });

  it("puts every card below the line when the governor is already holding", async () => {
    stubFetch({ "/picker/budget": json(budgetSignal(0)) });
    render(<EpicBoard slug="tmp" initialBoard={fixture(PLAN)} />);

    await waitFor(() => expect(screen.getByRole("separator")).toBeTruthy());
    expect(laneRows()).toEqual(["divider", "waiting:anton-pick2", "waiting:anton-pick1"]);
  });

  it("draws no line when the governor has nothing to say (204)", async () => {
    render(<EpicBoard slug="tmp" initialBoard={fixture(PLAN)} />);

    await waitFor(() =>
      expect(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([u]) =>
          String(u).includes("/picker/budget"),
        ),
      ).toBe(true),
    );
    expect(screen.queryByRole("separator")).toBeNull();
    expect(laneRows()).toEqual(["card:anton-pick2", "card:anton-pick1"]);
  });

  it("draws no line when the whole plan is affordable", async () => {
    stubFetch({ "/picker/budget": json(budgetSignal(500)) });
    render(<EpicBoard slug="tmp" initialBoard={fixture(PLAN)} />);

    await waitFor(() =>
      expect(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([u]) =>
          String(u).includes("/picker/budget"),
        ),
      ).toBe(true),
    );
    expect(screen.queryByRole("separator")).toBeNull();
  });
});

/**
 * The two vetoes, reachable from the lane (anton-jqvy / R3.9). VetoActions' own behaviour is
 * `veto-actions.test.tsx`'s; what is pinned here is that an operator can actually get at it — the
 * gap that made the whole server half unreachable.
 */
describe("vetoing a pick from the lane", () => {
  it("posts `not now` for the card it sits on", async () => {
    const until = Date.now() + 24 * 60 * 60 * 1000;
    const fetchMock = stubFetch({
      "/picker/veto": json({ beadId: "anton-pick2", action: "not-now", deferredUntil: until }),
    });
    render(<EpicBoard slug="tmp" initialBoard={fixture(PLAN)} />);

    // Rank 1 is anton-pick2, so the lane's first `not now` vetoes it and nothing else.
    fireEvent.click(screen.getAllByRole("button", { name: /not now/i })[0]);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/tmp/picker/veto",
        expect.objectContaining({
          method: "POST",
          // The generation the card was drawn from rides along, so the record names the pick the
          // operator answered rather than whatever the latest pass has since ranked.
          body: JSON.stringify({
            beadId: "anton-pick2",
            action: "not-now",
            planId: PLAN_ID,
          }),
        }),
      ),
    );
    // The hold is stamped on the board immediately, so the target leaves the lane on the click that
    // set it aside rather than on the next picker pass ten minutes later — and lands back in
    // Backlog reading as held, never silently missing.
    await waitFor(() => expect(laneOf("anton-pick2")).toBe("Backlog"));
    expect(screen.getByText(/not now ·/i)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /not now/i })).toHaveLength(1);
  });

  it("offers `Never` beside it, which is what carries the operator to the rule", () => {
    render(<EpicBoard slug="tmp" initialBoard={fixture(PLAN)} />);
    expect(screen.getAllByRole("button", { name: "Never" })).toHaveLength(2);
  });

  it("reads a target already set aside as held, instead of offering the veto again", () => {
    const board = fixture(PLAN);
    board.columns.backlog = board.columns.backlog.map((e) =>
      e.id === "anton-pick2" ? { ...e, notNowUntil: Date.now() + 60 * 60 * 1000 } : e,
    );
    render(<EpicBoard slug="tmp" initialBoard={board} />);

    expect(screen.getByText(/set aside · back in/i)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /not now/i })).toHaveLength(1);
  });
});

/**
 * Dragging to reorder writes `priority` (R3.8) — the payoff of the architecture: a human steers the
 * picker through the SAME channel product-master uses, so the correction is ordinary board state
 * rather than an override to reconcile.
 */
describe("reordering the lane", () => {
  const drop = (activeId: string, overId: string) =>
    dragEndHandler?.({
      active: { id: activeId, data: { current: { upNext: true, stage: "backlog" } } },
      over: { id: overId, data: { current: { upNext: true, stage: "backlog" } } },
    } as unknown as DragEndEvent);

  /**
   * A plan whose lower card frees MORE work than the one above it. Crossing a priority boundary can
   * only equalize priorities, and PRIME then breaks that tie on unblocking value — so this is a plan
   * where the promotion is a move the next pass will keep, and the lane may report it.
   */
  const CROSSABLE = [
    entry("anton-pick2", 1, { priority: 0, unblocks: 1 }),
    entry("anton-pick1", 2, { priority: 2, unblocks: 3 }),
  ];

  it("writes the dragged target's new priority through its own bead route", async () => {
    const fetchMock = stubFetch({ "/epics/anton-pick1": json({ detail: {} }) });
    render(<EpicBoard slug="tmp" initialBoard={fixture(CROSSABLE)} />);

    // P2 dragged above P0: to hold the top slot it must carry the top slot's priority.
    await drop("anton-pick1", "anton-pick2");

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/tmp/epics/anton-pick1",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ priority: 0 }) }),
      ),
    );
    // The lane withdraws itself once the write lands (a reprioritized bead is one the recorded plan
    // no longer describes), so the toast says what happens next rather than leaving the withdrawal
    // to read as a failed drag.
    expect(toastSuccess).toHaveBeenCalledWith(
      'Set "Term merge" to P0 · critical',
      expect.objectContaining({
        description: "The lane re-ranks from it on the next board-picker pass.",
      }),
    );
  });

  it("refuses a promotion the picker's own tiebreak would take straight back", async () => {
    // The same drag against a plan where the top card frees more work: equalizing priorities would
    // leave the ranking deciding on unblocking value, and it decides for the card already on top. A
    // PATCH here would report a move the next pass silently reverses.
    const fetchMock = stubFetch();
    render(<EpicBoard slug="tmp" initialBoard={fixture(PLAN)} />);

    await drop("anton-pick1", "anton-pick2");

    await waitFor(() => expect(toastMessage).toHaveBeenCalled());
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/epics/anton-pick1"))).toBe(false);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("demotes a target dragged down to the band it landed in", async () => {
    const fetchMock = stubFetch({ "/epics/anton-pick2": json({ detail: {} }) });
    render(<EpicBoard slug="tmp" initialBoard={fixture(CROSSABLE)} />);

    await drop("anton-pick2", "anton-pick1");

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/tmp/epics/anton-pick2",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ priority: 2 }) }),
      ),
    );
  });

  it("renumbers the lane on the drop, rather than leaving a plan reading 2, 1", async () => {
    stubFetch({ "/epics/anton-pick1": json({ detail: {} }) });
    render(<EpicBoard slug="tmp" initialBoard={fixture(CROSSABLE)} />);

    await drop("anton-pick1", "anton-pick2");

    await waitFor(() => {
      const lane = screen.getByRole("region", { name: "Up Next" });
      expect([...lane.querySelectorAll("h4")].map((h) => h.textContent)).toEqual([
        "Term merge",
        "Prune closed beads",
      ]);
    });
    expect(screen.getByRole("group", { name: "Rank 1 — P0 · Feature · unblocks 3" })).toBeTruthy();
  });

  it("says so instead of writing when the drop is inside one priority band", async () => {
    const fetchMock = stubFetch();
    const tied = [
      entry("anton-pick2", 1, { priority: 2, unblocks: 3 }),
      entry("anton-pick1", 2, { priority: 2, unblocks: 0 }),
    ];
    render(<EpicBoard slug="tmp" initialBoard={fixture(tied)} />);

    await drop("anton-pick1", "anton-pick2");

    await waitFor(() => expect(toastMessage).toHaveBeenCalled());
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/epics/anton-pick1"))).toBe(false);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("rolls the lane back when the priority write fails", async () => {
    stubFetch({ "/epics/anton-pick1": json({ error: "anton.db is locked" }, 500) });
    render(<EpicBoard slug="tmp" initialBoard={fixture(CROSSABLE)} />);

    await drop("anton-pick1", "anton-pick2");

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("anton.db is locked"));
    const lane = screen.getByRole("region", { name: "Up Next" });
    expect([...lane.querySelectorAll("h4")].map((h) => h.textContent)).toEqual([
      "Prune closed beads",
      "Term merge",
    ]);
  });
});
