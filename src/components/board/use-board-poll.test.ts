// @vitest-environment jsdom
/**
 * The poll's error contract: an error UI appears only when a failed read leaves NOTHING to show.
 * The check reads the committed board off a ref rather than out of a `setBoard` updater — React may
 * replay an updater (it does, twice, under StrictMode), and a replayed `setError` is a side effect
 * fired from a render that may never commit. These tests render under StrictMode for that reason.
 */
import { StrictMode, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { STAGES, type Board, type Epic, type Stage } from "@/lib/types";
import { makeEpicRow } from "@/components/board/epic.fixture";
import { useBoardPoll } from "@/components/board/use-board-poll";

function board(version = "1:sync"): Board {
  const columns = Object.fromEntries(STAGES.map((s) => [s, [] as Epic[]])) as Record<Stage, Epic[]>;
  columns.backlog = [makeEpicRow("anton-1")];
  return {
    projectSlug: "tmp",
    version,
    columns,
    standalone: Object.fromEntries(STAGES.map((s) => [s, []])) as unknown as Board["standalone"],
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

const strict = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useBoardPoll error surfacing", () => {
  it("surfaces a failed read when there is no board to fall back on", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));

    const { result } = renderHook(() => useBoardPoll("tmp", null), { wrapper: strict });

    await waitFor(() => expect(result.current.error).toBe("Failed to load board (500)"));
    expect(result.current.board).toBeNull();
  });

  it("keeps the last good board and stays error-free when a later read fails", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));

    const seed = board();
    const { result } = renderHook(() => useBoardPoll("tmp", seed), { wrapper: strict });

    await act(async () => {
      await result.current.reload();
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.board).toBe(seed);
  });

  it("clears a board-less error once a read finally lands", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));

    const { result } = renderHook(() => useBoardPoll("tmp", null), { wrapper: strict });
    await waitFor(() => expect(result.current.error).toBe("Failed to load board (500)"));

    const next = board("2:sync");
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ board: next }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.board?.version).toBe("2:sync");
  });
});

describe("a forced read queued behind an in-flight one", () => {
  it("is served once the first settles, unconditionally", async () => {
    const pending: Array<(res: Response) => void> = [];
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => pending.push(resolve)),
    );

    const seed = board();
    const { result } = renderHook(() => useBoardPoll("tmp", seed), { wrapper: strict });

    let first!: Promise<void>;
    act(() => {
      first = result.current.reload();
    });
    await waitFor(() => expect(pending).toHaveLength(1));

    // The second force lands while the first read is still out — it must not be dropped.
    act(() => {
      void result.current.reload();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const next = board("2:sync");
    const body = JSON.stringify({ board: next });
    await act(async () => {
      pending[0](new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
      await waitFor(() => expect(pending).toHaveLength(2));
      // A forced read never sends the version it already holds, or the server would 304 it.
      expect(fetchMock.mock.calls[1][0]).toBe("/api/projects/tmp/board");
      pending[1](new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
      await first;
    });

    expect(result.current.board?.version).toBe("2:sync");
  });
});

/**
 * The optimistic veto's effect on the lane (anton-w579 / PR #226 review).
 *
 * Vetoing is the interaction that most often empties Up Next, so it is the one that must not undo
 * the named absence: the lane going silent on the click that emptied it reads as "anton has nothing
 * to start" for a whole poll, which is the very reading the absence copy exists to prevent.
 */
describe("vetoing the last pick", () => {
  const ranked = (...ids: string[]): Board => ({
    ...board(),
    upNext: ids.map((beadId, i) => ({
      beadId,
      rank: i + 1,
      type: "feature" as const,
      unblocks: 0,
      createdAt: "2026-01-01T00:00:00Z",
    })),
    upNextPlanId: "plan-1",
  });

  it("keeps the lane, naming the emptiness the veto just created", () => {
    const seed = ranked("anton-1");
    const { result } = renderHook(() => useBoardPoll("tmp", seed), { wrapper: strict });

    act(() => result.current.vetoBead("anton-1", 2_000_000_000_000));

    expect(result.current.board?.upNext).toBeUndefined();
    expect(result.current.board?.upNextAbsence).toBe("no-claimable-work");
    // No lane, no generation to answer against — the server's own contract for an absent lane.
    expect(result.current.board?.upNextPlanId).toBeUndefined();
  });

  it("leaves the lane and its generation alone while picks remain", () => {
    const seed = ranked("anton-1", "anton-2");
    const { result } = renderHook(() => useBoardPoll("tmp", seed), { wrapper: strict });

    act(() => result.current.vetoBead("anton-1", 2_000_000_000_000));

    expect(result.current.board?.upNext?.map((e) => e.beadId)).toEqual(["anton-2"]);
    expect(result.current.board?.upNextAbsence).toBeUndefined();
    expect(result.current.board?.upNextPlanId).toBe("plan-1");
  });

  it("does not invent a lane for a board that never had one", () => {
    // A disarmed pass draws no lane, and vetoing a Backlog card from its own row must not rewrite
    // that into "nothing claimable" — a different absence with a different clearing condition.
    const seed: Board = { ...board(), upNextAbsence: "disarmed" };
    const { result } = renderHook(() => useBoardPoll("tmp", seed), { wrapper: strict });

    act(() => result.current.vetoBead("anton-1", 2_000_000_000_000));

    expect(result.current.board?.upNextAbsence).toBe("disarmed");
    expect(result.current.board?.upNext).toBeUndefined();
  });
});
