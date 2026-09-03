"use client";

import { Suspense } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { DragOverlay } from "@dnd-kit/core";

import type { AutopilotBreaker } from "@/lib/autopilot-breaker";
import type { Epic } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { EpicCard } from "@/components/board/epic-card";
import {
  AutopilotBreakerBand,
  AutopilotBreakerHeader,
} from "@/components/board/autopilot-breaker-header";
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
 * The autopilot band, drawn from whichever read is freshest: the board's own poll once one has
 * landed, otherwise the page's streamed server read.
 *
 * Its own boundary, and a null fallback: the band is late context, not a placeholder the operator
 * should watch a skeleton for.
 */
export function BoardBreakerSlot({
  slug,
  polled,
  streamed,
}: {
  slug: string;
  polled: PolledBreaker;
  /** The page's server-rendered read — a promise, because deciding the hold reads GitHub. */
  streamed?: Promise<AutopilotBreaker | undefined>;
}) {
  return (
    <Suspense fallback={null}>
      {polled ? (
        <AutopilotBreakerHeader slug={slug} breaker={polled.value} />
      ) : (
        <AutopilotBreakerBand slug={slug} breaker={streamed} />
      )}
    </Suspense>
  );
}

/** The card that follows the cursor mid-drag. */
export function BoardDragOverlay({ slug, epic }: { slug: string; epic: Epic | null }) {
  return <DragOverlay>{epic ? <EpicCard slug={slug} epic={epic} overlay /> : null}</DragOverlay>;
}
