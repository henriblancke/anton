"use client";

import { useEffect, useId, useRef, useState } from "react";

import { describeCron, isFastCadence } from "@/lib/jobs/cadence";
import { formatExactTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Toggle } from "@/components/atoms";
import { CadenceEditor } from "@/components/settings/cadence-editor";

/**
 * How the last fire ENDED, mirrored from the server's `ScheduleLastRun` (lib/schedule-runs.ts) so
 * this client module imports no server code. `noop` is the one that earns its own state: an
 * automation that ran and had nothing to do is working, and reading it as either success or silence
 * is what made "last run: 3h ago" unanswerable.
 */
export type ScheduleRunOutcome = "ok" | "noop" | "failed" | "cancelled";

export interface ScheduleLastRun {
  outcome: ScheduleRunOutcome;
  /** Epoch SECONDS — when the fire settled. */
  at: number;
  /** One short line: what it did, or why it failed. */
  note?: string;
}

/** One automation's live schedule state. `enabled: null` = this project has no row for it yet. */
export interface AutomationScheduleState {
  enabled: boolean | null;
  /** The cron that fires today, or the default cadence when no row exists yet. */
  cron: string;
  /** Epoch SECONDS, as stored. Absent while the automation is off or unscheduled. */
  nextRunAt?: number;
  /** Epoch SECONDS of the last fire, as stored. Absent until it has run once. */
  lastRunAt?: number;
  /** How that fire ended. Absent until a job this schedule enqueued has settled. */
  lastRun?: ScheduleLastRun;
}

/**
 * The four outcomes, as a dot and a word.
 *
 * A no-op gets the SAME neutral weight as an unknown rather than the success colour: the column is
 * scanned for the one row that is wrong, and painting every idle ten-minute poll green is how a real
 * failure gets lost in it. Only failure is coloured, because only failure is a decision.
 */
const OUTCOME_STYLES: Record<ScheduleRunOutcome, { dot: string; label: string; text: string }> = {
  ok: { dot: "bg-stage-done", label: "ok", text: "text-muted-foreground" },
  noop: { dot: "bg-border", label: "nothing to do", text: "text-subtle" },
  failed: { dot: "bg-risk-high", label: "failed", text: "text-risk-high" },
  cancelled: { dot: "bg-risk-med", label: "cancelled", text: "text-muted-foreground" },
};

/**
 * A fire that has been enqueued but has not settled. Amber — the colour work in flight wears
 * everywhere else here — and deliberately not the last settled fire's colour, because that verdict
 * belongs to an older run.
 */
const IN_FLIGHT_STYLE = { dot: "bg-stage-implementing", text: "text-muted-foreground" };

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
  /** Which group it belongs to, so a list of rows reads as three concerns. */
  group: string;
}

/** Group order — board first (what the operator curates), then health, then delivery. */
export const AUTOMATION_GROUPS = ["Board maintenance", "Run health", "Delivery"] as const;

/**
 * How often the time columns re-read the clock. Five seconds and not a minute because the countdown
 * prints seconds inside the last minute ("in 45s"), so a minute-long tick would let a row sit a full
 * minute past due still claiming time was left; five seconds and not one because a page of text
 * do not need sixty renders a minute to stay honest.
 */
const CLOCK_TICK_MS = 5_000;

/**
 * The clock, as a value that re-renders its reader.
 *
 * {@link formatCountdown} and `formatRelativeTime` are pure functions of "now", so without something
 * moving that argument this table is frozen at whatever the clock read when it last rendered — and
 * nothing else on this panel re-renders on its own. That is what let a row keep saying `in 9m` long
 * after the run was due.
 *
 * Seeded straight from `Date.now()` rather than the hydration-deferred shape `StuckFor` uses on the
 * board: the settings panels are gated on `useActiveSection`, whose server snapshot is always
 * "general", so this table only ever mounts in the browser and never takes part in a hydration
 * comparison. There is no render where a server clock and a client clock could disagree.
 */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function formatInstant(unixSeconds: number): string {
  return formatExactTime(new Date(unixSeconds * 1000).toISOString()) ?? "unknown";
}

/**
 * How long until a scheduled fire — "in 4m", "in 7h", "in 3d". A countdown rather than a wall-clock
 * stamp because the column is read by comparing rows against each other; the exact instant is on the
 * cell's tooltip for when it matters. `formatRelativeTime` can't serve this: it clamps the future to
 * zero and would render every pending run as "0s ago".
 */
function formatCountdown(unixSeconds: number, nowMs: number): string {
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
 * The automations are records with identical fields, so they are rendered as rows that can be read
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
  // Read once for the whole table so every row's countdown and last-run age agree on the instant
  // they are relative to, and one tick re-renders them together.
  const now = useNow(CLOCK_TICK_MS);

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
                    now={now}
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
  now,
  producerOn,
  defaultCron,
  onCronChange,
  onToggle,
}: {
  automation: AutomationSpec;
  state: AutomationScheduleState;
  /** Epoch ms from the table's ticking clock — what both time columns are relative to. */
  now: number;
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
          <span title={formatInstant(state.nextRunAt)}>
            {formatCountdown(state.nextRunAt, now)}
          </span>
        ) : (
          <span className="text-subtle">not scheduled</span>
        )}
      </td>

      <td className="px-2.5 py-2 align-middle font-mono text-[11.5px] tabular-nums whitespace-nowrap text-muted-foreground">
        <LastRunCell state={state} now={now} />
      </td>

      <td className="px-2.5 py-2 text-right align-middle">
        <Toggle checked={on} onChange={onToggle} label={automation.label} />
      </td>
    </tr>
  );
}

/**
 * When the automation last fired, and what came of it (anton-znoz).
 *
 * "3h ago" alone reads as healthy whether the pass filed three beads, found nothing, or parked on a
 * bd failure — so the time is the headline and the outcome is the line under it, in the row's own
 * words ("closed 2 gate(s)", "no gate closed") rather than a status vocabulary an operator has to
 * learn. A fire that predates the outcome column, or whose handler reports no effect, says "ok" and
 * claims nothing more.
 *
 * The two halves come from different places and can describe different fires: `lastRunAt` is
 * stamped when the scheduler ENQUEUES (jobs/scheduler.ts), `lastRun` is the newest job that has
 * SETTLED (lib/schedule-runs.ts). While a fire is running — minutes, for the long passes — the
 * outcome beside it is the PREVIOUS fire's, so pinning it to a two-minute-old timestamp reads as
 * "it just succeeded" (or just failed). An outcome is only the newest fire's when it settled at or
 * after that fire was enqueued; otherwise the fire is still in flight and says so, and the older
 * result is dated to its own run.
 */
function LastRunCell({ state, now }: { state: AutomationScheduleState; now: number }) {
  if (!state.lastRunAt) return <span className="text-subtle">never</span>;

  const previous = state.lastRun;
  const settled = previous !== undefined && previous.at >= state.lastRunAt;
  const style = settled ? OUTCOME_STYLES[previous.outcome] : undefined;

  const detail = settled
    ? (previous.note ?? style?.label)
    : previous
      ? `in progress · ${OUTCOME_STYLES[previous.outcome].label} ${formatRelativeTime(
          new Date(previous.at * 1000).toISOString(),
          now,
        )}`
      : undefined;
  // The failure note is an error message and can outrun the column; the tooltip keeps it, including
  // for the older fire whose note the in-flight line has no room to spell out.
  const title = settled ? detail : previous?.note ? `${detail} — ${previous.note}` : detail;

  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5">
        {style || previous ? (
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              style?.dot ?? IN_FLIGHT_STYLE.dot,
            )}
            aria-hidden="true"
          />
        ) : null}
        <span title={formatInstant(state.lastRunAt)}>
          {formatRelativeTime(new Date(state.lastRunAt * 1000).toISOString(), now)}
        </span>
      </span>
      {detail ? (
        <span
          className={cn(
            "max-w-[15rem] truncate text-[10.5px]",
            style?.text ?? (previous ? IN_FLIGHT_STYLE.text : "text-subtle"),
          )}
          title={title}
        >
          {/* Screen readers get the outcome named, not just the note that happens to imply it. */}
          <span className="sr-only">{style ? `${style.label} — ` : ""}</span>
          {detail}
        </span>
      ) : null}
    </span>
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
