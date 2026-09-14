import Link from "next/link";

import { hasAppliedActions } from "@/lib/attention";
import type { PickerLogEntry, PickerLogKind } from "@/lib/picker-log";
import { criterionLabel, policyHref } from "@/lib/policy/href";
import { formatCountdown } from "@/lib/time";
import type { HygieneReport } from "@/lib/types";
import { MetaChip, RelativeTime } from "@/components/atoms";
import { PROVENANCE_MARK } from "@/components/board/provenance-badge";
import { HealthBeadLink } from "./bead-link";

/**
 * THE DECISION LOG (anton-vfvg / R3.10): what the automated passes did on their own authority, and
 * what the operator said back.
 *
 * Two records, one section, because they answer one question — "what happened here while nobody was
 * watching". The gardener's applies were always here; the picker's unattended starts join them
 * rather than getting a log of their own (a second place to look is a place that stops being looked
 * at), and the vetoes join those, because a record of only the moves anton made would read as
 * agreement it never had.
 *
 * Every entry is readable without opening a run: the target, what happened to it, the rule behind it
 * and when. The two links are the evidence — the bead opens in the page's ticket dialog, and `◈
 * policy` opens the rule at this bead's own evaluation, which is the same badge and the same URL the
 * board's cards use (`provenance-badge.tsx`).
 *
 * Renders nothing when there is nothing recorded — a patrol that changed nothing and a picker that
 * has started nothing is not a panel, and an empty log would read as a claim about a quiet system
 * rather than as silence.
 */
export function AppliedSection({
  slug,
  hygiene,
  pickerLog = [],
}: {
  slug: string;
  hygiene: HygieneReport | undefined;
  pickerLog?: PickerLogEntry[];
}) {
  const patrol = hygiene && hasAppliedActions(hygiene) ? hygiene.actions : undefined;
  if (!patrol && pickerLog.length === 0) return null;

  return (
    <section
      aria-labelledby="applied-heading"
      className="rounded-xl border border-border bg-card/60 text-xs"
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-border/60 px-3 py-2">
        <h2 id="applied-heading" className="text-xs font-medium text-foreground">
          Decision log
        </h2>
        <span className="text-[11px] text-subtle">
          what ran unattended, and what you refused
        </span>
      </div>
      {pickerLog.length > 0 ? (
        <ul className="divide-y divide-border/50">
          {pickerLog.map((entry) => (
            <PickerLogRow key={entry.key} slug={slug} entry={entry} />
          ))}
        </ul>
      ) : null}
      {patrol ? (
        <div className="flex flex-col gap-1.5 border-t border-border/50 px-3 py-2.5 text-xs text-muted-foreground first:border-t-0">
          {patrol.closedEpics.length > 0 ? (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-foreground">Applied</span>
              <span>every child was closed, so the patrol closed:</span>
              {patrol.closedEpics.map((id) => (
                <HealthBeadLink key={id} id={id} />
              ))}
            </div>
          ) : null}
          {patrol.rowsRecomputed > 0 ? (
            <p
              title={`The patrol rebuilt ${patrol.rowsRecomputed} stale is_blocked row(s) from the dependency graph — bd ready trusts that flag.`}
            >
              repaired {patrol.rowsRecomputed} blocked{" "}
              {patrol.rowsRecomputed === 1 ? "row" : "rows"}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** The word each kind is filed under — the operator's own vocabulary from the Up Next lane. */
const KIND_LABEL: Record<PickerLogKind, string> = {
  start: "started",
  deferral: "not now",
  veto: "never",
};

/**
 * What happened, in one sentence.
 *
 * A start says WHO decided, because that is the fact the whole log exists to report: nobody
 * approved it. A veto says what the operator bought with it — a bounded hold, and for `Never` the
 * criterion they were handed to tighten — so a record of disagreement reads as an act and not just
 * as a refusal.
 */
function entrySummary(entry: PickerLogEntry): string {
  if (entry.kind === "start") {
    const where =
      entry.rank && entry.ranked ? ` — rank ${entry.rank} of ${entry.ranked}` : "";
    return `anton started this on its own${where}, and nobody approved it`;
  }
  const hold = holdNote(entry.heldUntilMs);
  if (entry.kind === "veto") {
    const at = entry.criterion ? ` at ${criterionLabel(entry.criterion)}` : "";
    return `you refused this pick and went to tighten the policy${at}${hold}`;
  }
  return `you set this pick aside${hold}`;
}

/** How much of the bounded window is left — the difference between pacing and a blocklist. */
function holdNote(heldUntilMs: number | undefined): string {
  if (!heldUntilMs) return "";
  const left = formatCountdown(new Date(heldUntilMs).toISOString());
  return !left || left === "now" ? " — the hold has run out" : ` — held ${left} longer`;
}

/**
 * The rule behind the entry, as the board's own `◈ policy` mark (R3.7).
 *
 * The same glyph, the same destination and the same `policyHref` grammar the cards use, but written
 * out here rather than rendered through {@link ProvenanceBadge}: that badge hands `Link` an
 * `onClick` for the clickable card it sits on, and a function prop cannot cross into a Server
 * Component. There is no card underneath a log row, so there is nothing to stop propagating.
 *
 * A `Never` carries the criterion it named, so the link opens the control the operator was sent to
 * tighten; everything else opens the policy at this bead's own evaluation, which is what "why was
 * this admitted?" asks.
 */
function PolicyLink({ slug, entry }: { slug: string; entry: PickerLogEntry }) {
  const rule = entry.rule ?? "the work policy";
  return (
    <Link
      href={policyHref(slug, entry.criterion, entry.beadId)}
      title={`Admitted by ${rule} — open the policy with this bead's evaluated criteria`}
      className="rounded-md focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <MetaChip className="transition-colors hover:border-ring/40 hover:text-foreground">
        <span aria-hidden="true">{PROVENANCE_MARK}</span>
        policy
      </MetaChip>
    </Link>
  );
}

/**
 * One recorded decision: what it was, which bead, the rule behind it, and when.
 *
 * The bead opens in the page's ticket dialog and the rule opens the policy — the two pieces of
 * evidence behind an unattended decision, both reachable without leaving the report.
 */
function PickerLogRow({ slug, entry }: { slug: string; entry: PickerLogEntry }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-2">
      <MetaChip>{KIND_LABEL[entry.kind]}</MetaChip>
      <HealthBeadLink id={entry.beadId} />
      <span className="text-xs text-muted-foreground">{entrySummary(entry)}</span>
      <PolicyLink slug={slug} entry={entry} />
      <RelativeTime
        className="ml-auto text-[11px] text-subtle"
        iso={new Date(entry.atMs).toISOString()}
      />
    </li>
  );
}
