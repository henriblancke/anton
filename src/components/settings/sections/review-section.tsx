"use client";

import { cn } from "@/lib/utils";
import { Toggle } from "@/components/atoms";
import {
  DEFAULT_REVIEW_LOW_SCORE_ROUNDS,
  DEFAULT_REVIEW_MAX_ROUNDS,
  DEFAULT_REVIEW_MIN_SCORE,
  REVIEW_LOW_SCORE_ROUNDS_MAX,
  REVIEW_LOW_SCORE_ROUNDS_MIN,
  REVIEW_MAX_ROUNDS_MAX,
  REVIEW_MAX_ROUNDS_MIN,
  REVIEW_MIN_SCORE_MAX,
  REVIEW_MIN_SCORE_MIN,
} from "@/components/settings/settings-constants";
import {
  CountField,
  PromptField,
  ReviewerField,
  SectionHeading,
} from "@/components/settings/settings-fields";
import type { DiscoveredAgent } from "@/components/settings/settings-types";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/**
 * The pre-PR gate (anton-3apm): on by default, reviewer swappable for one of this project's agents
 * or a raw prompt.
 */
export function ReviewSection({
  form,
  agents,
}: {
  form: SettingsForm;
  agents: DiscoveredAgent[];
}) {
  const { draft, set } = form;
  const on = draft.reviewEnabled;
  return (
    <section className="flex flex-col gap-3.5">
      <SectionHeading
        title="Self-review"
        hint="a fresh-context review of each run's diff, before the PR opens"
      />

      <div className="flex max-w-2xl flex-col gap-3 rounded-[10px] border border-border bg-card px-3 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex flex-col gap-0.5">
            <span className="text-[12.5px]">Review before opening the PR</span>
            <span className="text-[10.5px] text-subtle">
              findings are fixed in a bounded loop · on by default
            </span>
          </div>
          <span className="ml-auto">
            <Toggle
              checked={on}
              onChange={(next) => set("reviewEnabled", next)}
              label="Review before opening the PR"
            />
          </span>
        </div>

        <div className={cn("flex flex-col gap-3 transition-opacity", !on && "opacity-50")}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ReviewerField
              value={draft.reviewAgent}
              onChange={(value) => set("reviewAgent", value)}
              agents={agents}
              disabled={!on}
            />
            <CountField
              label="Max review rounds"
              value={draft.reviewMaxRounds}
              onChange={(value) => set("reviewMaxRounds", value)}
              min={REVIEW_MAX_ROUNDS_MIN}
              max={REVIEW_MAX_ROUNDS_MAX}
              fallback={DEFAULT_REVIEW_MAX_ROUNDS}
              disabled={!on}
              hint={`review → fix → re-review · default ${DEFAULT_REVIEW_MAX_ROUNDS}`}
            />
          </div>

          <ScoreAlarm form={form} />
          <ReviewPrompt form={form} />
        </div>
      </div>
    </section>
  );
}

/** The reviewer's own reasoning contract — a fallback once a named reviewer brings its own. */
function ReviewPrompt({ form }: { form: SettingsForm }) {
  const { draft } = form;
  return (
    <PromptField
      label="Review prompt"
      hint={
        draft.reviewAgent
          ? "fallback · unused while a reviewer is named"
          : "editable · what to review for"
      }
      value={draft.reviewPrompt}
      saved={form.saved.reviewPrompt ?? ""}
      onChange={(value) => form.set("reviewPrompt", value)}
      rows={5}
      disabled={!draft.reviewEnabled}
      placeholder="Override the default review contract. Empty = anton's shipped default (skills/review)."
      footnote={
        <>
          The reasoning contract for the reviewer. anton appends the run&apos;s diff and tickets
          beneath it.{" "}
          {draft.reviewAgent
            ? `${draft.reviewAgent} brings its own contract, so this runs only if that agent can't be loaded.`
            : "Empty = shipped default (skills/review)."}
        </>
      }
    />
  );
}

/**
 * The score-regression alarm (anton-i98r) — a policy of its own, not another rounds knob: it decides
 * when anton stops fixing and hands the run back.
 */
function ScoreAlarm({ form }: { form: SettingsForm }) {
  const { draft, set } = form;
  const off = draft.reviewMinScore === REVIEW_MIN_SCORE_MIN;
  // A streak longer than the round cap can never be reached — the loop stops at the cap first — so
  // the contradiction is named here, not left to the save's 400.
  const unreachable = !off && draft.reviewLowScoreRounds > draft.reviewMaxRounds;
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-background/40 px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[12.5px] font-medium">Score-regression alarm</span>
        <span className={cn("text-[11px]", unreachable ? "text-risk-high" : "text-subtle")}>
          {off
            ? "off · the loop runs to the round cap whatever it scores"
            : unreachable
              ? `never fires · ${draft.reviewLowScoreRounds} low rounds can't happen in ${draft.reviewMaxRounds} review round${draft.reviewMaxRounds === 1 ? "" : "s"}`
              : `park after ${draft.reviewLowScoreRounds} round${draft.reviewLowScoreRounds === 1 ? "" : "s"} below ${draft.reviewMinScore}/10`}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <CountField
          label="Minimum score"
          value={draft.reviewMinScore}
          onChange={(value) => set("reviewMinScore", value)}
          min={REVIEW_MIN_SCORE_MIN}
          max={REVIEW_MIN_SCORE_MAX}
          fallback={DEFAULT_REVIEW_MIN_SCORE}
          disabled={!draft.reviewEnabled}
          hint={`0 turns the alarm off · default ${DEFAULT_REVIEW_MIN_SCORE}`}
        />
        <CountField
          label="Consecutive low rounds"
          value={draft.reviewLowScoreRounds}
          onChange={(value) => set("reviewLowScoreRounds", value)}
          min={REVIEW_LOW_SCORE_ROUNDS_MIN}
          max={REVIEW_LOW_SCORE_ROUNDS_MAX}
          fallback={DEFAULT_REVIEW_LOW_SCORE_ROUNDS}
          disabled={!draft.reviewEnabled || off}
          hint={`a round at or above the minimum resets the streak · default ${DEFAULT_REVIEW_LOW_SCORE_ROUNDS}`}
        />
      </div>
      <span className="text-[11px] text-subtle">
        Sustained low scores are a decision for you, not another fix round: when the streak trips,
        anton stops the loop, opens no PR, and parks the run with the score series attached.
      </span>
    </div>
  );
}
