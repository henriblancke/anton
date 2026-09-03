// @vitest-environment jsdom
/**
 * The unwatched-park signal has to stay live (anton-kh98). Held at the page's first render it would
 * make exactly the two mistakes the band exists to prevent: staying silent through a park that
 * happened after the board loaded, and going on warning about a watcher another tab already armed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import type { UnwatchedParks } from "@/lib/types";
import {
  UNWATCHED_PARKS_POLL_MS,
  useUnwatchedParks,
} from "@/components/board/use-unwatched-parks";

const HOUR = 3_600_000;

function parks(o: Partial<UnwatchedParks> = {}): UnwatchedParks {
  return { parkedCount: 3, oldestAgeMs: 5 * HOUR, disarmed: ["run-health"], ...o };
}

const answer = (value: UnwatchedParks | null) =>
  new Response(JSON.stringify({ parks: value }), { status: 200 });

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The poll's own trigger: returning to the tab reads immediately, without waiting out a beat. */
async function pollNow() {
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
  });
}

describe("useUnwatchedParks", () => {
  it("surfaces work that parked after the board loaded", async () => {
    fetchMock.mockResolvedValue(answer(parks()));

    const { result } = renderHook(() => useUnwatchedParks("tmp", undefined));
    expect(result.current.parks).toBeUndefined();

    await pollNow();

    await waitFor(() => expect(result.current.parks).toEqual(parks()));
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/projects/tmp/unwatched-parks");
  });

  it("drops the band once another tab has armed the watcher", async () => {
    fetchMock.mockResolvedValue(answer(null));

    const { result } = renderHook(() => useUnwatchedParks("tmp", parks()));
    expect(result.current.parks).toEqual(parks());

    await pollNow();

    await waitFor(() => expect(result.current.parks).toBeUndefined());
  });

  it("polls on its own cadence, not only on refocus", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(answer(parks()));
      const { result } = renderHook(() => useUnwatchedParks("tmp", undefined));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(UNWATCHED_PARKS_POLL_MS);
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.current.parks).toEqual(parks());
    } finally {
      vi.useRealTimers();
    }
  });

  // The band's arm button writes the very rows this reads, and a minute of stale band after the
  // click would read as a switch that did nothing.
  it("re-reads immediately when the band asks", async () => {
    fetchMock.mockResolvedValue(answer(null));

    const { result } = renderHook(() => useUnwatchedParks("tmp", parks()));

    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.parks).toBeUndefined());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Clearing the band on a blip would tell the operator their queue is watched when it is not.
  it("keeps the band it has when a read fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() => useUnwatchedParks("tmp", parks()));
    await pollNow();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.parks).toEqual(parks());
  });

  // A server prop is a new object on every page render; comparing it by identity would restart the
  // render that read it, and throw away the poll's answer on any parent re-render besides.
  it("keeps the polled answer when the server read says the same thing again", async () => {
    fetchMock.mockResolvedValue(answer(null));

    const { result, rerender } = renderHook(
      ({ server }: { server?: UnwatchedParks }) => useUnwatchedParks("tmp", server),
      { initialProps: { server: parks() as UnwatchedParks | undefined } },
    );
    await pollNow();
    await waitFor(() => expect(result.current.parks).toBeUndefined());

    rerender({ server: parks() });
    expect(result.current.parks).toBeUndefined();
  });

  it("lets a fresh server read supersede what was polled", async () => {
    fetchMock.mockResolvedValue(answer(parks({ parkedCount: 9 })));

    const { result, rerender } = renderHook(
      ({ server }: { server?: UnwatchedParks }) => useUnwatchedParks("tmp", server),
      { initialProps: { server: parks() as UnwatchedParks | undefined } },
    );
    await pollNow();
    await waitFor(() => expect(result.current.parks?.parkedCount).toBe(9));

    // A re-rendered page has the newer answer — the watcher it says is armed outranks the poll.
    rerender({ server: undefined });
    expect(result.current.parks).toBeUndefined();
  });
});
