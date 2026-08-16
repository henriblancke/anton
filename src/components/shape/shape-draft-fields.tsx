"use client";

import type { EpicChoice } from "@/lib/backlog";
import { cn } from "@/lib/utils";

import { NEW_EPIC } from "./shape-draft";
import type { ShapeDraft } from "./use-shape-draft";

/**
 * The draft's two halves: the epic this work hangs off — picked from the board or created here —
 * and the `feature` contract that actually lands (anton-h1ds). A feature is one worktree, one PR,
 * so its five sections are what the run and its self-review read; the bead is rendered from the
 * project's bead formula, so what lands is contract-shaped by construction. These fields exist to
 * make filling them the path of least resistance.
 */
export function DraftFields({
  draft,
  areas,
  epics,
}: {
  draft: ShapeDraft;
  areas: string[];
  epics: EpicChoice[];
}) {
  const { fields, setFeatureField } = draft;
  return (
    <>
      <EpicSection draft={draft} areas={areas} epics={epics} />

      <FieldGroup title="Feature" hint="One worktree, one PR — the unit anton runs.">
        <DraftInput
          label="Title"
          value={fields.feature.title}
          onChange={(v) => setFeatureField("title", v)}
          placeholder="Feature title"
        />
        <DraftTextarea
          label="Goal"
          value={fields.feature.goal}
          onChange={(v) => setFeatureField("goal", v)}
          placeholder="One sentence: what this delivers, and why it matters."
        />
        <DraftTextarea
          label="Acceptance criteria"
          value={fields.feature.acceptance}
          onChange={(v) => setFeatureField("acceptance", v)}
          placeholder={"- [ ] a concrete, checkable statement of done"}
          hint="The run's definition of done — self-review scores the diff against it."
        />
        <DraftTextarea
          label="Context"
          value={fields.feature.context}
          onChange={(v) => setFeatureField("context", v)}
          placeholder="touches: <files/areas>; follow the pattern in <file>"
          hint="So the agent doesn't rediscover what you already know."
        />
        <DraftTextarea
          label="Out of scope"
          value={fields.feature.outOfScope}
          onChange={(v) => setFeatureField("outOfScope", v)}
          placeholder={"- what this deliberately does not change"}
        />
        <DraftTextarea
          label="Verify"
          value={fields.feature.verify}
          onChange={(v) => setFeatureField("verify", v)}
          placeholder="the tests that prove this landed, and which to add"
        />
      </FieldGroup>

      <p className="text-xs leading-relaxed text-subtle">
        These sections are the feature&apos;s contract — anton fills the bead from your
        project&apos;s formula, so it lands shaped rather than flagged. Tickets are decomposed under
        it after it reaches backlog.
      </p>
    </>
  );
}

/** The epic half: pick the outcome this feature advances, or state a new one. */
function EpicSection({
  draft,
  areas,
  epics,
}: {
  draft: ShapeDraft;
  areas: string[];
  epics: EpicChoice[];
}) {
  const { fields, setEpicField, setEpicId, creatingEpic, areaValid } = draft;
  const chosen = epics.find((e) => e.id === fields.epicId);
  return (
    <FieldGroup title="Epic" hint="The product outcome this feature advances.">
      <label className="flex flex-col gap-1.5">
        <FieldLabel>Epic</FieldLabel>
        <select
          value={fields.epicId}
          onChange={(e) => setEpicId(e.target.value)}
          className={cn(
            "rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] font-medium leading-snug",
            "focus:border-primary/50 focus:outline-none",
            fields.epicId ? "text-foreground" : "text-subtle",
          )}
        >
          <option value="">Choose the epic this belongs to…</option>
          {epics.map((epic) => (
            <option key={epic.id} value={epic.id}>
              {epic.area ? `${epic.title} · ${epic.area}` : epic.title}
            </option>
          ))}
          <option value={NEW_EPIC}>+ New epic…</option>
        </select>
        <FieldHint>
          A feature with no epic runs fine and appears on no roadmap — so anton asks first.
        </FieldHint>
      </label>

      {/* A ticket under a container epic never runs: the moment this feature lands, the epic's own
          tickets stop being claimable. Worth saying before the write, not after. */}
      {chosen && chosen.looseTickets > 0 && (
        <p className="text-[11px] leading-snug text-amber-600 dark:text-amber-400">
          {chosen.looseTickets === 1 ? "1 ticket hangs" : `${chosen.looseTickets} tickets hang`}{" "}
          directly off this epic. Landing a feature here makes it a container, and those tickets stop
          being runnable — re-home them under a feature from the board.
        </p>
      )}

      {creatingEpic && (
        <>
          <DraftInput
            label="Epic title"
            value={fields.epic.title}
            onChange={(v) => setEpicField("title", v)}
            placeholder="Reports are shareable outside the app"
          />
          <DraftTextarea
            label="Epic outcome"
            value={fields.epic.goal}
            onChange={(v) => setEpicField("goal", v)}
            placeholder="One or two sentences a stakeholder would recognise — the result, and why."
          />
          <DraftTextarea
            label="Epic success criteria"
            value={fields.epic.successCriteria}
            onChange={(v) => setEpicField("successCriteria", v)}
            placeholder={"- [ ] the observable state that means this outcome is reached"}
            hint="What several features add up to — not this PR's checklist."
          />
          <DraftInput
            label="Area"
            value={fields.epic.area}
            onChange={(v) => setEpicField("area", v)}
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
        </>
      )}
    </FieldGroup>
  );
}

/** One titled half of the panel — the two tiers read as two things, not one ten-field form. */
function FieldGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-[12px] font-semibold text-foreground">{title}</span>
        <span className="text-[11px] leading-snug text-subtle">{hint}</span>
      </div>
      {children}
    </section>
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
        rows={3}
        className={cn(
          "resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px] leading-relaxed text-muted-foreground",
          "placeholder:text-subtle focus:border-primary/50 focus:outline-none",
        )}
      />
      {hint && <FieldHint>{hint}</FieldHint>}
    </label>
  );
}
