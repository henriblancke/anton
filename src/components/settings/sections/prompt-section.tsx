"use client";

import { PromptField, SectionHeading } from "@/components/settings/settings-fields";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/** The locked base contract (read-only) plus the editable operator seed layered on top of it. */
export function PromptSection({ form, basePrompt }: { form: SettingsForm; basePrompt: string }) {
  return (
    <section className="flex flex-col gap-3.5">
      <SectionHeading
        title="Execution prompt"
        hint="what anton tells claude on every autonomous run"
      />

      <PromptField
        label="Seed prompt"
        hint="editable · project-specific guidance"
        value={form.draft.seedPrompt}
        saved={form.saved.seedPrompt ?? ""}
        onChange={(value) => form.set("seedPrompt", value)}
        placeholder="e.g. Prefer server components. Our design tokens live in src/styles/tokens.css. Never touch the legacy /v1 API."
        footnote="Layered on top of the base contract below. It refines behavior — it can’t override the contract. Empty = base + agent prompt only."
      />

      <div className="flex max-w-2xl flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-medium">Base contract</span>
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
            locked · always applied
          </span>
        </div>
        <pre className="max-h-64 max-w-2xl overflow-auto rounded-lg border border-border bg-card px-3 py-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {basePrompt || "(base prompt unavailable)"}
        </pre>
        <span className="text-[11px] text-subtle">
          Core operating rules — git &amp; beads ownership, learnings capture, scope, fail-loud.
          Defined in code; not editable here.
        </span>
      </div>
    </section>
  );
}
