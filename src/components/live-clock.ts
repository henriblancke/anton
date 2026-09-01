"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * The wall clock, as a value that re-renders its readers (PR #212 review).
 *
 * Relative labels — "3m ago", "23h" — are pure functions of "now", so a component that reads the
 * clock during render is frozen at whatever it said when something else last re-rendered it. On a
 * board left open that is most of the day: a poll that answers 304 re-renders nothing.
 *
 * `useSyncExternalStore` with a `null` server snapshot rather than an effect that seeds state: React
 * reads `getServerSnapshot` on BOTH sides of hydration by construction, so the server prerender and
 * the browser's hydration pass cannot disagree about the time. Readers render their absolute or
 * static form until the subscription lands, which is one frame.
 *
 * ONE timer per cadence, shared by every reader on it: a board can carry dozens of deferred chips,
 * and dozens of intervals to move one text label each is a cost nobody asked for. `getSnapshot`
 * returns the cached tick — never a fresh `Date.now()` — because `useSyncExternalStore` requires a
 * value that is stable between notifications.
 */
interface Ticker {
  value: number | null;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
}

const tickers = new Map<number, Ticker>();

function tickerFor(intervalMs: number): Ticker {
  const existing = tickers.get(intervalMs);
  if (existing) return existing;
  const created: Ticker = { value: null, listeners: new Set(), timer: null };
  tickers.set(intervalMs, created);
  return created;
}

/** Live epoch-ms on the given cadence: `null` until mount (SSR-safe), then ticking. */
export function useLiveNow(intervalMs: number): number | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const ticker = tickerFor(intervalMs);
      ticker.listeners.add(onChange);
      if (ticker.timer === null) {
        ticker.value = Date.now();
        ticker.timer = setInterval(() => {
          ticker.value = Date.now();
          for (const listener of ticker.listeners) listener();
        }, intervalMs);
      }
      return () => {
        ticker.listeners.delete(onChange);
        if (ticker.listeners.size === 0 && ticker.timer !== null) {
          clearInterval(ticker.timer);
          ticker.timer = null;
          // Dropped with the timer: a value left behind would be read as current by whatever mounts
          // next, before the first tick of its own subscription.
          ticker.value = null;
        }
      };
    },
    [intervalMs],
  );
  return useSyncExternalStore(
    subscribe,
    () => tickerFor(intervalMs).value,
    () => null,
  );
}
