// @vitest-environment jsdom
/**
 * Board drag-move must not snap back (anton-4g35). The regression: handleDragEnd optimistically
 * moved a card but the move endpoint answered `{ ok: true }` only, so the client never advanced its
 * version token. The next poll then sent the STALE version, the non-blocking poll path served the
 * retained PRE-MOVE snapshot stamped with the already-advanced version, and the client wholesale-
 * reverted the just-moved card. The fix: the endpoint returns the post-move board and the client
 * adopts its version, so the next poll 304s instead of reverting.
 *
 * dnd-kit's keyboard/pointer sensors can't resolve droppables under jsdom's zero-size rects, so we
 * mock @dnd-kit/core to capture the real onDragEnd handler and invoke it directly — exercising the
 * actual handleDragEnd + poll interaction, not a reimplementation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { DragEndEvent } from "@dnd-kit/core";

import { STAGES, type Board, type Epic, type Stage } from "@/lib/types";
import { STAGE_LABELS } from "@/components/board/board-utils";

const LABEL_TO_STAGE = Object.fromEntries(
  STAGES.map((s) => [STAGE_LABELS[s], s]),
) as Record<string, Stage>;

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Capture the board's onDragEnd so a test can fire a synthetic drop; stub the rest of the dnd-kit
// surface the board subtree touches (droppable/draggable hooks, sensors, overlay) as inert.
let dragEndHandler: ((e: DragEndEvent) => void) | undefined;
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
vi.mock("@dnd-kit/utilities", () => ({ CSS: { Translate: { toString: () => "" } } }));

// Import after the mocks are registered.
const { EpicBoard } = await import("@/components/board/epic-board");

function epic(id: string, stage: Stage): Epic {
  return {
    id,
    title: id,
    approved: false,
    stage,
    assignee: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    createdBy: null,
    blockedBy: [],
    ready: true,
    rank: 0,
    priority: 2,
    abandoned: false,
    tickets: [],
  };
}

/** A board with a single epic sitting in `cardStage`. */
function board(version: string, cardStage: Stage): Board {
  const columns = Object.fromEntries(STAGES.map((s) => [s, [] as Epic[]])) as Record<Stage, Epic[]>;
  columns[cardStage] = [epic("anton-1", cardStage)];
  const standalone = Object.fromEntries(
    STAGES.map((s) => [s, []]),
  ) as unknown as Board["standalone"];
  return {
    projectSlug: "tmp",
    version,
    columns,
    standalone,
    sync: { state: "synced", lastSyncedAt: 1, lastPushedAt: 1, unpushedCount: 0, lastError: null },
  };
}

/** The column a card currently lives in — the nearest ancestor holding a column heading. The card
 * is located by its unique epic link href (its title text appears in several nodes). */
function columnOf(cardId: string): Stage | undefined {
  const link = document.querySelector(`a[href="/projects/tmp/epics/${cardId}"]`);
  let el: HTMLElement | null = (link as HTMLElement | null)?.parentElement ?? null;
  while (el) {
    const heading = el.querySelector("h2");
    if (heading?.textContent) return LABEL_TO_STAGE[heading.textContent];
    el = el.parentElement;
  }
  return undefined;
}

afterEach(() => {
  cleanup();
  dragEndHandler = undefined;
  vi.restoreAllMocks();
});

describe("EpicBoard drag-move (anton-4g35)", () => {
  it("keeps a moved card put across a poll instead of snapping it back to the old column", async () => {
    // The move POST returns the post-move board stamped "2:sync". A poll THAT SENDS THE PRE-MOVE
    // version ("1:sync") gets the revert board — pre-move data stamped "2:sync" — reproducing the
    // bug; a poll that sends "2:sync" (the fix advanced the token) 304s. So a revert can only happen
    // if the client failed to adopt the move response's version.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/cards/anton-1/move")) {
        return new Response(JSON.stringify({ ok: true, board: board("2:sync", "implementing") }), {
          status: 200,
        });
      }
      // Poll. A stale token (pre-move "1:sync") would be served the revert board; the advanced token
      // ("2:sync") 304s. Match on the version query param.
      if (url.includes("version=2%3Async") || url.includes("version=2:sync")) {
        return new Response(null, { status: 304 });
      }
      return new Response(JSON.stringify({ board: board("2:sync", "backlog") }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<EpicBoard slug="tmp" initialBoard={board("1:sync", "backlog")} />);
    expect(columnOf("anton-1")).toBe("backlog");

    // Fire the real handleDragEnd: drop the card from backlog into implementing.
    dragEndHandler?.({
      active: { id: "anton-1", data: { current: { stage: "backlog" } } },
      over: { id: "implementing" },
    } as unknown as DragEndEvent);

    // Optimistic + authoritative: the card lands in implementing.
    await waitFor(() => expect(columnOf("anton-1")).toBe("implementing"));

    // Now poll (the tab-refocus path runs load() immediately). With the version advanced this 304s;
    // without the fix it would fetch the revert board and snap the card back to backlog.
    fireEvent(document, new Event("visibilitychange"));

    // Give the poll a chance to land, then assert the card never reverted.
    await waitFor(() => {
      const polled = fetchMock.mock.calls.some((c) => String(c[0]).includes("/board?version="));
      expect(polled).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(columnOf("anton-1")).toBe("implementing");

    // The poll advanced its token off the move response — it asked for the post-move version.
    const pollUrls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/board?version="));
    expect(pollUrls.some((u) => u.includes("version=2"))).toBe(true);
  });
});
