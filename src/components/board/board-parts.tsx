"use client";

import { Suspense, use } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { DragOverlay } from "@dnd-kit/core";

import type { AutopilotBreaker } from "@/lib/autopilot-breaker";
import type { Epic, EscalationView, UnwatchedParks } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { EpicCard } from "@/components/board/epic-card";
import { AttentionStrip } from "@/components/board/attention-strip";
import type { PolledBreaker } from "@/components/board/use-board-breaker";

/**
 * The board with nothing to show and a reason why. Only a load that left no board at all lands here
 * — a failed poll keeps the last good cards — so it fills the view and offers the retry.
 */
export function BoardLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-destructive/30 p-8 text-center">
      <TriangleAlertIcon className="size-6 text-destructive" aria-hidden="true" />
      <p className="text-sm text-destructive">{message}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/**
 * The board's one alert line, drawn from whichever breaker read is freshest: the board's own poll
 * once one has landed, otherwise the page's streamed server read.
 *
 * Its own Suspense boundary, because deciding the WIP hold reads GitHub: the strip is late context,
 * not a placeholder the operator should watch a skeleton for, and the cards below have already
 * painted by the time it suspends.
 *
 * The fallback is the SAME strip minus the breaker, not `null` (PR #261 review). The escalation and
 * park counts are already resolved values, and blanking them while an unrelated GitHub read is
 * outstanding hid "8 stopped" behind a `gh pr view` that can take minutes — a regression against the
 * three bands this strip replaced, which each rendered outside the breaker's boundary. So only the
 * breaker's own chips arrive late; everything already known is on screen from the first paint.
 */
export function BoardAttentionSlot({
  slug,
  escalations,
  parks,
  onArmed,
  polled,
  streamed,
}: {
  slug: string;
  escalations: EscalationView[];
  parks?: UnwatchedParks;
  onArmed: () => void;
  polled: PolledBreaker;
  /** The page's server-rendered read — a promise, because deciding the hold reads GitHub. */
  streamed?: Promise<AutopilotBreaker | undefined>;
}) {
  const strip = (breaker?: AutopilotBreaker) => (
    <AttentionStrip
      slug={slug}
      escalations={escalations}
      breaker={breaker}
      parks={parks}
      onArmed={onArmed}
    />
  );
  return (
    <Suspense fallback={strip(undefined)}>
      {polled ? strip(polled.value) : <StreamedAttentionStrip streamed={streamed} render={strip} />}
    </Suspense>
  );
}

/**
 * The strip on its first paint, unwrapping the page's breaker promise inside the boundary above.
 *
 * A component rather than an inline `use()`: hooks cannot be called from the render callback of a
 * sibling, and the whole point of the boundary is that only this unwrap suspends.
 */
function StreamedAttentionStrip({
  streamed,
  render,
}: {
  streamed?: Promise<AutopilotBreaker | undefined>;
  render: (breaker?: AutopilotBreaker) => React.ReactNode;
}) {
  return <>{render(streamed ? use(streamed) : undefined)}</>;
}

/** The card that follows the cursor mid-drag. */
export function BoardDragOverlay({ slug, epic }: { slug: string; epic: Epic | null }) {
  return <DragOverlay>{epic ? <EpicCard slug={slug} epic={epic} overlay /> : null}</DragOverlay>;
}
