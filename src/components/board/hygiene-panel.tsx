"use client";

import { useId, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, SproutIcon } from "lucide-react";

import { MetaChip, RelativeTime } from "@/components/atoms";
// Type-only, via the shared board contract: a value import of lib/hygiene would pull drizzle and
// better-sqlite3 into this client bundle.
import type { HygieneFinding, HygieneFindingKind, HygieneReport } from "@/lib/types";

/** What each class of board rot is, said the way a founder would say it. */
const KIND_LABELS: Record<HygieneFindingKind, string> = {
  lint: "Contract gap",
  "stale-open": "Stale",
  "stale-in-progress": "Abandoned run",
  orphan: "Shipped, not closed",
  "dep-cycle": "Dependency cycle",
  duplicate: "Duplicate",
};

/** The noun each kind counts, for the summary line: "3 stale · 1 dependency cycle". */
const KIND_NOUNS: Record<HygieneFindingKind, [singular: string, plural: string]> = {
  lint: ["contract gap", "contract gaps"],
  "stale-open": ["stale", "stale"],
  "stale-in-progress": ["abandoned run", "abandoned runs"],
  orphan: ["shipped, not closed", "shipped, not closed"],
  "dep-cycle": ["dependency cycle", "dependency cycles"],
  duplicate: ["duplicate", "duplicates"],
};

/**
 * Only the two findings that make the board LIE about itself are tinted: a cycle breaks the
 * readiness `bd ready` serves, and an abandoned in-progress bead reads as in-flight work to every
 * other machine. The rest are housekeeping and stay quiet — a panel where everything is loud is a
 * panel an operator learns to skip.
 */
const KIND_TONE: Partial<Record<HygieneFindingKind, "risk-high" | "risk-med">> = {
  "dep-cycle": "risk-high",
  "stale-in-progress": "risk-med",
};

/**
 * Summary order. Keyed off KIND_LABELS rather than lib/hygiene's HYGIENE_FINDING_KINDS (a value
 * import that would reach the browser) — the Record type still fails the build if a kind is added
 * and not labelled here.
 */
const KIND_ORDER = Object.keys(KIND_LABELS) as HygieneFindingKind[];

/** Every bead a finding concerns — one for a per-bead finding, the whole ring/group otherwise. */
function findingBeadIds(finding: HygieneFinding): string[] {
  if (finding.ids?.length) return finding.ids;
  return finding.beadId ? [finding.beadId] : [];
}

function countLabel(kind: HygieneFindingKind, n: number): string {
  const [singular, plural] = KIND_NOUNS[kind];
  return `${n} ${n === 1 ? singular : plural}`;
}

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/** Opens the bead's detail dialog — the same one a standalone chip opens, so a finding is one
 * click from the contract that has to change to settle it. */
function BeadLink({ id, onOpenBead }: { id: string; onOpenBead: (beadId: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpenBead(id)}
      className="rounded-sm font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      title={`Open ${id}`}
    >
      {id}
    </button>
  );
}

/**
 * The gardener's latest patrol report (anton-uwal), on the board where work is approved rather than
 * in a job log. It shows both tiers the patrol produces: what it APPLIED (epics closed because every
 * child was closed, `is_blocked` rows repaired) and what it FOUND and left alone — findings are
 * judgment calls, so this panel reports and links, and never offers to act.
 *
 * Collapsed by default with per-kind counts in the header: nothing is hidden, but a board with six
 * housekeeping findings must not push the columns below the fold. Renders nothing at all for a
 * project that has never been patrolled — the gardener schedule is opt-in, so an un-patrolled
 * project would otherwise carry a permanent empty panel it can do nothing about.
 */
export function HygienePanel({
  report,
  onOpenBead,
}: {
  report: HygieneReport | undefined;
  onOpenBead: (beadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();

  if (!report) return null;

  const { actions, counts, findings } = report;
  const kinds = KIND_ORDER.filter((kind) => counts[kind] > 0);
  const expandable = findings.length > 0 || actions.closedEpics.length > 0;

  return (
    <section
      aria-labelledby={`${bodyId}-heading`}
      className="mb-3 rounded-xl border border-border bg-card/60"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2">
        <SproutIcon className="size-3.5 text-subtle" aria-hidden="true" />
        <h2 id={`${bodyId}-heading`} className="text-xs font-medium text-foreground">
          Board hygiene
        </h2>
        <span className="text-xs text-subtle">
          patrolled <RelativeTime iso={iso(report.generatedAt)} />
        </span>
        {actions.closedEpics.length > 0 ? (
          <MetaChip tone="done">
            closed {actions.closedEpics.length}{" "}
            {actions.closedEpics.length === 1 ? "epic" : "epics"}
          </MetaChip>
        ) : null}
        {actions.rowsRecomputed > 0 ? (
          <MetaChip>
            <span
              title={`The patrol rebuilt ${actions.rowsRecomputed} stale is_blocked row(s) from the dependency graph — bd ready trusts that flag.`}
            >
              repaired {actions.rowsRecomputed} blocked{" "}
              {actions.rowsRecomputed === 1 ? "row" : "rows"}
            </span>
          </MetaChip>
        ) : null}
        {kinds.length > 0 ? (
          kinds.map((kind) => (
            <MetaChip key={kind} tone={KIND_TONE[kind]}>
              {countLabel(kind, counts[kind])}
            </MetaChip>
          ))
        ) : (
          // A patrol that found nothing still says so: "clean" and "never patrolled" are different
          // claims, and only one of them means the board can be trusted.
          <span className="text-xs text-subtle">nothing to clean up</span>
        )}
        <span className="flex-1" />
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {open ? (
              <ChevronDownIcon className="size-3.5" aria-hidden="true" />
            ) : (
              <ChevronRightIcon className="size-3.5" aria-hidden="true" />
            )}
            {open ? "Hide details" : "Show details"}
          </button>
        ) : null}
      </div>
      {open && expandable ? (
        <div id={bodyId} className="divide-y divide-border border-t border-border">
          {actions.closedEpics.length > 0 ? (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-2 text-xs text-muted-foreground">
              <span className="text-foreground">Applied</span>
              <span>every child was closed, so the patrol closed:</span>
              {actions.closedEpics.map((id) => (
                <BeadLink key={id} id={id} onOpenBead={onOpenBead} />
              ))}
            </div>
          ) : null}
          {/* Findings arrive sorted by kind, then key (lib/hygiene sortFindings), so a flat list
              already reads grouped — and two patrols over an unchanged board render identically. */}
          {findings.length > 0 ? (
            <ul className="divide-y divide-border">
              {findings.map((finding) => (
                <li
                  key={finding.key}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-2"
                >
                  <MetaChip tone={KIND_TONE[finding.kind]}>{KIND_LABELS[finding.kind]}</MetaChip>
                  {findingBeadIds(finding).map((id) => (
                    <BeadLink key={id} id={id} onOpenBead={onOpenBead} />
                  ))}
                  {finding.title ? (
                    <span className="text-xs text-foreground">{finding.title}</span>
                  ) : null}
                  {/* The detail is the whole row — full text, never truncated: it is the sentence a
                      human judges the finding on. */}
                  <span className="text-xs text-muted-foreground">{finding.detail}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
