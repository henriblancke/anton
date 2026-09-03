"use client";

import { useCallback, useState } from "react";

import type { AutopilotBreaker } from "@/lib/autopilot-breaker";
import { useVisiblePoll } from "@/components/board/use-visible-poll";

/**
 * Breaker freshness cadence (anton-5c8h). Slower than the cards on purpose: the read behind the band
 * costs a board read plus a `gh pr view` per PR waiting in review, and it only ever changes when a
 * PR merges or closes — an event no keystroke on this board produces. Half the card cadence keeps a
 * released hold on screen for at most a minute while leaving the common case (nothing held, no PR
 * reads at all) cheap.
 */
export const BREAKER_POLL_MS = 60_000;

/**
 * The polled breaker, once one has landed — `null` until then, so the server's streamed read is what
 * the first paint uses. Wrapped rather than stored bare because `undefined` is a real answer ("the
 * autopilot is running, show no band") and must not read as "not polled yet".
 */
export type PolledBreaker = { value?: AutopilotBreaker } | null;

/**
 * Keep the breaker honest while the board stays open (anton-5c8h). A hold promises it releases
 * itself when a PR merges or closes — a thing that happens on GitHub, with nothing on this board to
 * notice it — so the band it draws would otherwise outlive its own release until a reload.
 *
 * `streamed` is the page's server read. A re-arm ends in `router.refresh()`, which hands down a
 * fresh one; the polled answer is dropped whenever that happens, so the band clears on the click
 * that cleared the latch rather than a poll later.
 */
export function useBoardBreaker(
  slug: string,
  streamed?: Promise<AutopilotBreaker | undefined>,
): PolledBreaker {
  const [polled, setPolled] = useState<PolledBreaker>(null);
  // Adjusted during render rather than in an effect: a re-armed board must never paint the retired
  // band once before dropping it.
  const [lastStreamed, setLastStreamed] = useState(streamed);
  if (streamed !== lastStreamed) {
    setLastStreamed(streamed);
    setPolled(null);
  }

  const read = useCallback(
    async (signal: AbortSignal) => {
      try {
        const res = await fetch(`/api/projects/${slug}/autopilot/breaker`);
        if (!res.ok) return;
        const data = (await res.json()) as { breaker: AutopilotBreaker | null };
        if (!signal.aborted) setPolled({ value: data.breaker ?? undefined });
      } catch {
        // A failed read keeps the band that is up. Clearing it on a network blip would tell the
        // operator anton is running when it is frozen — the one error this band must not make.
      }
    },
    [slug],
  );

  useVisiblePoll(read, BREAKER_POLL_MS);

  return polled;
}
