"use client";

import { cn } from "@/lib/utils";
import { SCAN_SEVERITIES, type ScanSeverity } from "@/lib/scan-severity";
import type { ScanHealthPoint } from "@/lib/types";
import { baselineNote, pointLabel, pointNote, shortDate } from "./scan-copy";

/**
 * The severity ramp, worst at the top of a column: red → amber → grey. `high` is the same red at
 * half weight rather than its own hue — the eye should read one axis (how bad), not four categories.
 */
const SEVERITY_BAR: Record<ScanSeverity, string> = {
  critical: "bg-risk-high",
  high: "bg-risk-high/55",
  medium: "bg-risk-med",
  low: "bg-stage-backlog/70",
};

/** A segment's minimum share of the container height — floored so a single signal still draws. */
const FLOOR_PCT = 6;

/**
 * A column's segment heights, as a percent of the shared container height (`peak` sets the scale
 * for every column, so the tallest column's segments sum to exactly 100%). Flooring each segment
 * independently against a full 100% track — an earlier approach — asks a column with more than
 * one severity for over 100% of its own track, and flexbox silently shrinks every segment to fit,
 * distorting the very ratios the chart exists to show (anton-knyp).
 *
 * So each severity is floored against `FLOOR_PCT` directly: it draws at its natural proportional
 * share of the track, or `FLOOR_PCT`, whichever is bigger. That lets a short column's segments grow
 * past what its own track would proportionally allow — the container's shared 100% budget is the
 * only ceiling, not the column's own (often tiny) track, since funding the raise out of the track
 * itself starves a quiet column next to a tall peak the same way flooring against a full 100% track
 * once did (anton-knyp): at most 4 severities and a 6% floor cost at most 24% of the container, so a
 * column has to already be within ~76% of the peak's track before flooring can threaten to overflow
 * it at all.
 *
 * Only when that raise pushes the column's own total past the shared 100% ceiling — which can only
 * happen on a column whose track was already close to it — do the above-floor segments give back
 * the difference, in proportion to how far each cleared the floor, the same way flex-shrink would.
 */
function severityHeights(bySeverity: Record<ScanSeverity, number>, total: number, peak: number) {
  const track = (total / peak) * 100;
  const present = SCAN_SEVERITIES.filter((s) => bySeverity[s] > 0);

  const heights = new Map<ScanSeverity, number>(
    present.map((s) => [s, Math.max((bySeverity[s] / total) * track, FLOOR_PCT)]),
  );

  const overflow = [...heights.values()].reduce((sum, h) => sum + h, 0) - 100;
  if (overflow <= 0) return heights;

  const surplus = present.reduce((sum, s) => sum + Math.max(0, (heights.get(s) ?? 0) - FLOOR_PCT), 0);
  for (const s of present) {
    const h = heights.get(s) ?? 0;
    if (h > FLOOR_PCT) heights.set(s, h - ((h - FLOOR_PCT) / surplus) * overflow);
  }

  return heights;
}

/**
 * One column per scan, oldest → newest, stacked by severity (anton-bz1w). Bars rather than a line:
 * each column is one nightly pass — a discrete event with an internal split — not a sample of a
 * continuous signal. Shared between the board toolbar's mini pill and the Health page's fuller
 * charts (anton-tier-invariants), so both read the same series the same way.
 *
 * A scan that found nothing draws a floor tick, never an empty slot: "we scanned and it was clean"
 * is the best point on this chart and has to be visible as a point at all.
 *
 * A BASELINE scan is drawn as an outline, not a bar, and is left out of the scale (anton-3flx). Its
 * count is every signal already in the repo rather than what arrived, so plotting it as a column
 * would both make the incremental scans after it look like a collapse and squash them to nothing
 * against a total they were never measured against. Kept in place rather than dropped — the gap
 * would read as a night nobody scanned.
 *
 * An INCOMPLETE scan — one that lost a collector — is dimmed and struck with an amber rule at its
 * base (anton-3flx). Its column is a floor, not a measurement, and the zero-result case is the one
 * that misleads hardest: drawn as the green clean-pass tick, an outage would read as the best night
 * the repo ever had, and the honest scan after it as the regression from it.
 *
 * Height comes from `className`, not a value this component fixes: the board toolbar renders it at
 * `h-4 w-8`, the Health page's fuller panel wants room for the split to read — one chart, two sizes.
 */
export function ScanTrend({ points, className }: { points: ScanHealthPoint[]; className?: string }) {
  if (points.length === 0) return null;
  const peak = Math.max(...points.filter((p) => !p.baseline).map((p) => p.total), 1);

  return (
    <div
      className={cn("flex items-end gap-1", className)}
      role="img"
      // Not "new signals per scan": a baseline column is a whole-repo standing total, so a label
      // claiming new-arrivals contradicts every baseline point. `pointLabel` says which each is.
      aria-label={`scan history, oldest to newest: ${points.map(pointLabel).join("; ")}`}
    >
      {points.map((point) =>
        point.baseline ? (
          <span
            key={point.id}
            title={`${shortDate(point.at)} — ${baselineNote(point)}`}
            className="flex h-full min-w-1.5 flex-1 flex-col justify-end"
          >
            <span
              className={cn(
                "w-full flex-1 rounded-[1px] border border-dashed border-subtle/60",
                point.incomplete && "opacity-40",
              )}
            />
            {/* A baseline that lost a collector carries BOTH marks: the outline says the total isn't
                comparable, the amber rule says it is short whatever the dead collector would have
                found. Drawing only the outline would let `baseline` mask the failure. */}
            {point.incomplete ? (
              <span className="mt-px h-0.5 w-full rounded-[1px] bg-risk-med/70" />
            ) : null}
          </span>
        ) : (
          <span
            key={point.id}
            title={`${shortDate(point.at)} — ${pointNote(point)}`}
            className="flex h-full min-w-1.5 flex-1 flex-col justify-end"
          >
            {point.total > 0 ? (
              // A flex-1 wrapper, not the column itself, hosts the percent-sized segments: the
              // amber marker below is a flex sibling with its own fixed size, so wrapping the
              // segments lets flex subtract the marker's height first — the segments' 100% then
              // means 100% of what's left, not 100% of the column, so a floored segment can no
              // longer be shrunk back below its floor by the marker's own footprint (anton-knyp).
              <span className="flex w-full flex-1 flex-col justify-end">
                {/* Worst first, so a column reads top-down the way the legend does. */}
                {Array.from(severityHeights(point.bySeverity, point.total, peak)).map(
                  ([severity, height]) => (
                    <span
                      key={severity}
                      className={cn(
                        "w-full rounded-[1px]",
                        SEVERITY_BAR[severity],
                        point.incomplete && "opacity-40",
                      )}
                      style={{ height: `${height}%` }}
                    />
                  ),
                )}
              </span>
            ) : point.incomplete ? null : (
              <span className="h-0.5 w-full rounded-[1px] bg-stage-done/60" />
            )}
            {point.incomplete ? (
              // The amber base rule IS the zero-result incomplete column: nothing was measured, so
              // there is no clean-pass tick to draw — only the mark saying the scan couldn't tell.
              <span className="mt-px h-0.5 w-full rounded-[1px] bg-risk-med/70" />
            ) : null}
          </span>
        ),
      )}
    </div>
  );
}
