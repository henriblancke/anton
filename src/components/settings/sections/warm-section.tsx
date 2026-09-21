"use client";

import { cn } from "@/lib/utils";
import { Toggle } from "@/components/atoms";
import { GateField, SectionHeading } from "@/components/settings/settings-fields";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/**
 * Worktree warming (anton-z5li2) — project SETUP, not a verify gate: it runs once when a run's
 * worktree is cut, before the agent starts, so it sits with what happens during a run rather than
 * with the checks that gate the PR.
 *
 * The two knobs answer different questions, and the copy has to keep them apart: an empty command
 * FALLS BACK (env var, then lockfile detection), and the toggle is the only way to skip the warm.
 * Operators reach for the empty field to mean "don't warm", which silently leaves detection running.
 */
export function WarmSection({ form }: { form: SettingsForm }) {
  const { draft, set } = form;
  const on = draft.warmEnabled;
  return (
    <section className="flex flex-col gap-3.5">
      <SectionHeading
        title="Worktree warming"
        hint="project setup anton runs in a fresh worktree, before the agent starts"
      />

      <div className="flex max-w-2xl flex-col gap-3 rounded-[10px] border border-border bg-card px-3 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex flex-col gap-0.5">
            <span className="text-[12.5px]">Warm each run&apos;s worktree</span>
            <span className="text-[10.5px] text-subtle">
              on by default · turn this off to skip warming for this repo entirely
            </span>
          </div>
          <span className="ml-auto">
            <Toggle
              checked={on}
              onChange={(next) => set("warmEnabled", next)}
              label="Warm each run's worktree"
            />
          </span>
        </div>

        <div className={cn("flex flex-col gap-2 transition-opacity", !on && "opacity-50")}>
          <GateField
            label="Warm command"
            value={draft.warmCommand}
            onChange={(value) => set("warmCommand", value)}
            placeholder="e.g. bun install --frozen-lockfile && uv sync"
          />
          <span className="text-[11px] text-subtle">
            Pinned here it wins over <code className="font-mono">ANTON_WARM_COMMAND</code> and
            lockfile detection. Empty falls back to those — it does not skip the warm; the switch
            above is how you do that.
          </span>
        </div>
      </div>

      <span className="max-w-2xl text-[11px] text-subtle">
        Warming is an accelerator, never a gate: a failed setup is logged and the run continues,
        paying the cold start at its first step. Turn it off for a repo whose install needs
        credentials anton doesn&apos;t have — a machine-wide{" "}
        <code className="font-mono">ANTON_WARM_WORKTREE=0</code> still outranks this switch.
      </span>
    </section>
  );
}
