"use client";

import { useId, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";

import { MetaChip, RelativeTime } from "@/components/atoms";
import { EscalationActions } from "@/components/board/escalation-actions";
import { escalationAge } from "@/components/board/escalation-age";
import { ReviewScoreChip } from "@/components/review-score";
import { rankAttention, hasAppliedActions, type AttentionItem } from "@/lib/attention";
import { cn } from "@/lib/utils";
import type {
  EscalationView,
  HygieneFindingKind,
  HygieneReport,
  ReviewTrajectory,
  RunHealthFindingKind,
} from "@/lib/types";

/** What each stall class is, said the way a founder would say it. */
const ESCALATION_LABELS: Record<RunHealthFindingKind, string> = {
  "parked-run": "Parked run",
  "stale-pr": "Stale PR",
  "dead-lease": "Dead lease",
  "exhausted-job": "Retries spent",
};

/** What each class of board rot is, in the same voice. */
const HYGIENE_LABELS: Record<HygieneFindingKind, string> = {
  lint: "Contract gap",
  "stale-open": "Stale",
  "stale-in-progress": "Abandoned run",
  orphan: "Shipped, not closed",
  "dep-cycle": "Dependency cycle",
  duplicate: "Duplicate",
};

/** The noun each kind counts, for the folded housekeeping line: "3 contract gaps, 5 stale". */
const HYGIENE_NOUNS: Record<HygieneFindingKind, [singular: string, plural: string]> = {
  lint: ["contract gap", "contract gaps"],
  "stale-open": ["stale", "stale"],
  "stale-in-progress": ["abandoned run", "abandoned runs"],
  orphan: ["shipped, not closed", "shipped, not closed"],
  "dep-cycle": ["dependency cycle", "dependency cycles"],
  duplicate: ["duplicate", "duplicates"],
};

/** Summary order for the folded line — the order the kinds are declared above. */
const HYGIENE_KIND_ORDER = Object.keys(HYGIENE_LABELS) as HygieneFindingKind[];

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/** Every bead a finding concerns — one for a per-bead finding, the whole ring/group otherwise. */
function findingBeadIds(item: Extract<AttentionItem, { source: "hygiene" }>): string[] {
  const { finding } = item;
  if (finding.ids?.length) return finding.ids;
  return finding.beadId ? [finding.beadId] : [];
}

/** Opens the bead's detail dialog — the same one a standalone chip opens, so a row is one click
 * from the contract that has to change to settle it. */
function BeadLink({ id, onOpenBead }: { id: string; onOpenBead: (beadId: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpenBead(id)}
      className="rounded-sm font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      title={`Open ${id}`}
    >
      {id}
    </button>
  );
}

/**
 * What needs the operator, worst first (anton-ue90.1) — the one band above the board.
 *
 * It replaces two stacked panels (escalations, hygiene) because they were always one question asked
 * twice. The ranking is not this component's: {@link rankAttention} owns severity and order, so the
 * rule is unit-testable and every future signal gets a home by declaring its band rather than by
 * growing another panel. This file owns only the words.
 *
 * Three states, and the difference between the last two is the whole point:
 *   • something to answer  — rows, worst first, housekeeping folded behind a count
 *   • checked, nothing found — ONE line saying so
 *   • never checked        — nothing at all. A project with no patrol and no scores has not been
 *                            found clean, and a strip claiming otherwise would be lying.
 */
export function AttentionStrip({
  slug,
  escalations,
  hygiene,
  trajectory,
  onOpenBead,
}: {
  slug: string;
  escalations: EscalationView[];
  hygiene: HygieneReport | undefined;
  trajectory: ReviewTrajectory | undefined;
  onOpenBead: (beadId: string) => void;
}) {
  const [showHousekeeping, setShowHousekeeping] = useState(false);
  const bodyId = useId();

  const { items, housekeeping, counts, clean, reported } = rankAttention({
    escalations,
    hygiene,
    trajectory,
  });

  if (!reported) return null;

  const applied = hasAppliedActions(hygiene);
  const patrolled = hygiene ? <RelativeTime iso={iso(hygiene.generatedAt)} /> : null;

  // Nothing has stopped and nothing is untrustworthy: one line, whether the patrol found literally
  // nothing or only tidy-up. Housekeeping is real but it is not a reason to push the columns down,
  // so it reports as a summary with a disclosure rather than as rows. The line still says what was
  // CHECKED — "clean" is only meaningful next to the patrol that decided it.
  if (items.length === 0) {
    return (
      <section
        aria-labelledby={`${bodyId}-heading`}
        className="mb-3 rounded-xl border border-border bg-card/60"
      >
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3 py-1.5">
          <h2 id={`${bodyId}-heading`} className="sr-only">
            Board attention
          </h2>
          {clean && counts.housekeeping === 0 ? (
            <MetaChip tone="done">board clean</MetaChip>
          ) : (
            <span className="text-xs text-muted-foreground">
              {housekeepingSummary(housekeeping)}
            </span>
          )}
          {applied && hygiene ? (
            <span className="text-xs text-subtle">{appliedSummary(hygiene)}</span>
          ) : null}
          {patrolled ? <span className="text-xs text-subtle">patrolled {patrolled}</span> : null}
          {/* The trend belongs to the toolbar pill, and repeating it here is noise — EXCEPT when
              scores are the only check that has happened. Then it is the evidence behind the claim,
              and a bare "board clean" with nothing to attribute it to would be the empty state this
              strip exists to avoid. */}
          {trajectory && !hygiene ? (
            <span className="text-xs text-subtle">
              review averaging {trajectory.average.toFixed(1)} over the last{" "}
              {trajectory.recent.length} {trajectory.recent.length === 1 ? "run" : "runs"}
            </span>
          ) : null}
          <span className="flex-1" />
          {counts.housekeeping > 0 ? (
            <DisclosureButton
              open={showHousekeeping}
              controls={`${bodyId}-housekeeping`}
              onToggle={() => setShowHousekeeping((v) => !v)}
            />
          ) : null}
        </div>
        {showHousekeeping && counts.housekeeping > 0 ? (
          <ul
            id={`${bodyId}-housekeeping`}
            className="flex flex-col gap-1.5 border-t border-border/60 px-3 py-2"
          >
            {housekeeping.map((item) => (
              <li key={item.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <AttentionRow slug={slug} item={item} onOpenBead={onOpenBead} />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    );
  }

  return (
    <section
      aria-labelledby={`${bodyId}-heading`}
      className={cn(
        "mb-3 overflow-hidden rounded-xl border",
        counts.stopped > 0
          ? "border-destructive/25 bg-destructive/[0.04]"
          : "border-border bg-card/60",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border/60 px-3 py-2">
        {counts.stopped > 0 ? (
          <TriangleAlertIcon className="size-3.5 text-destructive" aria-hidden="true" />
        ) : null}
        {/* The heading is the strip's own claim about itself, so it tracks the worst row in it. A
            band of contract gaps is not "Needs you" — overclaiming here is exactly how an operator
            learns to stop reading the strip. */}
        <h2 id={`${bodyId}-heading`} className="text-xs font-medium text-foreground">
          {counts.stopped > 0
            ? "Needs you"
            : counts.attention > 0
              ? "Worth a look"
              : "Housekeeping"}
        </h2>
        {counts.stopped > 0 ? (
          <MetaChip tone="risk-high">
            {counts.stopped} stopped
          </MetaChip>
        ) : null}
        {counts.attention > 0 ? (
          <MetaChip tone="risk-med">{counts.attention} to look at</MetaChip>
        ) : null}
        {/* The patrol's own writes: what it CHANGED, as opposed to what it found and left alone. */}
        {applied && hygiene ? (
          <span className="text-xs text-subtle">{appliedSummary(hygiene)}</span>
        ) : null}
        <span className="flex-1" />
        {patrolled ? (
          <span className="text-xs text-subtle">patrolled {patrolled}</span>
        ) : null}
      </div>

      <ul className="divide-y divide-border/50">
        {items.map((item) => (
          <li key={item.key} className="flex flex-wrap items-start gap-x-2.5 gap-y-1.5 px-3 py-2">
            <span
              className={cn(
                "mt-0.5 w-0.5 shrink-0 self-stretch rounded-full",
                item.severity === "stopped" ? "bg-risk-high" : "bg-risk-med",
              )}
              aria-hidden="true"
            />
            <AttentionRow slug={slug} item={item} onOpenBead={onOpenBead} />
          </li>
        ))}

        {housekeeping.length > 0 ? (
          <li className="flex flex-col gap-1.5 px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-xs text-muted-foreground">
                {housekeepingSummary(housekeeping)}
              </span>
              <span className="flex-1" />
              <DisclosureButton
                open={showHousekeeping}
                controls={`${bodyId}-housekeeping`}
                onToggle={() => setShowHousekeeping((v) => !v)}
              />
            </div>
            {showHousekeeping ? (
              <ul id={`${bodyId}-housekeeping`} className="flex flex-col gap-1.5 pt-1">
                {housekeeping.map((item) => (
                  <li key={item.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <AttentionRow slug={slug} item={item} onOpenBead={onOpenBead} />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ) : null}
      </ul>
    </section>
  );
}

/** The disclosure for the folded housekeeping list — one control, two placements. */
function DisclosureButton({
  open,
  controls,
  onToggle,
}: {
  open: boolean;
  controls: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {open ? (
        <ChevronDownIcon className="size-3.5" aria-hidden="true" />
      ) : (
        <ChevronRightIcon className="size-3.5" aria-hidden="true" />
      )}
      {open ? "Hide" : "Show"}
    </button>
  );
}

/** What the patrol CHANGED this pass, as opposed to what it found and left for a human. */
function appliedSummary(hygiene: HygieneReport): React.ReactNode {
  const { closedEpics, rowsRecomputed } = hygiene.actions;
  return (
    <>
      {closedEpics.length > 0
        ? `patrol closed ${closedEpics.length} ${closedEpics.length === 1 ? "epic" : "epics"}`
        : "patrol"}
      {rowsRecomputed > 0 ? (
        <span
          title={`The patrol rebuilt ${rowsRecomputed} stale is_blocked row(s) from the dependency graph — bd ready trusts that flag.`}
        >
          {closedEpics.length > 0 ? " · " : " "}
          repaired {rowsRecomputed} blocked {rowsRecomputed === 1 ? "row" : "rows"}
        </span>
      ) : null}
    </>
  );
}

/** "3 contract gaps · 5 stale · 2 shipped-not-closed" — the folded line, in declaration order. */
function housekeepingSummary(items: AttentionItem[]): string {
  const counts = new Map<HygieneFindingKind, number>();
  for (const item of items) {
    if (item.source !== "hygiene") continue;
    counts.set(item.finding.kind, (counts.get(item.finding.kind) ?? 0) + 1);
  }
  const parts = HYGIENE_KIND_ORDER.filter((kind) => counts.has(kind)).map((kind) => {
    const n = counts.get(kind) ?? 0;
    const [singular, plural] = HYGIENE_NOUNS[kind];
    return `${n} ${n === 1 ? singular : plural}`;
  });
  return parts.join(" · ");
}

/**
 * One row's content, by source. Each keeps the affordance its old panel gave it: an escalation
 * still decides, a finding still links every bead it spans, a low score still opens its target.
 */
function AttentionRow({
  slug,
  item,
  onOpenBead,
}: {
  slug: string;
  item: AttentionItem;
  onOpenBead: (beadId: string) => void;
}) {
  if (item.source === "escalation") {
    const { escalation } = item;
    return (
      <>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <MetaChip tone="risk-high">
              {ESCALATION_LABELS[escalation.kind] ?? escalation.kind}
            </MetaChip>
            <MetaChip>stuck {escalationAge(escalation)}</MetaChip>
            {escalation.epicBeadId ? (
              <Link
                href={`/projects/${slug}/epics/${escalation.epicBeadId}`}
                className="font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {escalation.epicBeadId}
              </Link>
            ) : null}
            {escalation.prUrl && escalation.prNumber ? (
              <a
                href={escalation.prUrl}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                PR #{escalation.prNumber}
              </a>
            ) : null}
          </div>
          {/* The park reason is the whole point of the row — full text, never truncated: a founder
              deciding resume-vs-abandon is deciding on exactly this sentence. */}
          <p className="text-xs text-muted-foreground">{escalation.reason}</p>
          {!escalation.noted && escalation.beadId ? (
            <p className="text-[11px] text-subtle">
              The bd note for this escalation hasn&apos;t landed yet — anton retries it on the next
              sweep.
            </p>
          ) : null}
        </div>
        {/* A finding that names no bead at all (an exhausted sync-push/run-health job) is answered
            on the JOB instead — otherwise the row would show no way to settle it and sit here
            forever. A stale PR gets Dismiss instead of Resume: its work is already delivered and
            open for review, so re-running the epic changes nothing about the PR (execute-epic
            short-circuits on an open one) — the row would settle and the next sweep would raise it
            again. What it needs is a reviewer, which is the founder's move, and the PR link above
            is how they take it. */}
        <EscalationActions
          slug={slug}
          escalationId={escalation.id}
          canResume={
            escalation.kind !== "stale-pr" &&
            (escalation.epicBeadId !== undefined || escalation.jobId !== undefined)
          }
          canDismiss={escalation.kind === "stale-pr"}
          canAbandon={escalation.beadId !== undefined || escalation.jobId !== undefined}
          target={
            escalation.beadId === undefined && escalation.epicBeadId === undefined ? "job" : "work"
          }
        />
      </>
    );
  }

  if (item.source === "review") {
    const { target } = item;
    return (
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">
        <MetaChip tone="risk-med">Substantial rework</MetaChip>
        <Link
          href={`/projects/${slug}/epics/${target.id}`}
          className="rounded-sm font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          title={target.title}
        >
          {target.id}
        </Link>
        <span className="text-xs text-foreground">{target.title}</span>
        <span className="text-xs text-muted-foreground">
          the lowest self-review score on the board — the work did not satisfy its contract
        </span>
        <span className="ml-auto">
          <ReviewScoreChip score={target.score} />
        </span>
      </div>
    );
  }

  const { finding } = item;
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">
      <MetaChip tone={item.severity === "attention" ? "risk-med" : "neutral"}>
        {HYGIENE_LABELS[finding.kind]}
      </MetaChip>
      {findingBeadIds(item).map((id) => (
        <BeadLink key={id} id={id} onOpenBead={onOpenBead} />
      ))}
      {finding.title ? <span className="text-xs text-foreground">{finding.title}</span> : null}
      {/* The detail is the whole row — full text, never truncated: it is the sentence a human
          judges the finding on. */}
      <span className="text-xs text-muted-foreground">{finding.detail}</span>
    </div>
  );
}
