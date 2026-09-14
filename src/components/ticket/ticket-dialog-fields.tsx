"use client";

import { cn } from "@/lib/utils";

/** The dialog's one-line text field (Title) — the only edit that isn't a select or a textarea. */
export function TitleField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] text-subtle">Title</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Title"
        className="rounded-lg border border-border bg-card px-3 py-2 text-[14px] font-medium text-foreground outline-none focus:border-primary/60"
      />
    </label>
  );
}

/** A labelled native select — the Details grid's only control shape. */
export function Select({
  label,
  value,
  onChange,
  disabled = false,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] text-subtle">{label}</span>
      <div
        className={cn(
          "relative flex items-center rounded-lg border border-border bg-card text-[12.5px] focus-within:border-primary/60",
          disabled && "opacity-60",
        )}
      >
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-label={label}
          className="w-full appearance-none rounded-lg bg-transparent px-3 py-2 pr-8 font-mono text-foreground outline-none disabled:cursor-not-allowed"
        >
          {children}
        </select>
        <span className="pointer-events-none absolute right-3 text-subtle">▾</span>
      </div>
    </label>
  );
}

/** One markdown section of the contract (Goal / Acceptance / the rest), edited as raw text. */
export function ContractField({
  label,
  hint,
  value,
  onChange,
  rows,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline gap-2">
        <span className="text-[11px] text-subtle">{label}</span>
        {hint && <span className="text-[10px] text-subtle/70">{hint}</span>}
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        aria-label={label}
        className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
      />
    </label>
  );
}
