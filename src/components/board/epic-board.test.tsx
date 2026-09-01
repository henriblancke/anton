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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DragEndEvent } from "@dnd-kit/core";
import { toast } from "sonner";

import { STAGES, type Board, type Epic, type Stage } from "@/lib/types";
import { makeEpicRow } from "@/components/board/epic.fixture";
import { STAGE_LABELS } from "@/components/board/board-utils";

const LABEL_TO_STAGE = Object.fromEntries(
  STAGES.map((s) => [STAGE_LABELS[s], s]),
) as Record<string, Stage>;

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

// The board reads its Epic/Area narrowing from the URL; a drag-move is orthogonal to it, so this
// suite runs on an unfiltered URL. The filter behaviour itself is covered in epic-filter.test.tsx.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects/tmp",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

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

// Import after the mocks are registered.
const { EpicBoard } = await import("@/components/board/epic-board");

const epic = (id: string, stage: Stage): Epic => makeEpicRow(id, { stage });

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

describe("EpicBoard refreshed server board", () => {
  it("adopts a board handed down by router.refresh() instead of holding the stale one", async () => {
    // `[Release]` answers a lost claim race with router.refresh(), which re-renders the page and
    // hands down a fresh server board. `board` is client-owned after mount, so without adopting the
    // new prop the card keeps offering a pick that already 409s until the next 30s beat.
    // Every board poll 304s: the refresh must land on its own, not on a fetch it happened to race.
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/board") ? new Response(null, { status: 304 }) : new Response(null, { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { rerender } = render(<EpicBoard slug="tmp" initialBoard={board("1:sync", "backlog")} />);
    expect(columnOf("anton-1")).toBe("backlog");

    rerender(<EpicBoard slug="tmp" initialBoard={board("2:sync", "implementing")} />);
    await waitFor(() => expect(columnOf("anton-1")).toBe("implementing"));

    // And the refreshed version came with it, so the next poll asks on it rather than re-fetching
    // the answer it already holds.
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/board?version="))).toBe(true),
    );
    const pollUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(pollUrls.some((u) => u.includes("version=2%3Async") || u.includes("version=2:sync"))).toBe(
      true,
    );
  });
});

describe("EpicBoard autopilot breaker (anton-5c8h)", () => {
  /** The band the board must be able to draw and retire on its own: the WIP hold, at its limit. */
  const hold = {
    kind: "hold" as const,
    reason: "wip-limit" as const,
    detail: "4 of 4 PRs are waiting on review.",
  };

  /** Answer the breaker endpoint with `breaker`; 304 everything else (the board poll). */
  function stubBreaker(next: () => Response) {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/autopilot/breaker") ? next() : new Response(null, { status: 304 }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    return fetchMock;
  }

  const breakerJson = (breaker: unknown) =>
    new Response(JSON.stringify({ breaker }), { status: 200 });

  it("retires the hold band when the PR that released it merges, with no reload", async () => {
    // The release happens on GitHub: a merge changes nothing on an open board, so the band can only
    // clear if the board re-reads the breaker for itself.
    let current: unknown = hold;
    stubBreaker(() => breakerJson(current));

    render(<EpicBoard slug="tmp" initialBoard={board("1:sync", "backlog")} />);

    // Returning to the tab re-reads immediately — the poll's own cadence is a minute.
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(screen.getByText("Autopilot is holding")).toBeTruthy());

    current = null;
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(screen.queryByText("Autopilot is holding")).toBeNull());
  });

  it("keeps the band up when the breaker read fails", async () => {
    // Answering a transient failure with "nothing is stopped" would tell the operator anton is
    // running while it is frozen — the one error this band must not make.
    let fail = false;
    const fetchMock = stubBreaker(() =>
      fail ? new Response("boom", { status: 500 }) : breakerJson(hold),
    );

    render(<EpicBoard slug="tmp" initialBoard={board("1:sync", "backlog")} />);
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(screen.getByText("Autopilot is holding")).toBeTruthy());

    fail = true;
    const readsBefore = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/autopilot/breaker"),
    ).length;
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter((c) => String(c[0]).includes("/autopilot/breaker")).length,
      ).toBeGreaterThan(readsBefore),
    );
    expect(screen.getByText("Autopilot is holding")).toBeTruthy();
  });
});

/**
 * The lane is driven by the recorded plan, and the pass that rewrites it is up to ten minutes away
 * (anton-t9m4 / anton-jqvy). So a veto has to leave the lane on the click that recorded it — a
 * declined target keeping its place in the ranking is the lane still offering the start the operator
 * just refused.
 */
describe("EpicBoard veto from the Up Next lane", () => {
  const UNTIL = 1_800_086_400_000;

  const planned = (version: string): Board => ({
    ...board(version, "backlog"),
    upNext: [
      {
        beadId: "anton-1",
        rank: 1,
        priority: 2,
        type: "feature",
        unblocks: 0,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    ],
  });

  /** Is the card drawn inside the lane (as opposed to back in a stage column)? */
  const inUpNext = (cardId: string) =>
    document.querySelector(
      `section[aria-label="Up Next"] a[href="/projects/tmp/epics/${cardId}"]`,
    ) !== null;

  it("returns a declined target to Backlog on the click, not on the next picker pass", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("/picker/veto")
        ? new Response(JSON.stringify({ deferredUntil: UNTIL }), { status: 200 })
        : new Response(null, { status: 304 }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<EpicBoard slug="tmp" initialBoard={planned("1:sync")} />);
    expect(inUpNext("anton-1")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /not now/i }));

    await waitFor(() => expect(inUpNext("anton-1")).toBe(false));
    expect(columnOf("anton-1")).toBe("backlog");
  });

  it("keeps a declined target out of the lane when a poll fetched before the veto lands after it", async () => {
    // The deferral a veto records moves the board version, so it is a board write like any other —
    // but the poll already out asked on the PRE-veto board. Believing its answer puts the declined
    // pick back in the lane with its controls live, and the operator declines the same one twice.
    let landPoll: (() => void) | undefined;
    const pollHeld = new Promise<void>((resolve) => {
      landPoll = () => resolve();
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/picker/veto")) {
        return new Response(JSON.stringify({ deferredUntil: UNTIL }), { status: 200 });
      }
      if (String(url).includes("/board")) {
        await pollHeld;
        return new Response(JSON.stringify({ board: planned("2:sync") }), { status: 200 });
      }
      return new Response(null, { status: 304 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<EpicBoard slug="tmp" initialBoard={planned("1:sync")} />);

    // A poll leaves on the pre-veto board (returning to the tab reads immediately), then the
    // operator declines the pick while it is still out.
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/board"))).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    await waitFor(() => expect(inUpNext("anton-1")).toBe(false));

    landPoll?.();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(inUpNext("anton-1")).toBe(false);
    expect(columnOf("anton-1")).toBe("backlog");
  });
});

/**
 * A reorder inside the lane must not flip back (anton-7bzg / R3.8). The priority PATCH answers with
 * the epic detail, not a board, so there is no post-write version to adopt the way the stage-move
 * path does (anton-4g35): a client that kept polling on the PRE-WRITE token would take the board
 * route's non-blocking path, be served the retained pre-write snapshot stamped with the
 * already-advanced version, and re-show the very order the drag just corrected. Dropping the token
 * sends the next poll versionless, onto the blocking post-write path.
 */
describe("EpicBoard reorder inside Up Next", () => {
  /** Priority, unblocking value and age as the pass that ranked them recorded them: `anton-2` frees
   *  more work than the P0 above it, so promoting it is a drop the priority channel can state. */
  const LANE = {
    "anton-1": { priority: 0, unblocks: 0, createdAt: "2026-08-01T00:00:00.000Z" },
    "anton-2": { priority: 2, unblocks: 5, createdAt: "2026-08-02T00:00:00.000Z" },
  };

  /** A board whose lane ranks `order`, with both targets in the Backlog it was taken out of. */
  function planned(version: string, order: (keyof typeof LANE)[]): Board {
    const base = board(version, "backlog");
    return {
      ...base,
      columns: {
        ...base.columns,
        backlog: [epic("anton-1", "backlog"), epic("anton-2", "backlog")],
      },
      upNext: order.map((beadId, index) => ({
        beadId,
        rank: index + 1,
        type: "feature" as const,
        ...LANE[beadId],
      })),
    };
  }

  /** The lane's cards, top to bottom — read off the one drag handle each row renders. */
  const laneOrder = () =>
    [
      ...document.querySelectorAll(
        'section[aria-label="Up Next"] button[aria-label^="Reorder "]',
      ),
    ].map((button) =>
      (button.getAttribute("aria-label") ?? "").replace(/^Reorder "|"$/g, ""),
    );

  /** The `not now` control on one lane row — every row renders one, so scope by its drag handle. */
  const vetoButton = (title: string) => {
    const row = document
      .querySelector(`section[aria-label="Up Next"] button[aria-label='Reorder "${title}"']`)
      ?.parentElement;
    const button = [...(row?.querySelectorAll("button") ?? [])].find((b) =>
      (b.textContent ?? "").toLowerCase().includes("not now"),
    );
    if (!button) throw new Error(`No veto control for ${title}`);
    return button;
  };

  it("withdraws the stale lane on the write's own settle, not a poll later", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/epics/anton-2")) {
        return new Response(JSON.stringify({ detail: {} }), { status: 200 });
      }
      // A poll on the stale token: the retained PRE-WRITE plan, stamped with the version the write
      // already advanced to. Reaching this at all is the regression.
      if (url.includes("/board?version=")) {
        return new Response(
          JSON.stringify({ board: planned("2:sync", ["anton-1", "anton-2"]) }),
          { status: 200 },
        );
      }
      // The versionless (blocking, post-write) read: a reprioritized bead is one the recorded plan
      // no longer describes, so the board withholds the lane until the next pass re-ranks it.
      if (url.includes("/board")) {
        const authoritative = planned("2:sync", ["anton-1", "anton-2"]);
        delete authoritative.upNext;
        return new Response(JSON.stringify({ board: authoritative }), { status: 200 });
      }
      return new Response(null, { status: 304 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<EpicBoard slug="tmp" initialBoard={planned("1:sync", ["anton-1", "anton-2"])} />);
    expect(laneOrder()).toEqual(["anton-1", "anton-2"]);

    dragEndHandler?.({
      active: { id: "anton-2", data: { current: { upNext: true, stage: "backlog" } } },
      over: { id: "anton-1", data: { current: { upNext: true, stage: "backlog" } } },
    } as unknown as DragEndEvent);

    // No poll is waited on: the write reads the authoritative board itself. Until it does, the lane
    // would still be offering [Release] against a plan the server has already invalidated — the
    // click that starts an ordinary approval carrying none of the picker accept it promises.
    await waitFor(() => expect(laneOrder()).toEqual([]));
    const boardReads = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/board"));
    expect(boardReads.length).toBe(1);
    expect(boardReads.every((u) => !u.includes("version="))).toBe(true);
    expect(columnOf("anton-2")).toBe("backlog");
  });

  it("ignores a poll that lands while the reorder is still in flight", async () => {
    // The write is a server round-trip, and the corrected order exists only optimistically until it
    // returns: a poll landing in that gap answers on the PRE-write plan, so believing it reverts the
    // lane on screen with nothing left to put it back until the next beat. Polls are suppressed for
    // the whole write instead — and the failure path still rolls back onto the LATEST board, which
    // the poll delivered once the write let it through.
    let failPatch: (() => void) | undefined;
    const patched = new Promise<Response>((resolve) => {
      failPatch = () => resolve(new Response(JSON.stringify({ error: "nope" }), { status: 500 }));
    });
    const arrived = planned("2:sync", ["anton-1", "anton-2"]);
    arrived.columns.implementing = [epic("anton-3", "implementing")];

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/epics/anton-2")) return patched;
      if (url.includes("/board")) {
        return new Response(JSON.stringify({ board: arrived }), { status: 200 });
      }
      return new Response(null, { status: 304 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<EpicBoard slug="tmp" initialBoard={planned("1:sync", ["anton-1", "anton-2"])} />);

    dragEndHandler?.({
      active: { id: "anton-2", data: { current: { upNext: true, stage: "backlog" } } },
      over: { id: "anton-1", data: { current: { upNext: true, stage: "backlog" } } },
    } as unknown as DragEndEvent);
    await waitFor(() => expect(laneOrder()).toEqual(["anton-2", "anton-1"]));

    // A poll lands while the PATCH is still in flight, bringing a card the drag knows nothing about.
    // It is discarded whole: taking it would have taken its pre-write lane with it.
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/board"))).toBe(true),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(columnOf("anton-3")).toBeUndefined();
    expect(laneOrder()).toEqual(["anton-2", "anton-1"]);

    failPatch?.();

    await waitFor(() => expect(laneOrder()).toEqual(["anton-1", "anton-2"]));

    // Rollback restored the lane only. The next poll — now unsuppressed — brings the rest of the
    // board it was holding back.
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(columnOf("anton-3")).toBe("implementing"));
  });

  it("discards a poll fetched on the pre-write version once the write has settled", async () => {
    // Dropping the token only helps polls issued AFTER the write. A poll already in flight when the
    // drop fired still carries the pre-write version, so the board route answers it on the
    // non-blocking path with the retained pre-write plan stamped with the version the write already
    // advanced to. Believing it after the write restores BOTH the old order and a token every later
    // poll 304s on — the drag undone until some other invalidation.
    let landPoll: (() => void) | undefined;
    const pollHeld = new Promise<void>((resolve) => {
      landPoll = () => resolve();
    });
    let landAuthoritative: (() => void) | undefined;
    const authoritativeHeld = new Promise<void>((resolve) => {
      landAuthoritative = () => resolve();
    });
    let settlePatch: (() => void) | undefined;
    const patched = new Promise<Response>((resolve) => {
      settlePatch = () => resolve(new Response(JSON.stringify({ detail: {} }), { status: 200 }));
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/epics/anton-2")) return patched;
      if (url.includes("/board?version=")) {
        await pollHeld;
        const stale = planned("2:sync", ["anton-1", "anton-2"]);
        // A card only the stale answer knows about, so adopting it would be visible.
        stale.columns.implementing = [epic("anton-3", "implementing")];
        return new Response(JSON.stringify({ board: stale }), { status: 200 });
      }
      if (url.includes("/board")) {
        await authoritativeHeld;
        const authoritative = planned("2:sync", ["anton-1", "anton-2"]);
        delete authoritative.upNext;
        return new Response(JSON.stringify({ board: authoritative }), { status: 200 });
      }
      return new Response(null, { status: 304 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<EpicBoard slug="tmp" initialBoard={planned("1:sync", ["anton-1", "anton-2"])} />);

    // A poll leaves on the pre-write token, then the drop fires while it is still out.
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/board?version="))).toBe(true),
    );
    dragEndHandler?.({
      active: { id: "anton-2", data: { current: { upNext: true, stage: "backlog" } } },
      over: { id: "anton-1", data: { current: { upNext: true, stage: "backlog" } } },
    } as unknown as DragEndEvent);
    await waitFor(() => expect(laneOrder()).toEqual(["anton-2", "anton-1"]));

    // The write settles first; the stale answer only lands after it.
    settlePatch?.();
    await new Promise((r) => setTimeout(r, 0));
    landPoll?.();
    await new Promise((r) => setTimeout(r, 0));

    expect(laneOrder()).toEqual(["anton-2", "anton-1"]);
    expect(columnOf("anton-3")).toBeUndefined();

    // And the write's own re-read is not lost behind that poll: it is queued while the stale answer
    // is in flight and asks versionlessly the moment it settles, which is what finally withdraws
    // the lane — no waiting out a poll interval with [Release] on offer against a dead plan.
    landAuthoritative?.();
    await waitFor(() => expect(laneOrder()).toEqual([]));
    const boardReads = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/board"));
    expect(boardReads.at(-1)).not.toContain("version=");
  });

  it("refuses a second reorder while the first is still being written", async () => {
    // Two reorders in flight cannot both be honoured: the rollback restores the pre-drag ORDER, so
    // the first one's failure would erase a second drop that succeeded, and the lane would sit on an
    // order neither write asked for until the next poll. The second drop is refused instead, and the
    // first still rolls back to exactly the order the board started in.
    let failPatch: (() => void) | undefined;
    const patched = new Promise<Response>((resolve) => {
      failPatch = () => resolve(new Response(JSON.stringify({ error: "nope" }), { status: 500 }));
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/epics/anton-2")) return patched;
      return new Response(null, { status: 304 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<EpicBoard slug="tmp" initialBoard={planned("1:sync", ["anton-1", "anton-2"])} />);

    dragEndHandler?.({
      active: { id: "anton-2", data: { current: { upNext: true, stage: "backlog" } } },
      over: { id: "anton-1", data: { current: { upNext: true, stage: "backlog" } } },
    } as unknown as DragEndEvent);
    await waitFor(() => expect(laneOrder()).toEqual(["anton-2", "anton-1"]));

    // The operator drops the other card back while the first PATCH is still out.
    dragEndHandler?.({
      active: { id: "anton-1", data: { current: { upNext: true, stage: "backlog" } } },
      over: { id: "anton-2", data: { current: { upNext: true, stage: "backlog" } } },
    } as unknown as DragEndEvent);
    await waitFor(() => expect(toast.message).toHaveBeenCalled());
    // Refused, not queued: no second PATCH, and the lane still shows the first drop.
    const patches = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/epics/"));
    expect(patches).toHaveLength(1);
    expect(laneOrder()).toEqual(["anton-2", "anton-1"]);

    failPatch?.();

    // The rollback has exactly one drag to undo, so the lane lands on the order it started in.
    await waitFor(() => expect(laneOrder()).toEqual(["anton-1", "anton-2"]));
  });

  it("does not re-offer a target vetoed while the reorder was in flight when the write fails", async () => {
    // The rollback restores the pre-drag ORDER, and a veto that lands in the same window removes its
    // target from the lane. Writing the pre-drag lane back whole would undo that veto — re-offering
    // the pick the operator just declined until the next beat.
    let failPatch: (() => void) | undefined;
    const patched = new Promise<Response>((resolve) => {
      failPatch = () => resolve(new Response(JSON.stringify({ error: "nope" }), { status: 500 }));
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/epics/anton-2")) return patched;
      if (url.includes("/picker/veto")) {
        return new Response(JSON.stringify({ deferredUntil: 1_800_086_400_000 }), { status: 200 });
      }
      return new Response(null, { status: 304 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<EpicBoard slug="tmp" initialBoard={planned("1:sync", ["anton-1", "anton-2"])} />);

    dragEndHandler?.({
      active: { id: "anton-2", data: { current: { upNext: true, stage: "backlog" } } },
      over: { id: "anton-1", data: { current: { upNext: true, stage: "backlog" } } },
    } as unknown as DragEndEvent);
    await waitFor(() => expect(laneOrder()).toEqual(["anton-2", "anton-1"]));

    // The operator declines the other target while the PATCH is still out.
    fireEvent.click(vetoButton("anton-1"));
    await waitFor(() => expect(laneOrder()).toEqual(["anton-2"]));

    vi.mocked(toast.error).mockClear();
    failPatch?.();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());

    expect(laneOrder()).toEqual(["anton-2"]);
    expect(columnOf("anton-1")).toBe("backlog");
  });
});
