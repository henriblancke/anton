"use client";

import { GateField, SectionHeading } from "@/components/settings/settings-fields";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/** Operator-pinned hard checks run in the worktree before commit (anton-3oh8). */
export function GatesSection({ form }: { form: SettingsForm }) {
  return (
    <section className="flex flex-col gap-3.5">
      <SectionHeading
        title="Verify gates"
        hint="deterministic checks anton runs after the agent, before commit · non-zero exit fails the ticket"
      />
      <div className="grid max-w-2xl grid-cols-1 gap-3.5 sm:grid-cols-2">
        <GateField
          label="Test command"
          value={form.draft.testCommand}
          onChange={(value) => form.set("testCommand", value)}
          placeholder="e.g. bun run test"
        />
        <GateField
          label="Lint command"
          value={form.draft.lintCommand}
          onChange={(value) => form.set("lintCommand", value)}
          placeholder="e.g. bun run lint"
        />
        <GateField
          label="Typecheck command"
          value={form.draft.typecheckCommand}
          onChange={(value) => form.set("typecheckCommand", value)}
          placeholder="e.g. bun run typecheck"
        />
        <GateField
          label="Build command"
          value={form.draft.buildCommand}
          onChange={(value) => form.set("buildCommand", value)}
          placeholder="e.g. bun run build"
        />
      </div>
      <span className="max-w-2xl text-[11px] text-subtle">
        Each gate runs in the ticket&apos;s worktree in order (test → lint → typecheck → build).
        Empty = skipped. These are the operator-pinned backstop; the agent still self-verifies. The
        same gates run before review-fix pushes.
      </span>
    </section>
  );
}
