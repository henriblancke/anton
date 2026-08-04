"use client";

import { useEffect, useId, useRef, useState } from "react";

import { describeCron, isFastCadence } from "@/lib/jobs/cadence";
import { formatExactTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Toggle } from "@/components/atoms";
import { CadenceEditor } from "@/components/settings/cadence-editor";

/** One automation's live schedule state. `enabled: null` = this project has no row for it yet. */
export interface AutomationScheduleState {
  enabled: boolean | null;
  /** The cron that fires today, or the default cadence when no row exists yet. */
  cron: string;
  /** Epoch SECONDS, as stored. Absent while the automation is off or unscheduled. */
  nextRunAt?: number;
  /** Epoch SECONDS of the last fire, as stored. Absent until it has run once. */
  lastRunAt?: number;
}

/** What one automation is, and what makes it inert. */
export interface AutomationSpec {
  id: string;
  label: string;
  /** What it DOES. Never its cadence — that is read from the schedule row. */
  description: string;
  /**
   * The automation whose output this one consumes. `unstick` acts on what `run-health` finds and
   * `gate-check` on gates other jobs open, so with that producer off they are not broken, they are
   * idle — and the row has to say which, or an operator reads a healthy no-op as a failure.
   */
  dependsOn?: string;
  /** Which group it belongs to, so seven rows read as three concerns. */
  group: string;
}

/** Group order — board first (what the operator curates), then health, then delivery. */
export const AUTOMATION_GROUPS = ["Board maintenance", "Run health", "Delivery"] as const;

function formatInstant(unixSeconds: number): string {
  return formatExactTime(new Date(unixSeconds * 1000).toISOString()) ?? "unknown";
}

/**
 * How long until a scheduled fire — "in 4m", "in 7h", "in 3d". A countdown rather than a wall-clock
 * stamp because the column is read by comparing rows against each other; the exact instant is on the
 * cell's tooltip for when it matters. `formatRelativeTime` can't serve this: it clamps the future to
 * zero and would render every pending run as "0s ago".
 */
function formatCountdown(unixSeconds: number, nowMs = Date.now()): string {
  const seconds = Math.floor((unixSeconds * 1000 - nowMs) / 1000);
  if (seconds <= 0) return "due now";
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `in ${Math.floor(seconds / 3600)}h`;
  return `in ${Math.floor(seconds / 86_400)}d`;
}

/**
 * Settings → Automation, as a table (anton-ue90.4).
 *
 * Seven automations are records with identical fields, so they are rendered as rows that can be read
 * down a column — the previous card list lived in half a two-column grid, which is what made every
 * control fight for its width. Cadence is a button opening {@link CadenceEditor} in a popover rather
 * than a select that grew an input and reflowed the rows beneath it.
 *
 * Everything here is read from the schedule row, never from copy in this file: a description that
 * disagreed with the row that actually fires would be worse than no description at all.
 */
export function AutomationTable({
  automations,
  state,
  defaultCrons,
  onCronChange,
  onToggle,
}: {
  automations: AutomationSpec[];
  state: Record<string, AutomationScheduleState>;
  /** DEFAULT_SCHEDULES' cron per type — the cadence "Reset" restores. */
  defaultCrons: Record<string, string>;
  onCronChange: (id: string, cron: string) => void;
  onToggle: (id: string, next: boolean) => void;
}) {
  const enabledCount = automations.filter((a) => state[a.id]?.enabled === true).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="text-xs text-subtle">
          {enabledCount} of {automations.length} running
        </span>
        {/* Stated once for the section: cron and next-run times use this machine's clock. */}
        <span className="text-xs text-subtle">· cadences and times are local</span>
        <span className="flex-1" />
        {/* This panel does not wait for Save, and the difference has to be visible: everything else
            on this page is staged until the header button, and silently mixing the two contracts is
            how an operator loses an edit. */}
        <span className="rounded-full border border-border bg-secondary px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
          saves immediately
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[38rem] border-collapse text-left">
          <thead>
            <tr className="border-b border-border">
              {["Automation", "Cadence", "Next run", "Last run", ""].map((heading, i) => (
                <th
                  key={heading || i}
                  scope="col"
                  className="px-2.5 pb-1.5 font-mono text-[9.5px] tracking-[0.11em] font-normal text-subtle uppercase whitespace-nowrap"
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {AUTOMATION_GROUPS.flatMap((group) => {
              const rows = automations.filter((a) => a.group === group);
              if (rows.length === 0) return [];
              return [
                <tr key={`group-${group}`}>
                  <th
                    scope="colgroup"
                    colSpan={5}
                    className="border-b border-border px-2.5 pt-4 pb-1 text-left font-mono text-[9.5px] tracking-[0.11em] font-normal text-subtle uppercase"
                  >
                    {group}
                  </th>
                </tr>,
                ...rows.map((automation) => (
                  <AutomationTableRow
                    key={automation.id}
                    automation={automation}
                    state={state[automation.id]}
                    producerOn={
                      automation.dependsOn ? state[automation.dependsOn]?.enabled === true : true
                    }
                    defaultCron={defaultCrons[automation.id] ?? state[automation.id].cron}
                    onCronChange={(cron) => onCronChange(automation.id, cron)}
                    onToggle={(next) => onToggle(automation.id, next)}
                  />
                )),
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AutomationTableRow({
  automation,
  state,
  producerOn,
  defaultCron,
  onCronChange,
  onToggle,
}: {
  automation: AutomationSpec;
  state: AutomationScheduleState;
  /** Whether the automation this one consumes is itself on. */
  producerOn: boolean;
  defaultCron: string;
  onCronChange: (cron: string) => void;
  onToggle: (next: boolean) => void;
}) {
  const on = state.enabled === true;
  // A cadence faster than the threshold is flagged on the row as well as in the editor: the editor
  // is only open while someone is choosing, and this is the state they left behind.
  const fast = isFastCadence(state.cron);

  return (
    <tr className={cn("border-b border-border/60 last:border-b-0", !on && "opacity-70")}>
      <td className="px-2.5 py-2 align-middle">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              on ? "bg-stage-done" : "bg-stage-backlog",
            )}
            aria-hidden="true"
          />
          <div className="flex min-w-0 flex-col">
            <span className="text-[12.5px] text-foreground">{automation.label}</span>
            <span className="font-mono text-[10.5px] text-subtle">
              {automation.description}
              {automation.dependsOn ? (
                <span className={producerOn ? "text-subtle" : "text-risk-med"}>
                  {producerOn
                    ? ` · fed by ${automation.dependsOn}`
                    : ` · idle until ${automation.dependsOn} is on`}
                </span>
              ) : null}
            </span>
          </div>
        </div>
      </td>

      <td className="px-2.5 py-2 align-middle">
        <CadenceCell
          label={automation.label}
          cron={state.cron}
          defaultCron={defaultCron}
          fast={fast}
          onCommit={onCronChange}
        />
      </td>

      <td className="px-2.5 py-2 align-middle font-mono text-[11.5px] tabular-nums whitespace-nowrap text-muted-foreground">
        {on && state.nextRunAt ? (
          <span title={formatInstant(state.nextRunAt)}>{formatCountdown(state.nextRunAt)}</span>
        ) : (
          <span className="text-subtle">not scheduled</span>
        )}
      </td>

      <td className="px-2.5 py-2 align-middle font-mono text-[11.5px] tabular-nums whitespace-nowrap text-muted-foreground">
        {state.lastRunAt ? (
          <span title={formatInstant(state.lastRunAt)}>
            {formatRelativeTime(new Date(state.lastRunAt * 1000).toISOString())}
          </span>
        ) : (
          <span className="text-subtle">never</span>
        )}
      </td>

      <td className="px-2.5 py-2 text-right align-middle">
        <Toggle checked={on} onChange={onToggle} label={automation.label} />
      </td>
    </tr>
  );
}

/**
 * The cadence as a phrase, opening the editor in a popover. A popover and not an inline panel: this
 * is a table, and growing a row would push every row below it down mid-edit.
 */
function CadenceCell({
  label,
  cron,
  defaultCron,
  fast,
  onCommit,
}: {
  label: string;
  cron: string;
  defaultCron: string;
  fast: boolean;
  onCommit: (cron: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target)) return;
      // The frequency and time pickers portal their menus outside this subtree; a click that lands
      // in one of them must not read as "clicked away" and discard the draft.
      if (target instanceof Element && target.closest("[data-slot='select-positioner']")) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={anchorRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={popoverId}
        aria-label={`${label} cadence`}
        // The phrase is on the button; the tooltip gives the exact expression behind it.
        title={cron}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex max-w-[13rem] items-center gap-1.5 truncate rounded-lg border border-transparent bg-secondary px-2 py-1 font-mono text-[11.5px] text-foreground transition-colors hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
          open && "border-primary/60",
        )}
      >
        {fast ? (
          <span className="size-1.5 shrink-0 rounded-full bg-risk-med" aria-hidden="true" />
        ) : null}
        <span className="truncate">{describeCron(cron)}</span>
      </button>

      {open ? (
        <div
          id={popoverId}
          className="absolute top-[calc(100%+6px)] left-0 z-30 rounded-xl border border-border bg-popover p-3 shadow-lg"
        >
          <CadenceEditor
            label={label}
            cron={cron}
            defaultCron={defaultCron}
            onCommit={onCommit}
            onClose={() => setOpen(false)}
          />
        </div>
      ) : null}
    </div>
  );
}
