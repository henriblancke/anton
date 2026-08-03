"use client";

import { useState } from "react";

import {
  CADENCE_PRESETS,
  FAST_CADENCE_MINUTES,
  cronForPreset,
  describeCron,
  isFastCadence,
  presetById,
  presetForCron,
  type CadenceParts,
  type CadencePreset,
  type CadenceSelection,
} from "@/lib/jobs/cadence";
import { nextRun } from "@/lib/jobs/cron";
import { formatExactTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Toggle } from "@/components/atoms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** One automation's live schedule state. `enabled: null` = this project has no row for it yet. */
export interface AutomationScheduleState {
  enabled: boolean | null;
  /** The cron that fires today, or the default cadence when no row exists yet. */
  cron: string;
  /** Epoch SECONDS, as stored. Absent while the automation is off or unscheduled. */
  nextRunAt?: number;
}

/** Menu value for the reset action. Never becomes the picker's value — it performs and returns. */
const RESET = "__reset__";

/**
 * Which inputs a preset's menu label should use. Fields the operator already set are carried over,
 * so "Daily at 06:30" → the weekly item reads "Weekly on Monday at 06:30" rather than resetting the
 * time behind their back; fields the stored expression never named keep the preset's default.
 */
function partsFor(preset: CadencePreset, selection: CadenceSelection): CadenceParts {
  const carried = presetById(selection.presetId)?.fields ?? [];
  const parts = { ...preset.defaults };
  for (const field of preset.fields) {
    if (carried.includes(field)) parts[field] = selection.parts[field];
  }
  // Minute 0 belongs to the plain "Hourly" item; keep this one mid-hour so the two never read alike.
  if (preset.id === "hourly-at" && parts.minute === 0) parts.minute = preset.defaults.minute;
  return parts;
}

/** What the operator sees under a raw expression: when it next fires, or why it won't parse. */
function previewCron(expr: string): { error: string } | { nextAt: number } {
  const trimmed = expr.trim();
  if (!trimmed) return { error: "Enter a 5-field cron expression" };
  try {
    return { nextAt: nextRun(trimmed, Date.now()) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : `Invalid cron: "${trimmed}"` };
  }
}

/** Local wall-clock rendering of an instant in ms — the section states once that times are local. */
function formatInstant(ms: number): string {
  return formatExactTime(new Date(ms).toISOString()) ?? "unknown";
}

/**
 * One Settings → Automation row: what the automation does, the cadence it runs on, when it next
 * fires, and its on/off switch (anton-bfwq).
 *
 * The cadence is read from the schedule row, never from copy in this file — the picker opens on
 * whichever preset the stored cron spells out, and falls to "Custom cron…" for a hand-written
 * expression. A preset persists the moment it's chosen; a custom expression persists only once it
 * parses, so an unparseable cadence can never reach the server.
 */
export function AutomationRow({
  label,
  description,
  state,
  defaultCron,
  onCronChange,
  onToggle,
}: {
  label: string;
  /** What the automation does. Never its cadence — that is read from the schedule row. */
  description: string;
  state: AutomationScheduleState;
  /** This type's DEFAULT_SCHEDULES cron, passed from the server — what "Reset to default" restores. */
  defaultCron: string;
  onCronChange: (cron: string) => void;
  onToggle: (next: boolean) => void;
}) {
  const selection = presetForCron(state.cron);
  const storedIsCustom = selection.presetId === "custom";
  // Non-null while a raw expression is being edited; committing clears it so the row goes back to
  // rendering whatever the server stored.
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null || storedIsCustom;
  const expr = draft ?? state.cron;
  const preview = editing ? previewCron(expr) : null;
  const error = preview && "error" in preview ? preview.error : null;

  const on = state.enabled === true;
  const nextRunText =
    on && state.nextRunAt ? `next ${formatInstant(state.nextRunAt * 1000)}` : "not scheduled";
  // Warn on what would actually be stored: the draft while it parses, the live cadence otherwise.
  const fast = isFastCadence(editing && !error ? expr.trim() : state.cron);

  function choose(value: string | null) {
    if (value === RESET) {
      setDraft(null);
      if (defaultCron !== state.cron) onCronChange(defaultCron);
      return;
    }
    if (value === "custom") {
      setDraft(state.cron);
      return;
    }
    const preset = CADENCE_PRESETS.find((p) => p.id === value);
    if (!preset) return;
    setDraft(null);
    const cron = cronForPreset(preset.id, partsFor(preset, selection));
    if (cron !== state.cron) onCronChange(cron);
  }

  function saveCustom() {
    const trimmed = expr.trim();
    if (error || trimmed === state.cron) return;
    setDraft(null);
    onCronChange(trimmed);
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-[10px] border border-border bg-card px-3 py-2.5",
        !on && "opacity-70",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={cn("size-1.5 shrink-0 rounded-full", on ? "bg-stage-done" : "bg-stage-backlog")}
          aria-hidden="true"
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[12.5px]">{label}</span>
          <span className="font-mono text-[10.5px] text-subtle">
            {description} · {nextRunText}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2.5">
          <Select
            value={draft !== null ? "custom" : selection.presetId}
            onValueChange={(value) => choose(value)}
          >
            <SelectTrigger
              aria-label={`${label} cadence`}
              // The phrase is on the trigger; the tooltip gives the exact expression behind it.
              title={state.cron}
              className="w-48"
            >
              <SelectValue>
                {() => (draft !== null ? "Custom cron…" : describeCron(state.cron))}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {CADENCE_PRESETS.filter((p) => p.id !== "custom").map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {describeCron(cronForPreset(preset.id, partsFor(preset, selection)))}
                </SelectItem>
              ))}
              <SelectSeparator />
              <SelectItem value="custom">Custom cron…</SelectItem>
              <SelectItem value={RESET} disabled={state.cron === defaultCron}>
                Reset to default
              </SelectItem>
            </SelectContent>
          </Select>
          <Toggle checked={on} onChange={onToggle} label={label} />
        </div>
      </div>

      {editing && (
        <div className="flex flex-col gap-1.5 pl-4">
          <div className="flex items-center gap-2">
            <Input
              value={expr}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={`${label} cron expression`}
              // The primitive renders the invalid border/ring off aria-invalid.
              aria-invalid={error ? true : undefined}
              spellCheck={false}
              placeholder="*/15 * * * *"
              className="w-44 font-mono text-[12px]"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={saveCustom}
              disabled={!!error || expr.trim() === state.cron}
            >
              Save cadence
            </Button>
          </div>
          <span className={cn("text-[10.5px]", error ? "text-risk-high" : "text-subtle")}>
            {error ??
              (preview && "nextAt" in preview
                ? `minute hour day-of-month month day-of-week · next ${formatInstant(preview.nextAt)}`
                : null)}
          </span>
        </div>
      )}

      {fast && (
        <span className="pl-4 text-[10.5px] text-risk-med">
          Fires more often than every {FAST_CADENCE_MINUTES} minutes — this will burn budget.
        </span>
      )}
    </div>
  );
}
