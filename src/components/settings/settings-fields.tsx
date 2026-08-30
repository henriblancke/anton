"use client";

import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { MODELS } from "@/components/settings/settings-constants";
import { reviewerMissing } from "@/components/settings/settings-draft";
import type { DiscoveredAgent } from "@/components/settings/settings-types";

/** A read-only project fact — shown as a field so it sits in the same grid as the editable ones. */
export function Field({
  label,
  value,
  mono = false,
  className,
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-[11px] text-subtle">{label}</span>
      <div
        className={cn(
          "flex items-center rounded-lg border border-border bg-card px-3 py-2 text-[12.5px]",
          mono && "font-mono",
        )}
      >
        <span className="truncate" title={value}>
          {value}
        </span>
      </div>
    </div>
  );
}

/** Editable verify-gate command (anton-3oh8). Persists to settingsJson.*Command; "" clears it. */
export function GateField({
  label,
  value,
  onChange,
  placeholder,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-[11px] text-subtle">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={1000}
        aria-label={label}
        className="rounded-lg border border-border bg-card px-3 py-2 font-mono text-[12.5px] text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
      />
    </label>
  );
}

/** A min–100 integer percentage knob for the budget policy (anton-egrg). Clamps on change. */
export function PctField({
  label,
  value,
  onChange,
  hint,
  disabled = false,
  min = 0,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  hint?: string;
  disabled?: boolean;
  min?: number;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] text-subtle">{label}</span>
      <div className="relative flex items-center rounded-[10px] border border-border bg-card focus-within:border-primary/60">
        <input
          type="number"
          step={1}
          min={min}
          max={100}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const n = Number(e.target.value);
            onChange(Number.isFinite(n) ? Math.min(100, Math.max(min, Math.round(n))) : min);
          }}
          aria-label={label}
          className="w-full rounded-[10px] bg-transparent px-3 py-2 pr-8 font-mono text-[12.5px] text-foreground outline-none disabled:cursor-not-allowed"
        />
        <span className="pointer-events-none absolute right-3 text-[11px] text-subtle">%</span>
      </div>
      {hint && <span className="text-[11px] text-subtle">{hint}</span>}
    </label>
  );
}

/**
 * A clamped integer knob for the self-review section — max rounds, and the two score-alarm
 * thresholds (anton-i98r). Clamps on change like {@link PctField}, so a typed-in 99 lands on the
 * bound the API would have rejected instead of round-tripping as a 400.
 */
export function CountField({
  label,
  value,
  onChange,
  min,
  max,
  fallback,
  hint,
  disabled = false,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  /** Where a cleared or unparseable input lands — the shipped default for this knob. */
  fallback: number;
  hint: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] text-subtle">{label}</span>
      <input
        type="number"
        step={1}
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(
            Number.isFinite(n) && e.target.value !== ""
              ? Math.min(max, Math.max(min, Math.round(n)))
              : fallback,
          );
        }}
        aria-label={label}
        className="rounded-[10px] border border-border bg-card px-3 py-2 font-mono text-[12.5px] text-foreground outline-none focus:border-primary/60 disabled:cursor-not-allowed"
      />
      <span className="text-[11px] text-subtle">{hint}</span>
    </label>
  );
}

/**
 * Reviewer selector for the self-review gate (anton-3apm). Persists to settingsJson.reviewAgent;
 * "" runs the shipped review contract. Any discoverable agent may review — bundled or the
 * operator's own — since the reviewer is deliberately swappable, not gated by the active-agents
 * allowlist. A persisted id that no longer resolves is kept as an option so the operator can see
 * what's stored (and that it's gone) instead of the field silently reading as "Default" — the save
 * omits it rather than resubmitting an id the API rejects (see {@link reviewerMissing}).
 */
export function ReviewerField({
  value,
  onChange,
  agents,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  agents: DiscoveredAgent[];
  disabled?: boolean;
}) {
  const missing = reviewerMissing(value, agents);
  const hint = agents.find((a) => a.id === value)?.description;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] text-subtle">Reviewer</span>
      <div className="relative flex items-center rounded-[10px] border border-border bg-card text-[12.5px] focus-within:border-primary/60">
        <select
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Reviewer"
          className="w-full appearance-none rounded-[10px] bg-transparent px-3 py-2 pr-8 font-mono text-foreground outline-none disabled:cursor-not-allowed"
        >
          <option value="">Default · anton&apos;s review contract</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.id} · {a.source}
            </option>
          ))}
          {missing && <option value={value}>{value} · missing</option>}
        </select>
        <span className="pointer-events-none absolute right-3 text-subtle">▾</span>
      </div>
      <span className="line-clamp-2 text-[11px] text-subtle" title={missing ? undefined : hint}>
        {missing
          ? "This agent no longer exists — review falls back to the shipped contract. Pick another to replace it."
          : (hint ?? "any agent this project can assign · runs in a fresh context")}
      </span>
    </div>
  );
}

/** Default-model selector. Persists to settingsJson.model; "" runs claude with no --model. */
export function ModelField({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const hint = MODELS.find((m) => m.value === value)?.hint;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-[11px] text-subtle">Default model</span>
      <div className="relative flex items-center rounded-lg border border-border bg-card text-[12.5px] focus-within:border-primary/60">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Default model"
          className="w-full appearance-none rounded-lg bg-transparent px-3 py-2 pr-8 font-mono text-foreground outline-none"
        >
          {MODELS.map((m) => (
            <option key={m.value || "default"} value={m.value}>
              {m.label}
              {m.value ? ` · ${m.value}` : ""}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-3 text-subtle">▾</span>
      </div>
      {hint && <span className="text-[11px] text-subtle">{hint}</span>}
    </div>
  );
}

/**
 * A titled panel heading — every section opens with one, so the h2 and its one-line "what this is"
 * never drift apart across twelve panels.
 */
export function SectionHeading({
  title,
  hint,
  children,
  tone,
}: {
  title: string;
  hint?: string;
  /** Status that belongs beside the title rather than in the body (the beads pill). */
  children?: React.ReactNode;
  tone?: "danger";
}) {
  return (
    <div className={cn("flex gap-2.5", hint ? "items-baseline" : "items-center")}>
      <h2 className={cn("text-[15px] font-semibold", tone === "danger" && "text-risk-high")}>
        {title}
      </h2>
      {hint && <span className="text-xs text-subtle">{hint}</span>}
      {children}
    </div>
  );
}

/** An editable long-form prompt with its "unsaved" marker, character count and footnote. */
export function PromptField({
  label,
  hint,
  value,
  onChange,
  saved,
  placeholder,
  footnote,
  rows = 6,
  disabled = false,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  /** The persisted text, so the field can mark itself unsaved without knowing the diff rules. */
  saved: string;
  placeholder: string;
  footnote: React.ReactNode;
  rows?: number;
  disabled?: boolean;
}) {
  return (
    <div className="flex max-w-2xl flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] font-medium">{label}</span>
        <span className="text-[11px] text-subtle">{hint}</span>
        {value.trim() !== saved.trim() && (
          <span className="font-mono text-[10px] text-primary">unsaved</span>
        )}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        maxLength={8000}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={label}
        className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground outline-none placeholder:text-subtle focus:border-primary/60 disabled:cursor-not-allowed"
      />
      <span className="text-[11px] text-subtle">
        {footnote} {value.length}/8000
      </span>
    </div>
  );
}

/** beads connection shown as a status pill, not an editable field. */
export function BeadsStatus({ connected }: { connected: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]",
        connected
          ? "border-stage-done/30 bg-stage-done/10 text-stage-done"
          : "border-risk-high/30 bg-risk-high/10 text-risk-high",
      )}
    >
      <span
        className={cn("size-1.5 rounded-full", connected ? "bg-stage-done" : "bg-risk-high")}
        aria-hidden="true"
      />
      beads {connected ? "connected" : "missing"}
    </span>
  );
}

/** An ordered list row's move-up / move-down / remove controls — variants and value labels share them. */
export function RowControls({
  onMoveUp,
  onMoveDown,
  onRemove,
  atTop,
  atBottom,
  labels,
}: {
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  atTop: boolean;
  atBottom: boolean;
  /** aria-labels, which name the row's kind and position ("Move variant 2 up"). */
  labels: { up: string; down: string; remove: string };
}) {
  return (
    <>
      <Button
        size="icon-xs"
        variant="ghost"
        onClick={onMoveUp}
        disabled={atTop}
        aria-label={labels.up}
      >
        <ChevronUpIcon aria-hidden="true" />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        onClick={onMoveDown}
        disabled={atBottom}
        aria-label={labels.down}
      >
        <ChevronDownIcon aria-hidden="true" />
      </Button>
      <Button size="icon-xs" variant="ghost" onClick={onRemove} aria-label={labels.remove}>
        <XIcon aria-hidden="true" />
      </Button>
    </>
  );
}
