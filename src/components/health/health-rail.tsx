import Link from "next/link";

import { RelativeTime } from "@/components/atoms";
import { ReviewScoreChip, ScoreSparkline } from "@/components/review-score";
import type { ProjectHealth } from "@/lib/health";
import { ScanTrend } from "./scan-trend";
import { baselineNote, noTrendNote, pausedBy } from "./scan-copy";

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

function RailBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5">
      <h3 className="text-[11px] font-medium text-subtle uppercase">{title}</h3>
      {children}
    </div>
  );
}

/** The move since the last scan, in the rail's own compact voice — the same claim the old board
 * toolbar's `DeltaChip` made, minus the icon: this is a report, not a live pill, and the rail
 * already sits beside the chart it describes. FEWER new signals is the good direction, so the tint
 * and the explanatory title follow health rather than the sign of the number. */
function DeltaNote({ scanHealth }: { scanHealth: NonNullable<ProjectHealth["scanHealth"]> }) {
  const { delta, latest } = scanHealth;
  if (latest.baseline) return null;
  if (delta === undefined) {
    return (
      <p className="text-subtle" title={noTrendNote(pausedBy(scanHealth))}>
        no trend yet
      </p>
    );
  }
  if (delta.total === 0) return <p className="text-muted-foreground">no change vs previous scan</p>;
  const better = delta.total < 0;
  return (
    <p
      className={better ? "text-stage-done" : "text-risk-med"}
      title={
        better
          ? "Fewer new signals than the previous scan — new problems are arriving more slowly."
          : "More new signals than the previous scan — new problems are arriving faster."
      }
    >
      {delta.total > 0 ? "+" : "−"}
      {Math.abs(delta.total)} vs previous scan
    </p>
  );
}

/**
 * The read-only report's vitals rail (layout "C" — anton-tier-invariants): everything the main
 * column's sections point at, condensed to what fits beside them at ~208px. Sticky on wide screens
 * so the trend and the "last checked" timestamps stay visible while the report scrolls.
 *
 * Every block says what it HAS, honestly, rather than going quiet where the main column would omit
 * a whole section: "never scanned"/"no runs scored yet" are claims worth making here even when
 * there's no chart to draw, because this is the one place on the page that always renders.
 *
 * It narrows and pins at exactly the width `HealthReport` turns two-column at (900px), NOT at
 * Tailwind's `md` (768px): a 208px rail inside a still-stacked column would render as a narrow stub
 * under full-width sections, and the loading skeleton — which already keys off 900 — would swap for
 * a differently-shaped page.
 */
export function HealthRail({ slug, health }: { slug: string; health: ProjectHealth }) {
  const { hygiene, scanHealth, trajectory, stoppedCount } = health;

  return (
    <aside className="flex w-full flex-col divide-y divide-border/50 rounded-xl border border-border bg-card/60 text-xs min-[900px]:sticky min-[900px]:top-[18px] min-[900px]:w-52 min-[900px]:shrink-0">
      <RailBlock title="Codebase trend">
        {scanHealth ? (
          <>
            <ScanTrend points={scanHealth.points} className="h-9 w-full" />
            <p className="text-muted-foreground">
              <span className="font-mono text-foreground">{scanHealth.latest.total}</span>{" "}
              {scanHealth.delta !== undefined ? (
                <>new {scanHealth.latest.total === 1 ? "signal" : "signals"}</>
              ) : scanHealth.latest.baseline ? (
                <span title={baselineNote(scanHealth.latest)}>signals — baseline</span>
              ) : (
                <>{scanHealth.latest.total === 1 ? "signal" : "signals"} found</>
              )}
            </p>
            <DeltaNote scanHealth={scanHealth} />
          </>
        ) : (
          <p className="text-subtle">never scanned</p>
        )}
      </RailBlock>

      <RailBlock title="Review average">
        {trajectory ? (
          <>
            <ScoreSparkline
              points={[...trajectory.recent]
                .reverse()
                .map((t) => ({ key: t.id, score: t.score, label: `${t.id} (${t.title})` }))}
              className="h-9"
            />
            <p className="text-muted-foreground">
              average <span className="font-mono text-foreground">{trajectory.average.toFixed(1)}</span>
            </p>
            <p className="text-subtle">
              last {trajectory.recent.length} scored{" "}
              {trajectory.recent.length === 1 ? "run" : "runs"}
              {trajectory.scored > trajectory.recent.length ? (
                <> · {trajectory.scored} scored in all</>
              ) : null}
            </p>
            <div className="flex items-center gap-1.5 border-t border-border pt-1.5">
              <span className="text-subtle">worst</span>
              <Link
                href={`/projects/${slug}/epics/${trajectory.worst.id}`}
                className="rounded-sm font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                title={trajectory.worst.title}
              >
                {trajectory.worst.id}
              </Link>
              <span className="ml-auto">
                <ReviewScoreChip score={trajectory.worst.score} />
              </span>
            </div>
          </>
        ) : (
          <p className="text-subtle">no runs scored yet</p>
        )}
      </RailBlock>

      <RailBlock title="Last checked">
        <p className="text-muted-foreground">
          patrol{" "}
          {hygiene ? (
            <RelativeTime iso={iso(hygiene.generatedAt)} />
          ) : (
            <span className="text-subtle">never patrolled</span>
          )}
        </p>
        <p className="text-muted-foreground">
          scan{" "}
          {scanHealth ? (
            <RelativeTime iso={iso(scanHealth.latest.at)} />
          ) : (
            <span className="text-subtle">never scanned</span>
          )}
        </p>
      </RailBlock>

      <RailBlock title="On the board">
        <p className="text-muted-foreground">
          {stoppedCount} stopped {stoppedCount === 1 ? "run" : "runs"} — answered on the board, not
          here.
        </p>
        <Link
          href={`/projects/${slug}`}
          className="text-subtle underline-offset-2 hover:text-foreground hover:underline"
        >
          Back to board
        </Link>
      </RailBlock>
    </aside>
  );
}
