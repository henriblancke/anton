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
              // Worst first, so a column reads top-down the way the legend does.
              SCAN_SEVERITIES.filter((s) => point.bySeverity[s] > 0).map((severity) => (
                <span
                  key={severity}
                  className={cn(
                    "w-full rounded-[1px]",
                    SEVERITY_BAR[severity],
                    point.incomplete && "opacity-40",
                  )}
                  // Floored so a single signal still draws — an invisible segment reads as absent,
                  // which is the one thing it is not.
                  style={{
                    height: `${Math.max(6, (point.bySeverity[severity] / peak) * 100)}%`,
                  }}
                />
              ))
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
