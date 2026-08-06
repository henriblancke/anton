/**
 * The scan-health vocabulary (anton-bz1w), factored out of the old board panel so the Health page's
 * "Codebase signals" section, its right-rail trend, and {@link ScanTrend}'s own tooltips all say the
 * same thing about the same scan — a baseline total, an incomplete pass, or a trend that's paused,
 * rather than three surfaces free to drift apart on the wording that carries the honesty contract
 * (see lib/scan-health.ts's docblock).
 *
 * Pure and side-effect-free on purpose: every function here takes the shapes the UI already has in
 * hand and returns a string, so it can be shared between a "use client" chart and a Server Component
 * panel without either pulling the other's rendering concerns along with it.
 */
import { SCAN_SEVERITIES } from "@/lib/scan-severity";
import type { ClassCounts, ScanHealth, ScanHealthPoint, SignalClass } from "@/lib/types";

/** What each class of signal is, said the way a founder would say it. */
export const CLASS_LABELS: Record<SignalClass, string> = {
  security: "security",
  dependencies: "deps",
  debt: "debt",
  risk: "risk",
  docs: "docs",
  other: "other",
};

export function classSplit(byClass: ClassCounts): string {
  const parts = (Object.keys(CLASS_LABELS) as SignalClass[])
    .filter((c) => byClass[c] > 0)
    .map((c) => `${byClass[c]} ${CLASS_LABELS[c]}`);
  return parts.length > 0 ? parts.join(", ") : "nothing new";
}

export function severitySplit(point: ScanHealthPoint): string {
  const parts = SCAN_SEVERITIES.filter((s) => point.bySeverity[s] > 0).map(
    (s) => `${point.bySeverity[s]} ${s}`,
  );
  return parts.length > 0 ? parts.join(", ") : "no new signals";
}

export function shortDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * What a baseline column is, wherever it is announced. It counts everything already in the repo, so
 * it is a different quantity from every incremental column beside it — every surface says that
 * rather than letting the eye read a 100-signal baseline followed by 2 and 3 as debt collapsing.
 *
 * A baseline that ALSO lost a collector is both things at once, and being the baseline is the worse
 * place to hide an undercount: every later delta is measured against this total. Once the scan is no
 * longer latest its failure chip is gone, so the column is the only thing left that can say so.
 */
export function baselineNote(point: ScanHealthPoint): string {
  const note =
    `baseline scan: ${point.total} signal${point.total === 1 ? "" : "s"} already in the repo, ` +
    `not new arrivals — not comparable to the scans beside it`;
  return point.incomplete
    ? `${note}; at least one collector failed — this baseline is itself an undercount`
    : note;
}

/**
 * What an incomplete column is. A dead collector leaves a hole in the counts, and the hole outlives
 * the scan: the delta is suppressed on both sides, but the column stays on the chart, so it has to
 * carry its own caveat — otherwise a zero-result outage reads as the best night the repo ever had and
 * the next honest scan reads as the regression from it.
 */
export function incompleteNote(point: ScanHealthPoint): string {
  return point.total === 0
    ? "incomplete scan: every collector that ran found nothing, but at least one failed — not a clean pass"
    : `incomplete scan: ${point.total} (${severitySplit(point)}) from the collectors that ran, at least one failed — an undercount`;
}

export function pointNote(point: ScanHealthPoint): string {
  if (point.baseline) return baselineNote(point);
  if (point.incomplete) return incompleteNote(point);
  return `${point.total} new signal${point.total === 1 ? "" : "s"} (${severitySplit(point)})`;
}

export function pointLabel(point: ScanHealthPoint): string {
  return point.baseline || point.incomplete
    ? `${shortDate(point.at)}, ${pointNote(point)}`
    : `${shortDate(point.at)}, ${point.total} (${severitySplit(point)})`;
}

/**
 * Which scan paused the trend, when a collector outage is what suppressed the delta — the delta
 * needs BOTH adjacent scans whole, so the one before the latest can pause it just as well, and by
 * then its own failure chip is long gone. A baseline latest is never "paused": nothing may be
 * subtracted from a standing total, outage or not, so that case belongs to the missing-baseline copy.
 */
export function pausedBy(health: ScanHealth): "latest" | "previous" | undefined {
  const { points, latest, collectorFailures } = health;
  if (latest.baseline) return undefined;
  if (collectorFailures > 0) return "latest";
  return points.at(-2)?.incomplete ? "previous" : undefined;
}

/**
 * Why there is no trend. A delta goes missing for reasons that ask different things of the reader,
 * so callers name the one that applies rather than the most common one: an outage is a trend PAUSED,
 * and it resumes on its own — sending that reader after a missing baseline points them at a problem
 * they don't have.
 */
export function noTrendNote(paused: "latest" | "previous" | undefined): string {
  if (paused === "latest") {
    return "Trend paused — at least one collector failed on this scan, so its count is an undercount; differencing it would measure the outage rather than the repo. The trend resumes on the next complete scan.";
  }
  if (paused === "previous") {
    return "Trend paused — at least one collector failed on the previous scan, so there is no whole measurement behind this one to compare against. The trend resumes once two complete scans run back to back.";
  }
  return "A trend needs two scans measuring the same thing. A scan with no baseline behind it — a project's first, or the first after the scanner's baseline was reset — counts everything in the repo rather than what arrived since, so the comparison starts one scan later.";
}
