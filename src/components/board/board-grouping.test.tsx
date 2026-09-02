// @vitest-environment jsdom
/**
 * The epic swimlane view (anton-9pkk.4) is a regrouping of the stage board's own cards, not a second
 * board. The load-bearing test renders ONE fixture in both groupings and asserts a card's markup is
 * byte-identical across them — which can only hold while both modes render the same EpicCard. A
 * forked lane card would drift that markup and fail here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { STAGES, type Board, type Epic, type StandaloneItem, type Stage } from "@/lib/types";
import { makeEpicRow } from "@/components/board/epic.fixture";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

// The board reads its Epic/Area narrowing from the URL; grouping is orthogonal to it, so this
// suite runs on an unfiltered URL. The filter behaviour itself is covered in epic-filter.test.tsx.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects/tmp",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

// dnd-kit can't resolve droppables under jsdom's zero-size rects; the board's drag behaviour is
// covered in epic-board.test.tsx, so here the whole surface is inert.
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

const OUTCOME = { id: "anton-epc", title: "Ontology editing for curators" };

/** Every run-target card in the fixture — two under the epic, one with none. */
const CARD_IDS = ["anton-1", "anton-2", "anton-3"];

type Grouping = "Stage" | "Epic";

const epic = makeEpicRow;

function standalone(id: string, over: Partial<StandaloneItem> = {}): StandaloneItem {
  return {
    id,
    title: id,
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
    ...over,
  };
}

/**
 * One fixture, three groups of cards: two run targets under the same product epic (one of them
 * shipped), one with no epic at all, and a parentless chip. Both groupings are rendered from this.
 */
function fixture(): Board {
  const columns = Object.fromEntries(STAGES.map((s) => [s, [] as Epic[]])) as Record<Stage, Epic[]>;
  const chips = Object.fromEntries(
    STAGES.map((s) => [s, [] as StandaloneItem[]]),
  ) as Record<Stage, StandaloneItem[]>;

  columns.backlog = [epic("anton-1", { title: "Term merge", epic: OUTCOME })];
  columns.done = [epic("anton-2", { title: "Ship the editor", stage: "done", epic: OUTCOME })];
  columns.implementing = [epic("anton-3", { title: "Prune closed beads", stage: "implementing" })];
  chips.backlog = [standalone("anton-t3x", { title: "Board drag snaps back on drop" })];

  return {
    projectSlug: "tmp",
    version: "1:sync",
    columns,
    standalone: chips,
    operatorQueue: [],
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

/** The generation the picks below were drawn from — what an answer to one must name. */
const PLAN_ID = "plan-gen-1";

/**
 * The same fixture with the picker's mark on one card and one chip, and a recorded plan behind them.
 * Grouping by epic leaves both picks in their epic's Backlog slice — no lane, and so no row to carry
 * the decision (PR #212 review).
 */
function picked(): Board {
  const board = fixture();
  board.columns.backlog = board.columns.backlog.map((e) => ({
    ...e,
    provenance: [{ kind: "policy" as const }],
  }));
  board.standalone.backlog = board.standalone.backlog.map((i) => ({
    ...i,
    provenance: [{ kind: "policy" as const }],
  }));
  return {
    ...board,
    upNext: [
      { beadId: "anton-1", rank: 1, priority: 2, type: "feature", unblocks: 0, createdAt: "2026-08-01T00:00:00.000Z" },
      { beadId: "anton-t3x", rank: 2, priority: 2, type: "bug", unblocks: 0, createdAt: "2026-08-01T00:00:00.000Z" },
    ],
    upNextPlanId: PLAN_ID,
  };
}

/** The EpicCard root for a card — the element wrapping its full-card deep link. */
function cardMarkup(cardId: string): string {
  const link = document.querySelector(`a[href="/projects/tmp/epics/${cardId}"]`);
  const root = (link as HTMLElement | null)?.parentElement;
  if (!root) throw new Error(`no card rendered for ${cardId}`);
  return root.outerHTML;
}

function toggleTo(label: Grouping) {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

/** Whether the segmented control currently reads as being on `label`. */
function pressed(label: Grouping): boolean {
  return screen.getByRole("button", { name: label }).getAttribute("aria-pressed") === "true";
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

describe("board grouping (anton-9pkk.4)", () => {
  it("renders the same card markup in stage columns and in epic swimlanes", () => {
    render(<EpicBoard slug="tmp" initialBoard={fixture()} />);

    const inStageView = CARD_IDS.map(cardMarkup);

    toggleTo("Epic");
    const inLaneView = CARD_IDS.map(cardMarkup);

    // Identical markup on both sides: the swimlanes reuse EpicCard rather than reimplementing it.
    expect(inLaneView).toEqual(inStageView);
  });

  it("defaults to stage columns and switches to lanes only on request", () => {
    render(<EpicBoard slug="tmp" initialBoard={fixture()} />);

    // Stage view: the four stage headings, no lane chrome.
    expect(pressed("Stage")).toBe(true);
    expect(screen.queryByRole("region", { name: `Epic ${OUTCOME.title}` })).toBeNull();

    toggleTo("Epic");
    expect(pressed("Epic")).toBe(true);
    expect(screen.getByRole("region", { name: `Epic ${OUTCOME.title}` })).toBeTruthy();
  });

  it("heads each lane with its epic, its id and a feature rollup", () => {
    render(<EpicBoard slug="tmp" initialBoard={fixture()} />);
    toggleTo("Epic");

    const lane = screen.getByRole("region", { name: `Epic ${OUTCOME.title}` });
    expect(lane.textContent).toContain(OUTCOME.title);
    expect(lane.textContent).toContain(OUTCOME.id);
    // Two run targets under the epic, one of them in done.
    expect(lane.textContent).toContain("1 of 2 features shipped");
  });

  it("collects epic-less run targets and standalone chips in a final No epic lane", () => {
    render(<EpicBoard slug="tmp" initialBoard={fixture()} />);
    toggleTo("Epic");

    const lanes = screen.getAllByRole("region");
    expect(lanes.map((l) => l.getAttribute("aria-label"))).toEqual([
      `Epic ${OUTCOME.title}`,
      "No epic",
    ]);

    const noEpic = lanes[1];
    expect(noEpic.textContent).toContain("Prune closed beads");
    expect(noEpic.textContent).toContain("Board drag snaps back on drop");
    expect(noEpic.textContent).toContain("2 loose run targets");
  });

  it("answers a pick in full — Release AND both vetoes — where there is no Up Next row", () => {
    render(<EpicBoard slug="tmp" initialBoard={picked()} />);
    toggleTo("Epic");

    // The lane is a column position, so grouping by epic leaves the picks in Backlog. Every way to
    // answer one has to come with them, or this layout can start a pick but never refuse it.
    // Both picks — the card and the chip — carry all three answers.
    expect(screen.getAllByRole("button", { name: /release/i })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /not now/i })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Never" })).toHaveLength(2);
  });

  it("names the generation on screen, so the decline answers the pick that was shown", async () => {
    const until = Date.now() + 24 * 60 * 60 * 1000;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/picker/veto")
        ? new Response(JSON.stringify({ beadId: "anton-1", action: "not-now", deferredUntil: until }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response(null, { status: 304 }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<EpicBoard slug="tmp" initialBoard={picked()} />);
    toggleTo("Epic");

    fireEvent.click(screen.getAllByRole("button", { name: /not now/i })[0]);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/tmp/picker/veto",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ beadId: "anton-1", action: "not-now", planId: PLAN_ID }),
        }),
      ),
    );
    // The hold lands on the card here exactly as it does in the lane: the target reads as set aside
    // on the click, and stops offering the answer it was just given.
    await waitFor(() => expect(screen.getByText(/not now ·/i)).toBeTruthy());
    expect(screen.getAllByRole("button", { name: /not now/i })).toHaveLength(1);
  });

  it("keeps the two answers exclusive — a veto in flight closes the Release beside it", async () => {
    // One decision per pick, the same lock the lane's row holds (PR #212 review): with the row gone
    // the card owns it, or the swimlanes could release a target they are deferring.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (input: RequestInfo | URL) =>
          new Promise<Response>((resolve) => {
            if (!String(input).includes("/picker/veto")) resolve(new Response(null, { status: 304 }));
          }),
      ) as unknown as typeof fetch,
    );
    render(<EpicBoard slug="tmp" initialBoard={picked()} />);
    toggleTo("Epic");

    fireEvent.click(screen.getAllByRole("button", { name: /not now/i })[0]);

    // The vetoed pick's Release closes; the other pick's stays open — the lock is per pick, never
    // per board.
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("button", { name: /release/i })
          .map((b) => b.hasAttribute("disabled")),
      ).toEqual([true, false]),
    );
  });

  it("remembers the grouping per project", () => {
    const { unmount } = render(<EpicBoard slug="tmp" initialBoard={fixture()} />);
    toggleTo("Epic");
    unmount();

    // Same project: the board reopens on the swimlanes.
    const reopened = render(<EpicBoard slug="tmp" initialBoard={fixture()} />);
    expect(pressed("Epic")).toBe(true);
    reopened.unmount();

    // Another project keeps the stage default — the preference is per board, not global.
    render(<EpicBoard slug="other" initialBoard={{ ...fixture(), projectSlug: "other" }} />);
    expect(pressed("Stage")).toBe(true);
  });
});
