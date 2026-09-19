"use client";

import { PromptField, SectionHeading } from "@/components/settings/settings-fields";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/** The operator-editable contract that turns a committed run diff into its PR narrative. */
export function DescribeSection({ form }: { form: SettingsForm }) {
  return (
    <section className="flex flex-col gap-3.5">
      <SectionHeading title="PR narrative" hint="how claude summarizes committed work for the pull request" />
      <PromptField
        label="Describe prompt"
        hint="editable · how claude writes the PR narrative"
        value={form.draft.describePrompt}
        saved={form.saved.describePrompt ?? ""}
        onChange={(value) => form.set("describePrompt", value)}
        placeholder="Override the default describer reasoning prompt. Empty = anton's shipped default (skills/describe/SKILL.md)."
        footnote="The describer receives the committed diff and writes the summary, changes, and non-goals shown in the PR. Empty = shipped default."
      />
    </section>
  );
}
