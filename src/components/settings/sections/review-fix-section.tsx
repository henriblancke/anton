"use client";

import { PromptField, SectionHeading } from "@/components/settings/settings-fields";
import {
  REVIEW_FIX_CONCURRENCY_MAX,
  REVIEW_FIX_CONCURRENCY_MIN,
} from "@/components/settings/settings-constants";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/**
 * How claude answers a PR's review — grouped with the other things that happen after the work is
 * written rather than with the run's own seed prompt.
 */
export function ReviewFixSection({ form }: { form: SettingsForm }) {
  return (
    <section className="flex flex-col gap-3.5">
      <SectionHeading title="Review-fix" hint="how claude resolves feedback on an open PR" />
      <div className="flex flex-col gap-2">
        <div className="flex justify-between">
          <span className="text-[12.5px] text-muted-foreground">Max concurrent PR fixes</span>
          <span className="font-mono text-[12.5px] text-primary">
            {form.draft.reviewFixConcurrency}
          </span>
        </div>
        <input
          type="range"
          min={REVIEW_FIX_CONCURRENCY_MIN}
          max={REVIEW_FIX_CONCURRENCY_MAX}
          value={form.draft.reviewFixConcurrency}
          onChange={(e) => form.set("reviewFixConcurrency", Number(e.target.value))}
          aria-label="Max concurrent PR fixes"
          className="accent-primary"
        />
        <span className="text-[11px] text-subtle">
          {REVIEW_FIX_CONCURRENCY_MIN} — {REVIEW_FIX_CONCURRENCY_MAX} · PRs fixed in parallel · not
          the run cap
        </span>
      </div>
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
