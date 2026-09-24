// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useVisiblePoll } from "./use-visible-poll";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("coalesces visibility events with pending polls, skips hidden tabs, and aborts on teardown", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  let finish!: () => void;
  const read = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const { unmount } = renderHook(() => useVisiblePoll(read, 1000));
  await act(() => vi.advanceTimersByTimeAsync(1000));
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  visibility.mockReturnValue("hidden");
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(read).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(read).toHaveBeenCalledTimes(2);
  const signal = (read.mock.calls as unknown as [AbortSignal][])[0]![0];
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => finish());
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(read).toHaveBeenCalledTimes(2);
});

it("continues polling after a rejected read", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const read = vi.fn().mockRejectedValue(new Error("offline"));
  renderHook(() => useVisiblePoll(read, 1000));
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(read).toHaveBeenCalledTimes(2);
});
