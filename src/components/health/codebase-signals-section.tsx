import { RadarIcon } from "lucide-react";

import { MetaChip, RelativeTime } from "@/components/atoms";
import { SCAN_SEVERITIES, type ScanSeverity } from "@/lib/scan-severity";
import type { ScanHealth } from "@/lib/types";
import { baselineNote, classSplit } from "./scan-copy";

const SEVERITY_TONE: Partial<Record<ScanSeverity, "risk-high" | "risk-med">> = {
  critical: "risk-high",
  high: "risk-high",
  medium: "risk-med",
};

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * What the latest nightly-stringer pass found (anton-bz1w), moved off the board and onto this page
 * (anton-ue90.1 split): only the per-scan SUMMARY is persisted (`ScanHealth`/`ScanHealthPoint` in
 * lib/scan-health.ts) — the individual signals a scan found live in the scan file on disk, not in
 * anton.db, so this section can render the summary faithfully and nothing more granular than that.
 *
 * The trend chart itself lives in the right rail ({@link HealthRail}); this section is the latest
 * scan's own headline — the same three-way honesty the old board panel used (a delta since the last
 * scan, a baseline's whole-repo total, or a plain "found" when neither claim is earned) — plus the
 * severity/class split, what triage did with it, and the collector-failure caveat. Renders nothing
 * for a project that has never been scanned: the nightly-stringer schedule is opt-in, and "never
 * scanned" must never be drawn as "nothing found".
 */
export function CodebaseSignalsSection({ scanHealth }: { scanHealth: ScanHealth | undefined }) {
  if (!scanHealth) return null;
  const { latest, delta, byClass, collectorFailures } = scanHealth;
  const severities = SCAN_SEVERITIES.filter((s) => latest.bySeverity[s] > 0);

  return (
    <section
      aria-labelledby="codebase-signals-heading"
      className="rounded-xl border border-border bg-card/60 text-xs"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border/60 px-3 py-2">
        <RadarIcon className="size-3.5 text-subtle" aria-hidden="true" />
        <h2 id="codebase-signals-heading" className="text-xs font-medium text-foreground">
          Codebase signals
        </h2>
        <span className="text-xs text-subtle">
          scanned <RelativeTime iso={iso(latest.at)} />
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
        <span className="text-xs text-muted-foreground" title={classSplit(byClass)}>
          <span className="font-mono text-foreground">{latest.total}</span>{" "}
          {delta !== undefined ? (
            <>
              new {latest.total === 1 ? "signal" : "signals"}{" "}
              <span className="text-subtle">since the previous scan</span>
            </>
          ) : latest.baseline ? (
            <>
              {latest.total === 1 ? "signal" : "signals"}{" "}
              <span className="text-subtle" title={baselineNote(latest)}>
                in the repo — baseline scan
              </span>
            </>
          ) : (
            <>{latest.total === 1 ? "signal" : "signals"} found</>
          )}
        </span>

        {severities.length > 0 ? (
          severities.map((severity) => (
            <MetaChip key={severity} tone={SEVERITY_TONE[severity]}>
              {latest.bySeverity[severity]} {severity}
            </MetaChip>
          ))
        ) : collectorFailures > 0 ? (
          // Zero from a scan that lost a collector is not a clean bill of health — nothing was
          // found by the collectors that RAN, and whatever the dead ones would have found is
          // simply unmeasured. Calling that "clean" makes a claim the scan never earned.
          <span
            className="text-xs text-subtle"
            title="Every collector that ran found nothing, but at least one failed — this scan cannot say the repo is clean."
          >
            nothing found — incomplete scan
          </span>
        ) : (
          <span className="text-xs text-subtle">clean scan — nothing new to triage</span>
        )}
      </div>

      {latest.triage || collectorFailures > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/60 px-3 py-2 text-xs">
          {latest.triage ? (
            <span className="text-subtle">
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
        </div>
      ) : null}
    </section>
  );
}
