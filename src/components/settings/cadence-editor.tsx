"use client";

import { useMemo, useState } from "react";

import {
  FAST_CADENCE_MINUTES,
  WEEKDAY_LABELS,
  cronForPreset,
  describeCron,
  isFastCadence,
  presetForCron,
  type CadenceParts,
  type CadencePresetId,
} from "@/lib/jobs/cadence";
import { nextRun, parseCron } from "@/lib/jobs/cron";
import { formatExactTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * How often, before which fields. Frequency is the first question an operator actually has, and it
 * decides which inputs even exist — so it is asked first, and only its own fields are shown.
 *
 * These are not a second set of presets: each maps onto {@link CADENCE_PRESETS}, which remains the
 * one source of truth for what a cadence means. `hourly` covers both the plain hourly preset and its
 * parameterised sibling, because "on the hour" is just minute 0 to the person choosing it.
 */
type Frequency = "minutes" | "hourly" | "daily" | "weekly" | "custom";

const FREQUENCY_LABELS: Record<Frequency, string> = {
  minutes: "Minutes",
  hourly: "Hourly",
  daily: "Daily",
  weekly: "Weekly",
  custom: "Cron",
};

const FREQUENCIES: Frequency[] = ["minutes", "hourly", "daily", "weekly", "custom"];

/** The step sizes {@link CADENCE_PRESETS} can build. Anything else is a hand-written expression. */
const MINUTE_STEPS = [5, 10, 15, 30] as const;

/** How many fires to show. Three is enough to make a weekly cadence's day unambiguous. */
const PREVIEW_RUNS = 3;

function frequencyOf(presetId: CadencePresetId): Frequency {
  if (presetId.startsWith("every-")) return "minutes";
  if (presetId === "hourly" || presetId === "hourly-at") return "hourly";
  if (presetId === "daily") return "daily";
  if (presetId === "weekly") return "weekly";
  return "custom";
}

function stepOf(presetId: CadencePresetId): number {
  const match = /^every-(\d+)-minutes$/.exec(presetId);
  const step = match ? Number(match[1]) : 15;
  return MINUTE_STEPS.includes(step as (typeof MINUTE_STEPS)[number]) ? step : 15;
}

/**
 * Minute 0 is the plain hourly preset; any other minute is the parameterised one. Keeping that
 * split here means the stored expression is byte-identical to what the preset picker produced.
 */
function cronForHourly(minute: number): string {
  return minute === 0 ? cronForPreset("hourly") : cronForPreset("hourly-at", { minute });
}

/** The expression each frequency stands for — one entry per member, so the set can't drift. */
const CRON_FOR: Record<Frequency, (draft: Draft) => string | null> = {
  minutes: (d) => cronForPreset(`every-${d.step}-minutes` as CadencePresetId),
  hourly: (d) => cronForHourly(d.parts.minute),
  daily: (d) => cronForPreset("daily", d.parts),
  weekly: (d) => cronForPreset("weekly", d.parts),
  custom: (d) => d.expression.trim() || null,
};

/** The expression a draft stands for, or null while a raw one doesn't parse. */
function cronForDraft(draft: Draft): string | null {
  return CRON_FOR[draft.frequency](draft);
}

interface Draft {
  frequency: Frequency;
  step: number;
  parts: CadenceParts;
  /** Only meaningful while `frequency` is `custom` — the operator's own text, kept verbatim. */
  expression: string;
}

function draftFor(cron: string): Draft {
  const selection = presetForCron(cron);
  return {
    frequency: frequencyOf(selection.presetId),
    step: stepOf(selection.presetId),
    parts: selection.parts,
    expression: cron,
  };
}

/**
 * Switching frequency keeps every field the operator already set — "Daily at 06:30" → Weekly reads
 * "Weekly on Monday at 06:30" rather than silently resetting the time. Moving to `custom` seeds the
 * box with the expression the current draft stands for, so it is an escape hatch rather than a
 * blank page.
 */
function withFrequency(draft: Draft, frequency: Frequency): Draft {
  const expression =
    frequency === "custom" ? (cronForDraft(draft) ?? draft.expression) : draft.expression;
  return { ...draft, frequency, expression };
}

/** What the operator will see happen, and why they can't commit it when they can't. */
type Preview = { error: string } | { runs: number[]; perDay?: number };

function previewOf(cron: string | null): Preview {
  if (!cron) return { error: "Enter a 5-field cron expression" };
  try {
    const runs: number[] = [];
    let at = Date.now();
    for (let i = 0; i < PREVIEW_RUNS; i++) {
      at = nextRun(cron, at);
      runs.push(at);
    }
    // Only computed for a cadence we're already warning about, where every hour fires and the
    // per-day count is exactly minutes × hours. A weekly cadence has no meaningful "per day".
    if (!isFastCadence(cron)) return { runs };
    const parsed = parseCron(cron);
    return { runs, perDay: parsed.minute.size * parsed.hour.size };
  } catch (err) {
    return { error: err instanceof Error ? err.message : `Invalid cron: "${cron}"` };
  }
}

/** Local wall-clock rendering of an instant in ms — the section states once that times are local. */
function formatInstant(ms: number): string {
  return formatExactTime(new Date(ms).toISOString()) ?? "unknown";
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The draft, the moves the editor can make on it, and the two answers derived from it: the
 * expression it stands for and what that expression would do. They live together because they are
 * one derivation — the preview is only ever of `next`, and `storable` is only ever the two of them
 * agreeing.
 */
function useCadenceDraft(cron: string) {
  const [draft, setDraft] = useState<Draft>(() => draftFor(cron));
  const next = cronForDraft(draft);
  const preview = useMemo(() => previewOf(next), [next]);

  return {
    draft,
    next,
    preview,
    /** The expression Set cadence would store, or null while there is nothing valid and new. */
    storable: next && next !== cron && !("error" in preview) ? next : null,
    patch: (changes: Partial<Draft>) => setDraft((d) => ({ ...d, ...changes })),
    patchParts: (changes: Partial<CadenceParts>) =>
      setDraft((d) => ({ ...d, parts: { ...d.parts, ...changes } })),
    chooseFrequency: (frequency: Frequency) => setDraft((d) => withFrequency(d, frequency)),
    resetTo: (expr: string) => setDraft(draftFor(expr)),
  };
}

/**
 * The cadence editor (anton-ue90.5) — frequency, then that frequency's fields, then what will
 * actually happen, before anything is committed.
 *
 * It replaces a dropdown of full sentences plus an inline cron input that reflowed every row below
 * it. Two things it deliberately does NOT do: invent scheduling logic (every expression it can build
 * comes from {@link cronForPreset}, so a cadence chosen here round-trips through
 * {@link presetForCron} unchanged), and refuse a fast cadence — the warning names the cost in runs
 * per day and lets the operator decide, exactly as the old row did.
 *
 * The raw expression is always reachable, and a stored cron outside the preset set opens straight on
 * it with its text intact.
 */
export function CadenceEditor({
  label,
  cron,
  defaultCron,
  onCommit,
  onClose,
}: {
  /** The automation being edited — the popover has to say what it is editing. */
  label: string;
  /** The cadence as stored today. */
  cron: string;
  /** This type's DEFAULT_SCHEDULES cron — what "Reset to default" restores. */
  defaultCron: string;
  onCommit: (cron: string) => void;
  onClose: () => void;
}) {
  const { draft, next, preview, storable, patch, patchParts, chooseFrequency, resetTo } =
    useCadenceDraft(cron);

  function commit() {
    if (!storable) return;
    onCommit(storable);
    onClose();
  }

  return (
    <div className="flex w-[22rem] flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[12.5px] font-medium text-foreground">Cadence</h3>
        <span className="truncate font-mono text-[11px] text-subtle">{label}</span>
      </div>

      <FrequencyPicker value={draft.frequency} onChange={chooseFrequency} />

      <FrequencyFields
        draft={draft}
        label={label}
        invalid={"error" in preview}
        onPatch={patch}
        onPatchParts={patchParts}
      />

      <RunPreview preview={preview} />

      <EditorFooter
        next={next}
        atDefault={cron === defaultCron && next === defaultCron}
        storable={storable !== null}
        onReset={() => resetTo(defaultCron)}
        onCommit={commit}
      />
    </div>
  );
}

function FrequencyPicker({
  value,
  onChange,
}: {
  value: Frequency;
  onChange: (frequency: Frequency) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Frequency"
      className="flex overflow-hidden rounded-lg border border-border"
    >
      {FREQUENCIES.map((frequency) => (
        <button
          key={frequency}
          type="button"
          aria-pressed={value === frequency}
          onClick={() => onChange(frequency)}
          className={cn(
            "flex-1 border-r border-border px-2 py-1.5 text-[11.5px] text-muted-foreground transition-colors last:border-r-0 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            value === frequency && "bg-secondary font-medium text-foreground",
          )}
        >
          {FREQUENCY_LABELS[frequency]}
        </button>
      ))}
    </div>
  );
}

interface FieldsProps {
  draft: Draft;
  /** The automation's name — the raw-expression box has to say which cadence it belongs to. */
  label: string;
  invalid: boolean;
  onPatch: (changes: Partial<Draft>) => void;
  onPatchParts: (changes: Partial<CadenceParts>) => void;
}

/** The inputs each frequency owns — one entry per member, alongside {@link CRON_FOR}. */
const FIELDS_FOR: Record<Frequency, (props: FieldsProps) => React.ReactNode> = {
  minutes: ({ draft, onPatch }) => (
    <StepField value={draft.step} onChange={(step) => onPatch({ step })} />
  ),
  hourly: ({ draft, onPatchParts }) => (
    <HourlyMinuteField value={draft.parts.minute} onChange={(minute) => onPatchParts({ minute })} />
  ),
  daily: ({ draft, onPatchParts }) => (
    <TimeOfDayFields weekly={false} parts={draft.parts} onChange={onPatchParts} />
  ),
  weekly: ({ draft, onPatchParts }) => (
    <TimeOfDayFields weekly parts={draft.parts} onChange={onPatchParts} />
  ),
  custom: ({ draft, label, invalid, onPatch }) => (
    <CronField
      label={label}
      value={draft.expression}
      invalid={invalid}
      onChange={(expression) => onPatch({ expression })}
    />
  ),
};

/** Only the chosen frequency's own inputs exist — the others are not disabled, they are absent. */
function FrequencyFields(props: FieldsProps) {
  return FIELDS_FOR[props.draft.frequency](props);
}

function StepField({ value, onChange }: { value: number; onChange: (step: number) => void }) {
  return (
    <FieldRow lead="every">
      <NumberSelect
        label="Minutes between runs"
        value={value}
        options={[...MINUTE_STEPS]}
        format={(v) => String(v)}
        onChange={onChange}
      />
      <span className="text-[12px] text-muted-foreground">minutes</span>
    </FieldRow>
  );
}

function HourlyMinuteField({
  value,
  onChange,
}: {
  value: number;
  onChange: (minute: number) => void;
}) {
  return (
    <FieldRow lead="at">
      <span className="text-[12px] text-muted-foreground">:</span>
      <NumberSelect label="Minute" value={value} options={MINUTES} format={pad} onChange={onChange} />
      <span className="text-[12px] text-muted-foreground">past every hour</span>
    </FieldRow>
  );
}

/** Daily and weekly are the same row of clock fields; weekly just names a day in front of them. */
function TimeOfDayFields({
  weekly,
  parts,
  onChange,
}: {
  weekly: boolean;
  parts: CadenceParts;
  onChange: (changes: Partial<CadenceParts>) => void;
}) {
  return (
    <FieldRow lead={weekly ? "on" : "at"}>
      {weekly && (
        <>
          <NumberSelect
            label="Day of week"
            value={parts.weekday}
            options={WEEKDAY_LABELS.map((_, i) => i)}
            format={(v) => WEEKDAY_LABELS[v]}
            onChange={(weekday) => onChange({ weekday })}
            className="w-28"
          />
          <span className="text-[12px] text-muted-foreground">at</span>
        </>
      )}
      <NumberSelect
        label="Hour"
        value={parts.hour}
        options={HOURS}
        format={pad}
        onChange={(hour) => onChange({ hour })}
      />
      <span className="text-[12px] text-muted-foreground">:</span>
      <NumberSelect
        label="Minute"
        value={parts.minute}
        options={MINUTES}
        format={pad}
        onChange={(minute) => onChange({ minute })}
      />
      <span className="text-[11px] text-subtle">local</span>
    </FieldRow>
  );
}

function CronField({
  label,
  value,
  invalid,
  onChange,
}: {
  label: string;
  value: string;
  invalid: boolean;
  onChange: (expression: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`${label} cron expression`}
        // The primitive renders the invalid border/ring off aria-invalid.
        aria-invalid={invalid ? true : undefined}
        spellCheck={false}
        placeholder="*/15 * * * *"
        className="font-mono text-[12px]"
      />
      <span className="font-mono text-[10.5px] text-subtle">
        minute hour day-of-month month day-of-week
      </span>
    </div>
  );
}

/** What will actually happen. A cadence is only obviously wrong once you can see it fire. */
function RunPreview({ preview }: { preview: Preview }) {
  return (
    <>
      <div className="flex flex-col gap-1 rounded-[10px] border border-border bg-secondary/50 px-3 py-2">
        {"error" in preview ? (
          <span className="text-[11.5px] text-risk-high">{preview.error}</span>
        ) : (
          <>
            <span className="font-mono text-[10px] tracking-[0.1em] text-subtle uppercase">
              Next {PREVIEW_RUNS} runs
            </span>
            {preview.runs.map((at) => (
              <span key={at} className="font-mono text-[11.5px] tabular-nums text-foreground">
                {formatInstant(at)}
              </span>
            ))}
          </>
        )}
      </div>

      {/* Stated as its consequence, not as the threshold constant: "288 runs a day" is a number an
          operator can weigh, and every one of them spends tokens whether or not anything moved. */}
      {"perDay" in preview && preview.perDay !== undefined && (
        <p className="text-[11px] text-risk-med">
          {preview.perDay} runs a day — more often than every {FAST_CADENCE_MINUTES} minutes. Each
          one spends budget whether or not there is anything to do.
        </p>
      )}
    </>
  );
}

function EditorFooter({
  next,
  atDefault,
  storable,
  onReset,
  onCommit,
}: {
  /** The expression the draft stands for, staged and not yet stored. */
  next: string | null;
  /** Whether the stored cadence and the draft are both already the automation's default. */
  atDefault: boolean;
  storable: boolean;
  onReset: () => void;
  onCommit: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-t border-border pt-2.5">
      <span
        className="truncate font-mono text-[10.5px] text-subtle"
        title={next ? describeCron(next) : undefined}
      >
        {next ?? "—"}
      </span>
      <span className="flex-1" />
      <Button size="sm" variant="ghost" onClick={onReset} disabled={atDefault}>
        Reset
      </Button>
      <Button size="sm" onClick={onCommit} disabled={!storable}>
        Set cadence
      </Button>
    </div>
  );
}

function FieldRow({ lead, children }: { lead: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[12px] text-muted-foreground">{lead}</span>
      {children}
    </div>
  );
}

/** A compact numeric picker — the only input shape the builder needs, in four places. */
function NumberSelect({
  label,
  value,
  options,
  format,
  onChange,
  className,
}: {
  label: string;
  value: number;
  options: number[];
  format: (value: number) => string;
  onChange: (value: number) => void;
  className?: string;
}) {
  // A stored expression can name a value the menu doesn't offer (minutes are listed in fives, and
  // `13 * * * *` is a perfectly good cadence). Fold it in rather than dropping it: without this the
  // operator could read their own setting but never return to it after touching the picker.
  const items = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger aria-label={label} className={cn("h-8 w-[4.5rem]", className)}>
        <SelectValue>{() => format(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {items.map((option) => (
          <SelectItem key={option} value={String(option)}>
            {format(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
