"use client";

import { RadarIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";

import { MetaChip, RelativeTime } from "@/components/atoms";
import { cn } from "@/lib/utils";
// Type-only for the health shapes (a value import of lib/scan-health would pull drizzle and
// better-sqlite3 into this client bundle); the severity vocabulary itself is a pure module.
import { SCAN_SEVERITIES, type ScanSeverity } from "@/lib/scan-severity";
import type { ClassCounts, ScanHealth, ScanHealthPoint, SignalClass } from "@/lib/types";

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

const SEVERITY_TONE: Partial<Record<ScanSeverity, "risk-high" | "risk-med">> = {
  critical: "risk-high",
  high: "risk-high",
  medium: "risk-med",
};

/** What each class of signal is, said the way a founder would say it. */
const CLASS_LABELS: Record<SignalClass, string> = {
  security: "security",
  dependencies: "deps",
  debt: "debt",
  risk: "risk",
  docs: "docs",
  other: "other",
};

function classSplit(byClass: ClassCounts): string {
  const parts = (Object.keys(CLASS_LABELS) as SignalClass[])
    .filter((c) => byClass[c] > 0)
    .map((c) => `${byClass[c]} ${CLASS_LABELS[c]}`);
  return parts.length > 0 ? parts.join(", ") : "nothing new";
}

function severitySplit(point: ScanHealthPoint): string {
  const parts = SCAN_SEVERITIES.filter((s) => point.bySeverity[s] > 0).map(
    (s) => `${point.bySeverity[s]} ${s}`,
  );
  return parts.length > 0 ? parts.join(", ") : "no new signals";
}

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

function shortDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * One column per scan, oldest → newest, stacked by severity and scaled to the noisiest scan in the
 * window. Bars rather than a line: each column is one nightly pass — a discrete event with an
 * internal split — not a sample of a continuous signal.
 *
 * A scan that found nothing draws a baseline tick, never an empty slot: "we scanned and it was
 * clean" is the best point on this chart and has to be visible as a point at all.
 */
function ScanTrend({ points, className }: { points: ScanHealthPoint[]; className?: string }) {
  if (points.length === 0) return null;
  const peak = Math.max(...points.map((p) => p.total), 1);

  return (
    <div
      className={cn("flex h-9 items-end gap-1", className)}
      role="img"
      aria-label={`New signals per scan, oldest to newest: ${points
        .map((p) => `${shortDate(p.at)}, ${p.total} (${severitySplit(p)})`)
        .join("; ")}`}
    >
      {points.map((point) => (
        <span
          key={point.id}
          title={`${shortDate(point.at)} — ${point.total} new signal${point.total === 1 ? "" : "s"} (${severitySplit(point)})`}
          className="flex h-full min-w-1.5 flex-1 flex-col justify-end"
        >
          {point.total === 0 ? (
            <span className="h-0.5 w-full rounded-[1px] bg-stage-done/60" />
          ) : (
            // Worst first, so a column reads top-down the way the legend does.
            SCAN_SEVERITIES.filter((s) => point.bySeverity[s] > 0).map((severity) => (
              <span
                key={severity}
                className={cn("w-full rounded-[1px]", SEVERITY_BAR[severity])}
                // Floored so a single signal still draws — an invisible segment reads as absent,
                // which is the one thing it is not.
                style={{
                  height: `${Math.max(6, (point.bySeverity[severity] / peak) * 100)}%`,
                }}
              />
            ))
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * Is the codebase getting healthier? (anton-bz1w) — the stringer trend, on the board where work is
 * approved, beside the hygiene report so supervision reads in one place.
 *
 * Every column is one nightly pass and every scan runs `--delta`, so the numbers are NEW problems
 * arriving, not the backlog outstanding: falling is healthy, and a scan finding nothing is a good
 * data point rather than a missing one. The panel says that out loud — read as a backlog, "6" would
 * look like a clean repo when it is in fact six new problems since yesterday.
 *
 * Renders nothing for a project that has never been scanned: the nightly-stringer schedule is
 * opt-in, so an un-scanned project would otherwise carry a permanent empty panel it can do nothing
 * about — and "never scanned" must never be drawn as "nothing found".
 */
export function ScanHealthPanel({ health }: { health: ScanHealth | undefined }) {
  if (!health) return null;
  const { points, latest, delta, byClass, collectorFailures } = health;
  const severities = SCAN_SEVERITIES.filter((s) => latest.bySeverity[s] > 0);

  return (
    <section
      aria-labelledby="scan-health-heading"
      className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-card/60 px-3 py-2"
    >
      <RadarIcon className="size-3.5 text-subtle" aria-hidden="true" />
      <h2 id="scan-health-heading" className="text-xs font-medium text-foreground">
        Codebase health
      </h2>
      <span className="text-xs text-subtle">
        scanned <RelativeTime iso={iso(latest.at)} />
      </span>

      {/* The headline number, with what it is made of one hover away. "new … since the previous scan"
          is a claim only a scan that HAD a previous one can make: on a first pass `--delta` has no
          baseline, so stringer emits everything it finds and the count is a standing total, not an
          arrival rate. Saying "new since the previous scan" there names a comparison never made. */}
      <span className="text-xs text-muted-foreground" title={classSplit(byClass)}>
        <span className="font-mono text-foreground">{latest.total}</span>{" "}
        {delta === undefined ? (
          <>{latest.total === 1 ? "signal" : "signals"} found</>
        ) : (
          <>
            new {latest.total === 1 ? "signal" : "signals"}{" "}
            <span className="text-subtle">since the previous scan</span>
          </>
        )}
      </span>

      <DeltaChip delta={delta?.total} />
      <ScanTrend points={points} className="w-28 shrink-0" />

      {severities.length > 0 ? (
        severities.map((severity) => (
          <MetaChip key={severity} tone={SEVERITY_TONE[severity]}>
            {latest.bySeverity[severity]} {severity}
          </MetaChip>
        ))
      ) : (
        // The honest zero-state: a scan that found nothing still says so. "clean" and "never
        // scanned" are different claims, and only one of them is good news.
        <span className="text-xs text-subtle">clean scan — nothing new to triage</span>
      )}

      <span className="flex-1" />

      {latest.triage ? (
        <span className="text-xs text-subtle">
          triaged into {latest.triage.created} {latest.triage.created === 1 ? "bead" : "beads"} ·{" "}
          {latest.triage.deduped} deduped
        </span>
      ) : null}
      {collectorFailures > 0 ? (
        <MetaChip tone="risk-med">
          <span
            title={`${collectorFailures} collector(s) failed during this scan — its counts are an undercount. See the scan session log.`}
          >
            {collectorFailures} collector {collectorFailures === 1 ? "failed" : "failures"}
          </span>
        </MetaChip>
      ) : null}
    </section>
  );
}

/**
 * The move since the last scan. FEWER new signals is the good direction, so the tint follows health
 * rather than the sign of the number — and a first scan says so instead of showing a zero it hasn't
 * earned.
 */
function DeltaChip({ delta }: { delta: number | undefined }) {
  if (delta === undefined) {
    return <span className="text-xs text-subtle">first scan — no trend yet</span>;
  }
  if (delta === 0) return <MetaChip>no change</MetaChip>;
  const better = delta < 0;
  const Icon = better ? TrendingDownIcon : TrendingUpIcon;
  return (
    <MetaChip tone={better ? "done" : "risk-med"}>
      <Icon className="size-2.5" aria-hidden="true" />
      <span
        title={
          better
            ? "Fewer new signals than the previous scan — new problems are arriving more slowly."
            : "More new signals than the previous scan — new problems are arriving faster."
        }
      >
        {delta > 0 ? "+" : "−"}
        {Math.abs(delta)} vs previous scan
      </span>
    </MetaChip>
  );
}
