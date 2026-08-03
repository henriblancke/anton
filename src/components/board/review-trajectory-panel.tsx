"use client";

import Link from "next/link";
import { ActivityIcon } from "lucide-react";

import type { ReviewTrajectory } from "@/lib/types";
import { ReviewScoreChip, ScoreSparkline } from "@/components/review-score";

/**
 * Where this project's runs are TRENDING (anton-tprv) — the question a per-card score can't answer.
 *
 * Two numbers, because they fail differently: an average that holds while one target sits at 3/10
 * hides the thing worth opening, and a single bad run drags an average that is otherwise fine. So
 * the panel names both, and links the worst one straight to its page.
 *
 * Renders nothing for a project nothing has scored yet. An un-reviewed board is not a board
 * averaging zero, and a permanent empty trend panel would say exactly that.
 */
export function ReviewTrajectoryPanel({
  slug,
  trajectory,
}: {
  slug: string;
  trajectory: ReviewTrajectory | undefined;
}) {
  if (!trajectory) return null;
  const { recent, average, worst, scored } = trajectory;
  // Oldest → newest: the sample arrives newest-first (it is a "most recent N" window), but a trend
  // is read left to right.
  const points = [...recent]
    .reverse()
    .map((t) => ({ key: t.id, score: t.score, label: `${t.id} (${t.title})` }));

  return (
    <section
      aria-labelledby="review-trajectory-heading"
      className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-card/60 px-3 py-2"
    >
      <ActivityIcon className="size-3.5 text-subtle" aria-hidden="true" />
      <h2 id="review-trajectory-heading" className="text-xs font-medium text-foreground">
        Review scores
      </h2>
      <span className="text-xs text-muted-foreground">
        avg <span className="font-mono text-foreground">{average.toFixed(1)}</span> over the last{" "}
        {recent.length} scored {recent.length === 1 ? "run" : "runs"}
      </span>
      <ScoreSparkline points={points} className="h-5 w-24 shrink-0" />
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        worst
        <Link
          href={`/projects/${slug}/epics/${worst.id}`}
          className="rounded-sm font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          title={worst.title}
        >
          {worst.id}
        </Link>
        <ReviewScoreChip score={worst.score} />
      </span>
      <span className="flex-1" />
      {/* The window is a sample, so say what it was drawn from rather than let "last N" read as all. */}
      {scored > recent.length && (
        <span className="text-xs text-subtle">{scored} targets scored in all</span>
      )}
    </section>
  );
}
