"use client";

import { cn } from "@/lib/utils";
import { Toggle } from "@/components/atoms";
import { PctField, SectionHeading } from "@/components/settings/settings-fields";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/** Concurrency, timeouts, retries and the budget policy — how much runs at once, and for how long. */
export function ExecutionSection({ form }: { form: SettingsForm }) {
  const { draft, set } = form;
  return (
    <div className="grid max-w-3xl grid-cols-1 gap-7">
      <section className="flex flex-col gap-3.5">
        <SectionHeading
          title="Concurrency & limits"
          hint="how much runs at once, and when anton gives up on one"
        />
        <div className="flex flex-col gap-2">
          <div className="flex justify-between">
            <span className="text-[12.5px] text-muted-foreground">Max concurrent runs</span>
            <span className="font-mono text-[12.5px] text-primary">{draft.concurrency}</span>
          </div>
          <input
            type="range"
            min={1}
            max={6}
            value={draft.concurrency}
            onChange={(e) => set("concurrency", Number(e.target.value))}
            aria-label="Max concurrent runs"
            className="accent-primary"
          />
          <span className="text-[11px] text-subtle">1 — 6 · worktrees run in parallel</span>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <MinutesField
            label="Job timeout"
            value={draft.jobTimeoutMinutes}
            onChange={(value) => set("jobTimeoutMinutes", value)}
            min={5}
            max={720}
            hint="without progress · default 120 (2h)"
          />
          <MinutesField
            label="Ticket timeout"
            value={draft.ticketTimeoutMinutes}
            onChange={(value) => set("ticketTimeoutMinutes", value)}
            min={5}
            max={240}
            hint="per ticket · blocks it, run continues · default 45"
          />
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] text-muted-foreground">Retries</span>
            <input
              type="number"
              min={1}
              max={10}
              value={draft.maxRetries}
              onChange={(e) => set("maxRetries", Number(e.target.value))}
              aria-label="Max retries"
              className="rounded-[10px] border border-border bg-card px-3 py-2 font-mono text-[12.5px] text-foreground outline-none focus:border-primary/60"
            />
            <span className="text-[11px] text-subtle">attempts before parking · default 3</span>
          </label>
        </div>

        <ToggleRow
          label="Autonomous execution"
          hint="run approved epics without asking"
          checked={draft.autonomy}
          onChange={(next) => set("autonomy", next)}
        />
        <ToggleRow
          label="Conventional-commit PR titles"
          hint="prefix epic PR titles with feat/fix(scope)"
          checked={draft.conventionalCommits}
          onChange={(next) => set("conventionalCommits", next)}
        />

        <BudgetPolicy form={form} />
      </section>
    </div>
  );
}

/** Budget-aware execution (anton-7mpv.1) and the two policy knobs it gates (anton-egrg). */
function BudgetPolicy({ form }: { form: SettingsForm }) {
  const { draft, set } = form;
  const on = draft.budgetAware;
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-card px-3 py-3">
      <div className="flex items-center gap-2.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-[12.5px]">Budget-aware execution</span>
          <span className="text-[10.5px] text-subtle">
            use idle Claude capacity up to a weekly cap · off by default
          </span>
        </div>
        <span className="ml-auto">
          <Toggle
            checked={on}
            onChange={(next) => set("budgetAware", next)}
            label="Budget-aware execution"
          />
        </span>
      </div>
      <div
        className={cn(
          "grid grid-cols-2 gap-3 transition-opacity",
          !on && "pointer-events-none opacity-50",
        )}
        aria-hidden={!on}
      >
        <PctField
          label="Daytime reserve"
          value={draft.daytimeReservePct}
          onChange={(value) => set("daytimeReservePct", value)}
          hint="session held back for interactive daytime use"
          disabled={!on}
        />
        <PctField
          label="Weekly cap"
          value={draft.weeklyTargetPct}
          onChange={(value) => set("weeklyTargetPct", value)}
          hint="run freely below this, then stop until reset"
          disabled={!on}
          // 0 would disable the weekly cap (no pace data), not cap at zero — server rejects it.
          min={1}
        />
      </div>
    </div>
  );
}

/** A minutes knob with its unit inside the input — the two timeouts read as one control each. */
function MinutesField({
  label,
  value,
  onChange,
  min,
  max,
  hint,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  hint: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12.5px] text-muted-foreground">{label}</span>
      <div className="relative flex items-center rounded-[10px] border border-border bg-card focus-within:border-primary/60">
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={`${label} in minutes`}
          className="w-full rounded-[10px] bg-transparent px-3 py-2 pr-9 font-mono text-[12.5px] text-foreground outline-none"
        />
        <span className="pointer-events-none absolute right-3 text-[11px] text-subtle">min</span>
      </div>
      <span className="text-[11px] text-subtle">{hint}</span>
    </label>
  );
}

/** A boolean run-policy switch: what it does on the left, the toggle on the right. */
function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2.5">
      <div className="flex flex-col gap-0.5">
        <span className="text-[12.5px]">{label}</span>
        <span className="text-[10.5px] text-subtle">{hint}</span>
      </div>
      <span className="ml-auto">
        <Toggle checked={checked} onChange={onChange} label={label} />
      </span>
    </div>
  );
}
