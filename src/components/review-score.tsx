import { cn } from "@/lib/utils";
import { MetaChip } from "@/components/atoms";

/**
 * The shared vocabulary for anton's self-review scores (anton-tprv) — one chip and one trend visual,
 * so a score reads the same on a board card, in the project trend and on a run target's detail page.
 *
 * The bands come from the review contract's own anchored scale (skills/review/SKILL.md §5), not from
 * an even split of 0–10: 8+ ships as-is, 5–7 is acceptable work a reviewer would still push back on,
 * and below 5 is the substantial-rework end that the score-regression alarm counts (anton-i98r).
 */
export type ScoreBand = "ships" | "gaps" | "rework";

export function scoreBand(score: number): ScoreBand {
  if (score >= 8) return "ships";
  return score >= 5 ? "gaps" : "rework";
}

const BAND_TONE = {
  ships: "done",
  gaps: "risk-med",
  rework: "risk-high",
} as const;

const BAND_BAR: Record<ScoreBand, string> = {
  ships: "bg-stage-done",
  gaps: "bg-risk-med",
  rework: "bg-risk-high",
};

/** What the band means, in the words the reviewer scored by — the chip's hover explanation. */
const BAND_MEANING: Record<ScoreBand, string> = {
  ships: "ships as-is — only advisory findings remained",
  gaps: "acceptable, with real gaps a reviewer would still ask to close",
  rework: "substantial rework — the work did not satisfy its contract",
};

/**
 * A run target's latest self-review score. Renders NOTHING when the target was never reviewed:
 * "not scored" is not a zero, and a card that showed one would accuse anton of judging work it
 * never looked at.
 */
export function ReviewScoreChip({ score, className }: { score?: number; className?: string }) {
  if (score === undefined) return null;
  const band = scoreBand(score);
  return (
    <MetaChip tone={BAND_TONE[band]} className={className}>
      <span title={`Latest anton self-review: ${score}/10 — ${BAND_MEANING[band]}`}>
        review {score}/10
      </span>
    </MetaChip>
  );
}

/** One column of {@link ScoreSparkline} — a round, or a scored run target. */
export interface SparklinePoint {
  key: string;
  /** Absent when that round's reviewer never reported a usable score. */
  score?: number;
  /** How this column is announced to a screen reader, e.g. "round 2". */
  label: string;
}

/**
 * The score series as a shape: one bar per point, oldest → newest, height by score.
 *
 * Bars rather than a line because the series is short and discrete — four review rounds are four
 * judgements, not a continuous signal — and because a missing score has to be visible AS missing.
 * The whole series is announced as one image label, so a screen reader reads the trend in order
 * rather than hearing an unlabelled bar per column.
 */
export function ScoreSparkline({
  points,
  className,
}: {
  points: SparklinePoint[];
  className?: string;
}) {
  if (points.length === 0) return null;
  return (
    <div
      className={cn("flex h-9 items-end gap-1", className)}
      role="img"
      aria-label={points
        .map((p) => `${p.label}: ${p.score === undefined ? "no score" : `${p.score} out of 10`}`)
        .join(", ")}
    >
      {points.map((point) => (
        <span
          key={point.key}
          title={`${point.label} — ${point.score === undefined ? "no score reported" : `${point.score}/10`}`}
          className="flex h-full min-w-1.5 flex-1 items-end"
        >
          {point.score === undefined ? (
            // A round that broke the report protocol judged nothing. Drawn as an empty full-height
            // slot, so the gap in the series is as visible as a low score — and never mistaken for one.
            <span className="h-full w-full rounded-[2px] border border-dashed border-border" />
          ) : (
            <span
              className={cn("w-full rounded-[2px]", BAND_BAR[scoreBand(point.score)])}
              // Floored so a 0 still draws — an invisible bar reads as "no round", which is the one
              // thing a 0 is not.
              style={{ height: `${Math.max(8, point.score * 10)}%` }}
            />
          )}
        </span>
      ))}
    </div>
  );
}
