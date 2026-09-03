"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { UnwatchedParks } from "@/lib/types";
import { useVisiblePoll } from "@/components/board/use-visible-poll";

/**
 * Unwatched-park freshness cadence (anton-kh98). Slower than the cards: what moves this signal is a
 * job parking, or a switch being flipped in settings — minute-scale events, not the second-scale
 * churn the columns track — and every board that has already armed the watcher pays for the poll.
 */
export const UNWATCHED_PARKS_POLL_MS = 60_000;

/** The live signal, plus the immediate re-read the band's own arm button needs. */
export interface UnwatchedParksSignal {
  /** Absent when the watcher is armed or nothing is parked — the band is silent in both cases. */
  parks?: UnwatchedParks;
  /** Re-read NOW, for a write that just changed the answer; the poll would be up to a minute away. */
  refresh: () => void;
}

/**
 * Keep the unwatched-park band honest while the board stays open (anton-kh98).
 *
 * The band's whole claim is about state that changes elsewhere — a run parks, or another tab arms
 * the watcher — so as a one-time page prop it would go on asserting a blind spot that has been
 * closed, and stay silent through the park it was built to surface. Both are exactly the false
 * board this signal exists to prevent.
 *
 * `server` is the page's server-rendered read: it owns the first paint (no band flash while the
 * first poll is out) and takes over again whenever a fresh one is handed down, since a page that
 * just re-rendered has the newer answer.
 */
export function useUnwatchedParks(slug: string, server?: UnwatchedParks): UnwatchedParksSignal {
  // Wrapped rather than stored bare: `undefined` is a real answer ("nothing to report, show no
  // band") and must not read as "not polled yet".
  const [polled, setPolled] = useState<{ value?: UnwatchedParks } | null>(null);
  // Adjusted during render rather than in an effect: a board handed a fresh server read must never
  // paint the superseded band once before dropping it. Compared by VALUE, not identity — a server
  // prop is a fresh object on every page render, and identity here would restart this render.
  const [lastServer, setLastServer] = useState(server);
  // Two reads can be in flight at once — the minute poll and the arm button's own refresh — and they
  // can land out of order. Only the newest answer this hook has asked for may write: a pre-arm
  // response landing after the click would otherwise restore the warning the click just cleared, and
  // leave it up for another minute.
  const generation = useRef(0);
  if (!sameSignal(server, lastServer)) {
    setLastServer(server);
    setPolled(null);
  }

  // A re-rendered page outranks every read that was already out — same staleness, other direction.
  useEffect(() => {
    generation.current += 1;
  }, [lastServer]);

  const read = useCallback(
    async (signal?: AbortSignal) => {
      const issued = (generation.current += 1);
      try {
        const res = await fetch(`/api/projects/${slug}/unwatched-parks`);
        if (!res.ok) return;
        const data = (await res.json()) as { parks: UnwatchedParks | null };
        if (issued === generation.current && !signal?.aborted)
          setPolled({ value: data.parks ?? undefined });
      } catch {
        // A failed read keeps the band that is up. Clearing it on a network blip would tell the
        // operator their queue is watched when it is not — the one error this band must not make.
      }
    },
    [slug],
  );

  const poll = useCallback((signal: AbortSignal) => read(signal), [read]);
  useVisiblePoll(poll, UNWATCHED_PARKS_POLL_MS);

  const refresh = useCallback(() => {
    void read();
  }, [read]);

  return { parks: polled ? polled.value : server, refresh };
}

/** Do two server reads say the same thing? Absence is an answer here, so both may be undefined. */
function sameSignal(a?: UnwatchedParks, b?: UnwatchedParks): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.parkedCount === b.parkedCount &&
    a.oldestAgeMs === b.oldestAgeMs &&
    a.disarmed.length === b.disarmed.length &&
    a.disarmed.every((type, i) => type === b.disarmed[i])
  );
}
