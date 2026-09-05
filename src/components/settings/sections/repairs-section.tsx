"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";
import { AUTONOMY_LEVELS } from "@/components/settings/settings-autonomy";
import {
  REPAIR_CLASSES,
  REPAIR_LEVEL_HINT,
  type RepairAutonomy,
  type RepairClassSpec,
} from "@/components/settings/settings-repair";
import { SectionHeading } from "@/components/settings/settings-fields";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/**
 * What anton does when a run declares itself blocked, per class (R5.3).
 *
 * The proposal control's twin, and the differences are the point. There is no earned-autonomy bar
 * here — a repair is never filed, so it never builds a record a founder answers — so `apply` is
 * available from the first day. And the shipped level is `shadow`, not `propose`: the two factual
 * repairs are already working their fix out on every block and writing it to the bead's notes, so
 * this page is where an operator reads that record and decides whether to arm it.
 */
export function RepairsSection({ form, projectSlug }: { form: SettingsForm; projectSlug: string }) {
  return (
    <section className="flex max-w-2xl flex-col gap-3.5">
      <SectionHeading
        title="Repair autonomy"
        hint="what anton does with a block a run declared, per class"
      />

      <RepairLegend projectSlug={projectSlug} />

      <div
        role="group"
        aria-labelledby="repair-classes"
        className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-card px-3 py-3"
      >
        <div className="flex flex-col gap-1">
          <span id="repair-classes" className="text-[12.5px] font-medium">
            Undone by one write
          </span>
          <span className="text-[11px] text-subtle">
            A repair corrects the bead the run stopped on: a pointer, or an ordering edge.
          </span>
          <span className="text-[11px] text-subtle">
            <span className="text-muted-foreground">Undone by</span> one bd write, and the repair
            leaves a note on the bead saying exactly what it changed.
          </span>
          <span className="text-[11px] text-risk-med">
            <span className="font-mono">apply</span> Armed, anton edits the bead and the run carries
            on without asking. Nothing is invented — but nothing is asked either.
          </span>
        </div>

        <div className="flex flex-col divide-y divide-border/60">
          {REPAIR_CLASSES.map((klass) => (
            <RepairRow
              key={klass.id}
              klass={klass}
              value={form.draft.repairAutonomy[klass.id]!}
              onChange={(level) => form.armRepair(klass.id, level)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

/** What each level means for a repair, and where the record of one shows up. */
function RepairLegend({ projectSlug }: { projectSlug: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border border-border bg-card px-3 py-2.5">
      {AUTONOMY_LEVELS.map((level) => (
        <div key={level} className="flex items-baseline gap-2.5">
          <span className="w-14 shrink-0 font-mono text-[10.5px] text-primary">{level}</span>
          <span className="text-[11px] text-subtle">{REPAIR_LEVEL_HINT[level]}</span>
        </div>
      ))}
      {/* Where the evidence is. Unlike a proposal, a repair leaves no bead to accept or decline —
          the note on the ticket and the run's own log are the whole record, so an operator deciding
          whether to arm one has to be told where to read it. */}
      <span className="text-[11px] text-subtle">
        A repair — armed or shadowed — writes what it did, or would have done, as a note on the
        ticket and a line on the run&apos;s{" "}
        <Link
          href={`/projects/${projectSlug}/runs`}
          className="text-primary underline-offset-2 hover:underline"
        >
          session log
        </Link>
        . Read a week of shadow before you arm one.
      </span>
      {/* The loop guard, said here because it bounds what arming can cost. */}
      <span className="text-[11px] text-subtle">
        Whatever this says, anton repairs a bead at most ONCE per class. A second block of the same
        class escalates — the repair is what has been disproved, and the next step is a human.
      </span>
    </div>
  );
}

/** One class's row: the block it names, what a repair writes, and how far this project lets it go. */
function RepairRow({
  klass,
  value,
  onChange,
}: {
  klass: RepairClassSpec;
  value: RepairAutonomy;
  onChange: (level: RepairAutonomy) => void;
}) {
  return (
    <div className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-mono text-[11.5px]">{klass.id}</span>
        <span className="text-[11px] text-subtle">{klass.block}</span>
        {klass.blocked ? (
          <span className="text-[11px] text-risk-med">not armable · {klass.blocked}</span>
        ) : (
          <span className="text-[11px] text-subtle">
            <span className="text-muted-foreground">armed</span> {klass.does}
          </span>
        )}
      </div>
      <span className="ml-auto shrink-0">
        <RepairChoice klass={klass} value={value} onChange={onChange} />
      </span>
    </div>
  );
}

/**
 * The three levels as a segmented radio group, least autonomous first — the proposal control's
 * shape, for the reason it has that shape: three points on one scale read best side by side, and a
 * class anton has no repair for can be shown PINNED with its reason rather than hidden.
 */
function RepairChoice({
  klass,
  value,
  onChange,
}: {
  klass: RepairClassSpec;
  value: RepairAutonomy;
  onChange: (level: RepairAutonomy) => void;
}) {
  return (
    <fieldset className="flex gap-0.5 rounded-[9px] border border-border bg-background/40 p-0.5">
      <legend className="sr-only">{klass.id} repair autonomy</legend>
      {AUTONOMY_LEVELS.map((level) => (
        <label
          key={level}
          title={klass.blocked ?? REPAIR_LEVEL_HINT[level]}
          className={cn("block", klass.blocked ? "cursor-not-allowed" : "cursor-pointer")}
        >
          <input
            type="radio"
            name={`repair-${klass.id}`}
            className="peer sr-only"
            value={level}
            checked={value === level}
            disabled={Boolean(klass.blocked)}
            onChange={() => onChange(level)}
            aria-label={`${klass.id} · ${level}`}
          />
          <span className="block rounded-[7px] px-2 py-1 font-mono text-[10.5px] text-muted-foreground transition-colors peer-checked:bg-primary/15 peer-checked:text-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary/50 peer-disabled:text-subtle peer-disabled:opacity-50">
            {level}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
