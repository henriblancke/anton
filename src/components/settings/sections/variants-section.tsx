"use client";

import { ArrowRightIcon, PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { RowControls, SectionHeading } from "@/components/settings/settings-fields";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/** Let the work's own labels pick the pipeline (anton-aa3m) — first matching label wins. */
export function VariantsSection({ form }: { form: SettingsForm }) {
  const rows = form.draft.variantRows;
  return (
    <section className="flex flex-col gap-3.5">
      <SectionHeading
        title="Pipeline variants"
        hint="run a different formula for beads carrying a label · first match wins"
      />

      <div className="flex max-w-2xl flex-col gap-2">
        {rows.length === 0 ? (
          <p className="rounded-[10px] border border-dashed border-border px-3 py-3 text-[11.5px] text-subtle">
            No variants — every run walks{" "}
            <code className="font-mono text-[11px]">.beads/formulas/anton-run.formula.toml</code>.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row, i) => (
              <li
                key={row.id}
                className="flex items-center gap-2 rounded-[10px] border border-border bg-card px-2.5 py-2"
              >
                <span className="w-4 shrink-0 text-center font-mono text-[10px] text-subtle">
                  {i + 1}
                </span>
                <input
                  type="text"
                  value={row.label}
                  onChange={(e) => form.variants.patch(row.id, { label: e.target.value })}
                  placeholder="risk:high"
                  maxLength={120}
                  aria-label={`Variant ${i + 1} label`}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
                />
                <ArrowRightIcon className="size-3 shrink-0 text-subtle" aria-hidden="true" />
                <input
                  type="text"
                  value={row.formula}
                  onChange={(e) => form.variants.patch(row.id, { formula: e.target.value })}
                  placeholder="anton-run-risk-high"
                  maxLength={120}
                  aria-label={`Variant ${i + 1} formula`}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
                />
                <RowControls
                  onMoveUp={() => form.variants.move(row.id, -1)}
                  onMoveDown={() => form.variants.move(row.id, 1)}
                  onRemove={() => form.variants.remove(row.id)}
                  atTop={i === 0}
                  atBottom={i === rows.length - 1}
                  labels={{
                    up: `Move variant ${i + 1} up`,
                    down: `Move variant ${i + 1} down`,
                    remove: `Remove variant ${i + 1}`,
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        <Button size="sm" variant="outline" className="self-start" onClick={form.variants.add}>
          <PlusIcon aria-hidden="true" />
          Add variant
        </Button>
      </div>

      <span className="max-w-2xl text-[11px] text-subtle">
        A run target carrying a mapped label walks{" "}
        <code className="font-mono text-[11px]">
          .beads/formulas/&lt;formula&gt;.formula.toml
        </code>{" "}
        instead of the default — so <code className="font-mono text-[11px]">risk:high</code> can
        carry extra steps and a docs-only ticket can skip verify. Two mapped labels on one bead? The
        first row wins, which is why order is editable. Every variant is held to the same floor as
        the default (implement → commit → PR); a missing or floor-violating one parks the run
        instead of silently falling back.
      </span>
    </section>
  );
}
