"use client";

import Link from "next/link";

import { ScanTrend } from "@/components/health/scan-trend";
import { rankAttention } from "@/lib/attention";
import { formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { AttentionSummary } from "@/lib/attention";
import type { HygieneReport, ReviewTrajectory, ScanHealth } from "@/lib/types";

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * How many of the scan series' most recent columns the toolbar sparkline draws. The board carries
 * the whole `SCAN_HEALTH_WINDOW` (14) and the Health page's rail draws all of it; only this pill caps.
 *
 * A cap, not a style choice: `ScanTrend` floors every column at `min-w-1.5` so a single signal is
 * still visible, which means the chart has a hard minimum width of `n*6px + (n-1)*4px` that `flex-1`
 * cannot shrink past. Handed the full 14-point window, that is 136px of columns painting straight
 * out through this pill's right border. Fourteen discrete nightly columns are not legible at toolbar
 * size anyway, so the honest fix is to show the last week and let the click reach the rest.
 */
const TREND_POINTS = 6;

/**
 * Sized to fit {@link TREND_POINTS} columns exactly at that floor: 6*6px + 5*4px of gap. Derived
 * from the cap rather than picked — a width narrower than the columns' own minimum is precisely the
 * overflow this replaces, so the two numbers have to move together. `shrink-0` because a toolbar
 * that squeezes this box does not squeeze the columns inside it: they would overflow again.
 */
const TREND_BOX = "h-4 w-14 shrink-0";

/** "3 worth a look · 12 housekeeping · 6 new signals · patrolled 6h ago" — named in the order the
 * Health page itself is organized, and only when the underlying data actually exists: a claim this
 * pill can't back up with a real number does not get a clause. */
function buildTitle({
  counts,
  hygiene,
  scanHealth,
}: {
  counts: AttentionSummary["counts"];
  hygiene: HygieneReport | undefined;
  scanHealth: ScanHealth | undefined;
}): string | undefined {
  const parts: string[] = [];
  if (counts.attention > 0) {
    parts.push(`${counts.attention} worth a look`);
  }
  if (counts.housekeeping > 0) {
    parts.push(`${counts.housekeeping} housekeeping`);
  }
  // Only "new" when there is a comparable predecessor scan behind it — same rule ScanHealthPanel
  // applies to its own headline: a first/baseline scan's total is a standing count, not an arrival.
  if (scanHealth?.delta !== undefined) {
    const n = scanHealth.latest.total;
    parts.push(`${n} new ${n === 1 ? "signal" : "signals"}`);
  }
  if (hygiene) {
    const ago = formatRelativeTime(iso(hygiene.generatedAt));
    if (ago) parts.push(`patrolled ${ago}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * The toolbar's link to everything that moved off the board (anton-ue90.3 / the health-page split):
 * hygiene findings, the worst review score, housekeeping, the patrol's own applied actions, and the
 * scan trend. It replaces `ReviewTrendPill` and `ScanHealthPanel` on this row rather than sitting
 * beside them — a design with three separate "how's the codebase" affordances is the same overload
 * the strip split fixed, just moved sideways instead of solved.
 *
 * A LINK, not a popover: everything it summarizes now has a real page to land on, so the toolbar's
 * job is to say how much is there and let the click do the rest, rather than reproduce a second
 * disclosure UI for data the Health page already owns.
 *
 * Honesty contract, same shape as the strip it replaces: renders NOTHING for a project that has
 * never been patrolled, never been scanned, and never been scored — `rankAttention`'s `reported`
 * flag is exactly "a patrol ran or a score exists", and this pill ORs it with "a scan ran" because
 * the pill (unlike the old strip) also carries the scan trend. A patrolled-and-clean project is a
 * different claim from a never-checked one and DOES render — a count of 0 backed by a real patrol is
 * exactly what "clean" means; a count of 0 with nothing behind it is not a claim this pill can make.
 */
export function HealthPill({
  slug,
  hygiene,
  trajectory,
  scanHealth,
}: {
  slug: string;
  hygiene: HygieneReport | undefined;
  trajectory: ReviewTrajectory | undefined;
  scanHealth: ScanHealth | undefined;
}) {
  // Escalations are the board's own — the Health page never lists them, so they play no part in
  // this pill's severity, count, or "has anything ever reported" test.
  const { counts, reported: patrolOrScoreReported } = rankAttention({ hygiene, trajectory });
  const reported = patrolOrScoreReported || scanHealth !== undefined;
  if (!reported) return null;

  const count = counts.attention + counts.housekeeping;
  const title = buildTitle({ counts, hygiene, scanHealth });

  return (
    <Link
      href={`/projects/${slug}/health`}
      title={title}
      className="inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          counts.attention > 0 ? "bg-risk-med" : "bg-subtle",
        )}
        aria-hidden="true"
      />
      <span>
        Health <span className="font-mono text-foreground">{count}</span>
      </span>
      {/* The tail, not the whole series — and so this chart's scale is the last week's peak, not the
          window's. Deliberate: at six columns the pill answers "is it getting worse lately", and the
          Health page's full-window rail is one click away for the longer arc. */}
      {scanHealth ? (
        <ScanTrend points={scanHealth.points.slice(-TREND_POINTS)} className={TREND_BOX} />
      ) : null}
    </Link>
  );
}
