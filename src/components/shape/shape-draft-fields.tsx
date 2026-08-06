"use client";

import { cn } from "@/lib/utils";

import type { ShapeDraft } from "./use-shape-draft";

/**
 * The four fields that ARE the epic contract (anton-8mnr) — outcome, Success Criteria, one `area:`.
 * The bead is rendered from the project's bead formula, so what lands is contract-shaped by
 * construction; these exist to make filling them the path of least resistance.
 */
export function DraftFields({ draft, areas }: { draft: ShapeDraft; areas: string[] }) {
  const { fields, setField, areaValid } = draft;
  return (
    <>
      <DraftInput
        label="Title"
        value={fields.title}
        onChange={(v) => setField("title", v)}
        placeholder="Epic title"
      />
      <DraftTextarea
        label="Outcome"
        value={fields.goal}
        onChange={(v) => setField("goal", v)}
        placeholder="One or two sentences a stakeholder would recognise — the result, and why."
      />
      <DraftTextarea
        label="Success criteria"
        value={fields.successCriteria}
        onChange={(v) => setField("successCriteria", v)}
        placeholder={"- [ ] the observable state that means this outcome is reached"}
        hint="What several features add up to — not one PR's checklist."
      />
      <DraftInput
        label="Area"
        value={fields.area}
        onChange={(v) => setField("area", v)}
        placeholder="reports"
        list="shape-areas"
        invalid={!areaValid}
        hint={
          areaValid
            ? "The product surface the roadmap groups this outcome under."
            : "Letters, digits, . _ - only — it becomes the label area:<value>."
        }
      />
      {/* `area:` values already on the board — suggested so surfaces get reused, not re-minted. */}
      <datalist id="shape-areas">
        {areas.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
      <p className="text-xs leading-relaxed text-subtle">
        These four are the epic&apos;s contract — anton fills the bead from your project&apos;s
        formula, so it lands shaped rather than flagged. Features are decomposed after it reaches
        backlog.
      </p>
    </>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[10px] tracking-[0.05em] text-subtle uppercase">{children}</span>
  );
}

function FieldHint({ children, invalid }: { children: React.ReactNode; invalid?: boolean }) {
  return (
    <span className={cn("text-[11px] leading-snug", invalid ? "text-destructive" : "text-subtle")}>
      {children}
    </span>
  );
}

function DraftInput({
  label,
  value,
  onChange,
  placeholder,
  hint,
  invalid,
  list,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  invalid?: boolean;
  list?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        list={list}
        aria-invalid={invalid || undefined}
        className={cn(
          "rounded-md border bg-background px-2.5 py-1.5 text-[13px] font-medium leading-snug",
          "placeholder:font-normal placeholder:text-subtle focus:outline-none",
          invalid ? "border-destructive focus:border-destructive" : "border-border focus:border-primary/50",
        )}
      />
      {hint && <FieldHint invalid={invalid}>{hint}</FieldHint>}
    </label>
  );
}

function DraftTextarea({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={4}
        className={cn(
          "resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px] leading-relaxed text-muted-foreground",
          "placeholder:text-subtle focus:border-primary/50 focus:outline-none",
        )}
      />
      {hint && <FieldHint>{hint}</FieldHint>}
    </label>
  );
}
