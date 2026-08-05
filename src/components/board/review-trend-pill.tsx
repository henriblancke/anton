"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";

import type { ReviewTrajectory } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ReviewScoreChip, ScoreSparkline } from "@/components/review-score";

/**
 * Where this project's runs are TRENDING (anton-ue90.2), as a toolbar pill rather than a band.
 *
 * A trend is not an alert. The average moves over weeks, so it does not earn a full-width heading
 * above the work — it earns a spot on the toolbar row that already exists, next to the sync badge,
 * with the shape of the series legible without opening anything. The numbers behind it (sample size,
 * total scored, which target is worst) open on click.
 *
 * A worst score in the rework band is a different claim, and it is NOT made here: the attention
 * strip promotes it to a row of its own (see lib/attention). This pill stays quiet by design.
 *
 * Renders nothing for a project nothing has scored yet. An un-reviewed board is not a board
 * averaging zero.
 */
export function ReviewTrendPill({
  slug,
  trajectory,
}: {
  slug: string;
  trajectory: ReviewTrajectory | undefined;
}) {
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const anchorRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside click and on Escape — the pill is a disclosure on a toolbar, so it must not
  // survive the operator moving on to the board behind it.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!trajectory) return null;
  const { recent, average, worst, scored } = trajectory;
  // Oldest → newest: the sample arrives newest-first (it is a "most recent N" window), but a trend
  // is read left to right.
  const points = [...recent]
    .reverse()
    .map((t) => ({ key: t.id, score: t.score, label: `${t.id} (${t.title})` }));

  return (
    <div ref={anchorRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((v) => !v)}
        title={`Self-review averaging ${average.toFixed(1)} over the last ${recent.length} scored ${
          recent.length === 1 ? "run" : "runs"
        }`}
        className={cn(
          "inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
          open && "text-foreground",
        )}
      >
        <span>
          review <span className="font-mono text-foreground">{average.toFixed(1)}</span>
        </span>
        {/* w-12 is the width a short series is STRETCHED to, so a two-run project still gets a
            readable pill — not a cap. A full window needs more than that, and takes it: the pill
            grows with the series rather than letting its bars run over the border. */}
        <ScoreSparkline points={points} className="h-3.5 w-12 shrink-0" />
      </button>

      {open ? (
        <div
          id={popoverId}
          className="absolute top-[calc(100%+6px)] right-0 z-30 flex w-80 flex-col gap-2.5 rounded-xl border border-border bg-popover p-3 shadow-lg"
        >
          <div className="flex items-baseline gap-2">
            <h3 className="text-xs font-medium text-foreground">Review scores</h3>
            <span className="text-[11px] text-subtle">
              last {recent.length} scored {recent.length === 1 ? "run" : "runs"}
            </span>
          </div>
          <ScoreSparkline points={points} className="h-12" />
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
            <span>
              average <span className="font-mono text-foreground">{average.toFixed(1)}</span>
            </span>
            {/* The window is a sample, so say what it was drawn from rather than let "last N" read
                as all. */}
            {scored > recent.length ? (
              <span>
                <span className="font-mono text-foreground">{scored}</span> targets scored in all
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5 border-t border-border pt-2 text-[11.5px] text-muted-foreground">
            worst
            <Link
              href={`/projects/${slug}/epics/${worst.id}`}
              onClick={() => setOpen(false)}
              className="rounded-sm font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              title={worst.title}
            >
              {worst.id}
            </Link>
            <span className="ml-auto">
              <ReviewScoreChip score={worst.score} />
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
