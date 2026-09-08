"use client";

import { HourglassIcon } from "lucide-react";

import {
  QUOTA_SHARE_RANGE,
  formatApproxPct,
  resolveQuotaSplit,
  type QuotaShareProject,
  type QuotaShareRow,
} from "@/lib/quota-share";
import { cn } from "@/lib/utils";
import { MetaChip, Toggle } from "@/components/atoms";
import { Button } from "@/components/ui/button";

/**
 * Settings → Quota shares (anton-68hl / R6.3), as a table following the Automation panel.
 *
 * Several repos run against one Claude subscription, and this is where an operator declares how it
 * is divided. Rendered as rows because the question is comparative — "what is my cut against
 * everyone else's" — and a card per project would put the two numbers being compared on different
 * lines.
 *
 * EVERY derived figure here is marked approximate, and that is the panel's whole reason to be
 * careful. Attribution is sampled: the runner only opens a burn window when a job runs alone, so a
 * busy machine attributes a fraction of what it spent. An operator who reconciles these numbers
 * against a bill must already know that — hence the one-line explanation above the table, which is
 * load-bearing and not decoration. A figure with no sample behind it says so; it never reads `0%`.
 *
 * Only THIS project's share and reserve are editable. Every other project's row is read-only, edited
 * from its own settings — a per-project settings page that wrote another project's row would be a
 * second, invisible writer of a settings blob its own page is also saving.
 */
export function QuotaShareTable({
  projects,
  currentProjectId,
  share,
  reserved,
  equalSplitPct,
  onShareChange,
  onReserveChange,
}: {
  /** Every project on this machine, as the server resolved it. */
  projects: readonly QuotaShareProject[];
  currentProjectId: string;
  /** The STAGED share for this project — `null` while it is still on the equal-split default. */
  share: number | null;
  /** The staged `reserve my share` opt-out. */
  reserved: boolean;
  /** What an undeclared share resolves to: an equal cut of the governed projects. */
  equalSplitPct: number;
  onShareChange: (next: number | null) => void;
  onReserveChange: (next: boolean) => void;
}) {
  // The staged edit replaces the stored row before the split is resolved, so the numbers under the
  // input are the ones this edit would produce — not the ones the last save produced.
  const staged = projects.map((project) =>
    project.id === currentProjectId
      ? { ...project, sharePct: share ?? equalSplitPct, declared: share !== null, reserved }
      : project,
  );
  const split = resolveQuotaSplit(staged);
  const governed = split.rows.filter((row) => row.governed).length;
  const lending = split.rows.filter((row) => row.reallocated);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="text-xs text-subtle">
          {governed} of {split.rows.length} project{split.rows.length === 1 ? "" : "s"} paced by a
          share
        </span>
        <span className="text-xs text-subtle">· a pacing target, never a ledger</span>
      </div>

      {/* The one line an operator has to read before believing any figure below it. Without it the
          panel reads as broken accounting rather than as sampling working exactly as designed. */}
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Spend is sampled, not metered: anton can only attribute a run&rsquo;s burn when that run had
        the machine to itself, so a busy machine attributes far less than it actually spent — every
        figure here is an estimate, marked <span className="font-mono">≈</span>.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[38rem] border-collapse text-left">
          <thead>
            <tr className="border-b border-border">
              {["Project", "Share", "In force now", "≈ spent this week", "Reserve"].map(
                (heading) => (
                  <th
                    key={heading}
                    scope="col"
                    className="px-2.5 pb-1.5 font-mono text-[9.5px] tracking-[0.11em] font-normal text-subtle uppercase whitespace-nowrap"
                  >
                    {heading}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {split.rows.map((row) => (
              <QuotaShareTableRow
                key={row.id}
                row={row}
                current={row.id === currentProjectId}
                share={share}
                equalSplitPct={equalSplitPct}
                onShareChange={onShareChange}
                onReserveChange={onReserveChange}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] text-subtle">
          Declared {Math.round(split.declaredTotalPct)}% across {governed} paced project
          {governed === 1 ? "" : "s"} ·{" "}
          {split.spentTotalPct === null
            ? "no spend attributed to any project yet"
            : `${formatApproxPct(split.spentTotalPct, 1)} of the weekly quota attributed so far`}
        </span>
        {/* Renormalization named rather than merely implied (R6.4): a cut that reads higher than the
            number the operator typed must say whose share it is borrowing, and for how long. */}
        {lending.length > 0 && (
          <span role="status" className="text-[11px] text-subtle">
            {Math.round(split.reallocatedPct)}% of the split is in use elsewhere right now:{" "}
            {joinNames(lending.map((row) => row.name))} {lending.length === 1 ? "has" : "have"} no
            eligible work and did not reserve {lending.length === 1 ? "its" : "their"} share. It
            comes back on the next pass, with nothing to undo.
          </span>
        )}
        {/* Surfaced rather than silently normalized away: the shares below ARE renormalized, and an
            operator who declared 30/30/30 is owed the reason their cut reads 33. */}
        {split.imbalanced && (
          <span role="status" className="text-[11px] text-risk-med">
            Shares add up to {Math.round(split.declaredTotalPct)}%, not 100% — each project still
            gets its slice of the total, so the split below is these numbers in proportion.
          </span>
        )}
        {split.seeded && (
          <span className="text-[11px] text-subtle">
            Some spend is still estimated from tier seeds rather than measured burn — it sharpens as
            runs are sampled.
          </span>
        )}
      </div>
    </div>
  );
}

/** Project names as prose, so the reallocation line names who rather than counting them. */
function joinNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * One project's position. The current project's row carries the two controls; every other row is the
 * fact it reports, so the table reads as one split rather than as five editable forms.
 */
function QuotaShareTableRow({
  row,
  current,
  share,
  equalSplitPct,
  onShareChange,
  onReserveChange,
}: {
  row: QuotaShareRow;
  current: boolean;
  share: number | null;
  equalSplitPct: number;
  onShareChange: (next: number | null) => void;
  onReserveChange: (next: boolean) => void;
}) {
  return (
    <tr className={cn("border-b border-border/60 last:border-b-0", !row.governed && "opacity-70")}>
      <td className="px-2.5 py-2 align-middle">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              row.governed ? "bg-stage-done" : "bg-stage-backlog",
            )}
            aria-hidden="true"
          />
          <div className="flex min-w-0 flex-col">
            <span className="text-[12.5px] text-foreground">
              {row.name}
              {current ? <span className="text-subtle"> · this project</span> : null}
            </span>
            <span className="font-mono text-[10.5px] text-subtle">
              {!row.governed
                ? "budget-aware execution off · spends unpaced"
                : row.eligible === null
                  ? // Nothing looked: the board-picker pass is not armed here, so this machine has
                    // no reading to report. Claiming either answer would be inventing one.
                    "eligibility not observed here"
                  : row.eligible
                    ? "has work ready to start"
                    : "no eligible work right now"}
            </span>
          </div>
        </div>
      </td>

      <td className="px-2.5 py-2 align-middle">
        {current ? (
          <ShareInput
            share={share}
            equalSplitPct={equalSplitPct}
            name={row.name}
            onChange={onShareChange}
          />
        ) : (
          <span className="font-mono text-[11.5px] tabular-nums text-muted-foreground">
            {Math.round(row.sharePct)}%
            {row.declared ? null : <span className="text-subtle"> · default</span>}
          </span>
        )}
      </td>

      <td className="px-2.5 py-2 align-middle font-mono text-[11.5px] tabular-nums whitespace-nowrap">
        <InForceCell row={row} />
      </td>

      <td className="px-2.5 py-2 align-middle font-mono text-[11.5px] tabular-nums whitespace-nowrap text-muted-foreground">
        <span
          title={
            row.spentWeeklyPct === null
              ? "No burn attributable to this project yet — not the same as having spent nothing."
              : "Estimated from this machine's sampled per-run burn averages."
          }
        >
          {formatApproxPct(row.spentWeeklyPct, 1)}
        </span>
      </td>

      <td className="px-2.5 py-2 text-right align-middle">
        {current ? (
          <Toggle checked={row.reserved} onChange={onReserveChange} label="Reserve my share" />
        ) : (
          <span className="font-mono text-[10.5px] text-subtle">
            {row.reserved ? "reserved" : "—"}
          </span>
        )}
      </td>
    </tr>
  );
}

/**
 * What this project's share works out to right now.
 *
 * An idle, unreserved project reads as reallocated rather than as zero: its share is not lost, it is
 * being spent by the projects that have work, and it comes back on the next pass with no operator
 * action. The reserve control sits in the next cell of the same row, so the answer to what this row
 * says is one click away from it.
 */
function InForceCell({ row }: { row: QuotaShareRow }) {
  if (!row.governed) {
    return <span className="text-subtle">not paced</span>;
  }
  if (row.reallocated) {
    return (
      <span className="flex flex-col items-start gap-1">
        <span className="text-subtle">{formatApproxPct(0)}</span>
        <MetaChip>
          <HourglassIcon className="size-2.5" aria-hidden="true" />
          <span title="Idle and unreserved, so this share is being spent by the projects that do have work. It returns on the next pass — or reserve it to keep it.">
            share in use elsewhere
          </span>
        </MetaChip>
      </span>
    );
  }
  return (
    <span className="flex flex-col items-start gap-0.5">
      <span className="text-muted-foreground">{formatApproxPct(row.effectivePct)}</span>
      {row.gainedPct >= 0.5 && (
        <span className="text-[10.5px] text-subtle">
          +{Math.round(row.gainedPct)} pts from idle projects
        </span>
      )}
      {row.reserved && row.eligible === false && (
        <span className="text-[10.5px] text-subtle">reserved while idle</span>
      )}
    </span>
  );
}

/**
 * The declared share, as an input rather than a reported figure — it is the one number on this panel
 * the operator states rather than anton estimates, so it carries no `≈`. Cleared, the project falls
 * back to an equal cut, which is what the placeholder shows.
 */
function ShareInput({
  share,
  equalSplitPct,
  name,
  onChange,
}: {
  share: number | null;
  equalSplitPct: number;
  name: string;
  onChange: (next: number | null) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative flex w-[6.5rem] items-center rounded-[10px] border border-border bg-card focus-within:border-primary/60">
        <input
          type="number"
          min={QUOTA_SHARE_RANGE.min}
          max={QUOTA_SHARE_RANGE.max}
          value={share ?? ""}
          placeholder={String(Math.round(equalSplitPct))}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") return onChange(null);
            const next = Number(raw);
            if (!Number.isFinite(next)) return;
            onChange(
              Math.min(QUOTA_SHARE_RANGE.max, Math.max(QUOTA_SHARE_RANGE.min, Math.round(next))),
            );
          }}
          aria-label={`${name} quota share, percent`}
          className="w-full rounded-[10px] bg-transparent px-3 py-1.5 pr-7 font-mono text-[12.5px] text-foreground outline-none placeholder:text-subtle"
        />
        <span className="pointer-events-none absolute right-3 text-[11px] text-subtle">%</span>
      </div>
      {share === null ? (
        <span className="text-[10.5px] text-subtle">equal split</span>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
          Reset
        </Button>
      )}
    </div>
  );
}
