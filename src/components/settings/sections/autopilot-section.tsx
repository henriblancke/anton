"use client";

import { CountField, SectionHeading } from "@/components/settings/settings-fields";
import {
  AUTOPILOT_FAILURE_STREAK_MAX,
  AUTOPILOT_FAILURE_STREAK_MIN,
  AUTOPILOT_SCORE_FLOOR_MAX,
  AUTOPILOT_SCORE_FLOOR_MIN,
  AUTOPILOT_SCORE_WINDOW_MAX,
  AUTOPILOT_SCORE_WINDOW_MIN,
  AUTOPILOT_WIP_LIMIT_MAX,
  AUTOPILOT_WIP_LIMIT_MIN,
  DEFAULT_AUTOPILOT_FAILURE_STREAK,
  DEFAULT_AUTOPILOT_SCORE_FLOOR,
  DEFAULT_AUTOPILOT_SCORE_WINDOW,
  DEFAULT_AUTOPILOT_WIP_LIMIT,
} from "@/components/settings/settings-constants";
import type { SettingsForm } from "@/components/settings/use-settings-form";

/**
 * The autopilot brakes (anton-nmy7): when anton stops STARTING work, and what it takes to start
 * again. One is a self-clearing hold; the other two latch a disarm only a human lifts — which is
 * why each block says, in its own words, what releases it.
 */
export function AutopilotSection({ form }: { form: SettingsForm }) {
  const { draft, set } = form;
  return (
    <div className="grid max-w-3xl grid-cols-1 gap-7">
      <section className="flex flex-col gap-3.5">
        <SectionHeading
          title="Autopilot brakes"
          hint="when anton stops starting new work — and what it takes to start again"
        />
        <span className="text-[11px] text-subtle">
          Work already running is never affected — only starting new work is stopped. Whichever brake
          is on says so on the board, with what would release it, so none of this has to be read back
          from here.
        </span>

        {/* The HOLD first, and worded as pacing rather than as a fault. It is the one brake that
            clears itself, and an operator who reads it as a failure turns it off. */}
        <div className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-background/40 px-3 py-2.5">
          <div className="flex items-baseline gap-2">
            <span className="text-[12.5px] font-medium">Review queue limit</span>
            <span className="text-[11px] text-subtle">
              {draft.autopilotWipLimit === AUTOPILOT_WIP_LIMIT_MIN
                ? "off · anton starts work however many PRs are waiting on you"
                : `hold once ${draft.autopilotWipLimit} PR${draft.autopilotWipLimit === 1 ? " is" : "s are"} open in review`}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <CountField
              label="Open PRs in review"
              value={draft.autopilotWipLimit}
              onChange={(value) => set("autopilotWipLimit", value)}
              min={AUTOPILOT_WIP_LIMIT_MIN}
              max={AUTOPILOT_WIP_LIMIT_MAX}
              fallback={DEFAULT_AUTOPILOT_WIP_LIMIT}
              hint={`0 turns the hold off · default ${DEFAULT_AUTOPILOT_WIP_LIMIT}`}
            />
          </div>
          <span className="text-[11px] text-subtle">
            A hold, not a disarm: it releases itself the moment one of those PRs merges or closes, and
            asks nothing of you in the meantime.
          </span>
        </div>

        <div className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-background/40 px-3 py-2.5">
          <div className="flex items-baseline gap-2">
            <span className="text-[12.5px] font-medium">Consecutive-failure breaker</span>
            <span className="text-[11px] text-subtle">
              {draft.autopilotFailureStreak === AUTOPILOT_FAILURE_STREAK_MIN
                ? "off · anton keeps starting runs however many fail"
                : `disarm after ${draft.autopilotFailureStreak} run${draft.autopilotFailureStreak === 1 ? "" : "s"} failing in a row`}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <CountField
              label="Failed runs in a row"
              value={draft.autopilotFailureStreak}
              onChange={(value) => set("autopilotFailureStreak", value)}
              min={AUTOPILOT_FAILURE_STREAK_MIN}
              max={AUTOPILOT_FAILURE_STREAK_MAX}
              fallback={DEFAULT_AUTOPILOT_FAILURE_STREAK}
              hint={`0 turns the breaker off · default ${DEFAULT_AUTOPILOT_FAILURE_STREAK}`}
            />
          </div>
          <span className="text-[11px] text-subtle">
            Runs you cancelled do not count toward the streak; work you abandoned does — giving up on
            it is an outcome, not a stop. A disarm stays off until you re-arm it from the board — no
            pass ever lifts one.
          </span>
        </div>

        <div className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-background/40 px-3 py-2.5">
          <div className="flex items-baseline gap-2">
            <span className="text-[12.5px] font-medium">Score-regression breaker</span>
            <span className="text-[11px] text-subtle">
              {draft.autopilotScoreFloor === AUTOPILOT_SCORE_FLOOR_MIN
                ? "off · anton keeps starting runs however they score"
                : `disarm after ${draft.autopilotScoreWindow} run${draft.autopilotScoreWindow === 1 ? "" : "s"} scoring below ${draft.autopilotScoreFloor}/10`}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <CountField
              label="Score floor"
              value={draft.autopilotScoreFloor}
              onChange={(value) => set("autopilotScoreFloor", value)}
              min={AUTOPILOT_SCORE_FLOOR_MIN}
              max={AUTOPILOT_SCORE_FLOOR_MAX}
              fallback={DEFAULT_AUTOPILOT_SCORE_FLOOR}
              hint={`0 turns the breaker off · default ${DEFAULT_AUTOPILOT_SCORE_FLOOR}`}
            />
            <CountField
              label="Consecutive runs below it"
              value={draft.autopilotScoreWindow}
              onChange={(value) => set("autopilotScoreWindow", value)}
              min={AUTOPILOT_SCORE_WINDOW_MIN}
              max={AUTOPILOT_SCORE_WINDOW_MAX}
              fallback={DEFAULT_AUTOPILOT_SCORE_WINDOW}
              disabled={draft.autopilotScoreFloor === AUTOPILOT_SCORE_FLOOR_MIN}
              hint={`a run at or above the floor restarts the series · default ${DEFAULT_AUTOPILOT_SCORE_WINDOW}`}
            />
          </div>
          <span className="text-[11px] text-subtle">
            Judged on the self-review score each finished run was given — the series the Health page
            charts. Not the same knob as the score-regression alarm under Self-review: that one parks
            a single run mid-review, this one stops the project.
          </span>
        </div>
      </section>
    </div>
  );
}
