"use client";

import { PlusIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { RowControls, SectionHeading } from "@/components/settings/settings-fields";
import type { LabelNamespace } from "@/components/settings/settings-types";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/**
 * Which of the BOARD'S OWN labels mark work worth scarce capacity (anton-prng). anton nominates
 * none: an unnominated board ranks on age alone.
 */
export function ValueSection({
  form,
  labelVocabulary,
}: {
  form: SettingsForm;
  labelVocabulary: LabelNamespace[];
}) {
  const rows = form.draft.valueLabelRows;
  return (
    <section className="flex flex-col gap-3.5">
      <SectionHeading
        title="Work value"
        hint="which labels mark work worth scarce capacity · highest tier first"
      />

      <div className="flex max-w-2xl flex-col gap-2">
        {rows.length === 0 ? (
          <p className="rounded-[10px] border border-dashed border-border px-3 py-3 text-[11.5px] text-subtle">
            Nothing nominated — anton ranks queued work by how long it has waited, and nothing else.
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
                  onChange={(e) => form.valueLabels.setLabel(row.id, e.target.value)}
                  placeholder="a label your board uses"
                  maxLength={120}
                  list="board-label-vocabulary"
                  aria-label={`Value label ${i + 1}`}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-subtle focus:border-primary/60"
                />
                <span className="hidden shrink-0 text-[10.5px] text-subtle sm:inline">
                  {i === 0
                    ? "outranks everything below"
                    : `below ${rows[i - 1].label.trim() || `tier ${i}`}`}
                </span>
                <RowControls
                  onMoveUp={() => form.valueLabels.move(row.id, -1)}
                  onMoveDown={() => form.valueLabels.move(row.id, 1)}
                  onRemove={() => form.valueLabels.remove(row.id)}
                  atTop={i === 0}
                  atBottom={i === rows.length - 1}
                  labels={{
                    up: `Move value label ${i + 1} up`,
                    down: `Move value label ${i + 1} down`,
                    remove: `Remove value label ${i + 1}`,
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        <Button size="sm" variant="outline" className="self-start" onClick={form.valueLabels.add}>
          <PlusIcon aria-hidden="true" />
          Add label
        </Button>
      </div>

      <BoardVocabulary
        labelVocabulary={labelVocabulary}
        nominated={form.valueLabels.nominated}
        onToggle={form.valueLabels.toggle}
      />

      <span className="max-w-2xl text-[11px] text-subtle">
        anton ships no vocabulary — these are your board&apos;s labels, and nominating none is a real
        answer. Nominated labels form disjoint value bands in the order above: any bead in a higher
        band outranks every bead below it, and how long a bead has waited only breaks ties inside its
        own band. Work carrying none of them ranks by age alone, under everything nominated. That
        ranking is what decides which queued work anton spends scarce capacity on first (Concurrency
        &amp; limits → Budget-aware execution).
      </span>
    </section>
  );
}

/**
 * The board's own vocabulary, grouped by namespace — anton ships none, so what can be nominated is
 * whatever this board already labels its work with. Doubles as the typeahead for the free-text rows,
 * so a typed nomination is a label the board actually carries rather than one that matches nothing.
 */
function BoardVocabulary({
  labelVocabulary,
  nominated,
  onToggle,
}: {
  labelVocabulary: LabelNamespace[];
  nominated: Set<string>;
  onToggle: (label: string) => void;
}) {
  return (
    <>
      {labelVocabulary.length === 0 ? (
        <p className="max-w-2xl text-[11px] text-subtle">
          No labels read off this board yet — type one above.
        </p>
      ) : (
        <div className="flex max-w-2xl flex-col gap-3">
          <span className="text-[12.5px] font-medium">
            On this board{" "}
            <span className="text-[11px] font-normal text-subtle">
              · click to nominate · the number is how many beads carry it
            </span>
          </span>
          {labelVocabulary.map((group) => (
            <div key={group.namespace} className="flex flex-col gap-1.5">
              <span className="font-mono text-[10.5px] text-subtle">
                {group.namespace ? `${group.namespace}:` : "no namespace"}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {group.labels.map(({ label, count }) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => onToggle(label)}
                    aria-pressed={nominated.has(label)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors",
                      nominated.has(label)
                        ? "border-primary/60 bg-primary/10 text-foreground"
                        : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
                    )}
                  >
                    {label}
                    <span className="text-[9.5px] text-subtle">{count}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <datalist id="board-label-vocabulary">
        {labelVocabulary.flatMap((group) =>
          group.labels.map(({ label }) => <option key={label} value={label} />),
        )}
      </datalist>
    </>
  );
}
