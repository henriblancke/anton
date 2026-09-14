"use client";

import { useEffect } from "react";

/**
 * Re-run `read` every `intervalMs`, but only while the tab is visible — and immediately whenever the
 * operator comes back to it. Both reads behind the epic board (the cards and the autopilot breaker)
 * want exactly this: a periodic GET that is wasted on a hidden tab and stale the moment someone
 * returns to it, so the loop lives here once rather than twice.
 *
 * `read` is handed the effect's AbortSignal, which aborts on teardown. A response landing after that
 * drops itself instead of writing to a board that is gone.
 *
 * `read` must be referentially stable (a `useCallback`) — it keys the effect.
 */
export function useVisiblePoll(read: (signal: AbortSignal) => Promise<void>, intervalMs: number) {
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      if (document.visibilityState === "visible") await read(controller.signal);
      // Reschedule even after a skipped or failed read: a poll that gives up once stops being live
      // sync for the rest of the session.
      if (!controller.signal.aborted) timer = setTimeout(() => void tick(), intervalMs);
    }

    timer = setTimeout(() => void tick(), intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void read(controller.signal);
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [read, intervalMs]);
}
