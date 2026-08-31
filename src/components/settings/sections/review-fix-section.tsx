"use client";

import { PromptField, SectionHeading } from "@/components/settings/settings-fields";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/**
 * How claude answers a PR's review — grouped with the other things that happen after the work is
 * written rather than with the run's own seed prompt.
 */
export function ReviewFixSection({ form }: { form: SettingsForm }) {
  return (
    <section className="flex flex-col gap-3.5">
      <SectionHeading title="Review-fix" hint="how claude resolves feedback on an open PR" />
      <PromptField
        label="Review-fix prompt"
        hint="editable · how claude resolves PR feedback"
        value={form.draft.reviewFixPrompt}
        saved={form.saved.reviewFixPrompt ?? ""}
        onChange={(value) => form.set("reviewFixPrompt", value)}
        placeholder="Override the default review-fix reasoning prompt. Empty = anton's shipped default (skills/review-fix/SKILL.md)."
        footnote="The reasoning contract for the review-fix job. anton appends the concrete PR context (comments, failing checks) beneath it. Empty = shipped default."
      />
    </section>
  );
}
