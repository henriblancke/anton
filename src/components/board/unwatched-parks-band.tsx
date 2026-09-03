"use client";

import { EyeOffIcon } from "lucide-react";
import Link from "next/link";

import { MetaChip } from "@/components/atoms";
import { ArmWatcherButton } from "@/components/board/arm-watcher-button";
import { stuckFor } from "@/components/board/escalation-age";
import { buttonVariants } from "@/components/ui/button";
import type { UnwatchedParks, WatcherAutomation } from "@/lib/types";

/** What each half of detect → act stops happening when it is off. */
const DISARMED_CONSEQUENCE: Record<WatcherAutomation, string> = {
  "run-health": "run-health is off, so no stall is ever detected",
  unstick: "unstick is off, so nothing acts on what is detected",
};

/**
 * The sentence that names the cost of the silence, built from whichever halves are off. Written as
 * a consequence and not a config diff: an operator reading this band is deciding whether to care,
 * and "run-health is disabled" is only an answer to someone who already knows what run-health does.
 */
function disarmedSentence(disarmed: WatcherAutomation[]): string {
  const clauses = disarmed.map((type) => DISARMED_CONSEQUENCE[type]);
  // One half off is one consequence, so the pronoun has to follow the count rather than assume both.
  const consequence =
    clauses.length === 1
      ? "it will not escalate on its own"
      : "these will not escalate on their own";
  return `${clauses.join(", and ")} — ${consequence}.`;
}

/**
 * Parked work on an unwatched queue (anton-kh98).
 *
 * The escalation strip below this band has exactly one producer — the unstick pass, acting on
 * run-health's report — and run-health ships opt-in. With it off, a job can park for a week and the
 * strip stays empty, which is indistinguishable from a healthy board. This band is the difference:
 * it says work has stopped, says how much and for how long, and hands over the switch that starts
 * watching it.
 *
 * It renders NOTHING while the watcher is armed, and nothing while no job is parked — the whole
 * signal is its presence (see {@link unwatchedParks}, which returns `undefined` in both cases). A
 * band that stood on a healthy board would be an ornament, and an operator would learn to skip it
 * in exactly the week it finally had something to say.
 *
 * Amber, not the strip's red: nothing here is broken in the sense the four stall classes are, and
 * nothing is being asked of the founder's judgment. This is a blind spot — a state the install was
 * shipped in — and drawing it as a failure would teach the board's red to mean less.
 *
 * The age is the server's frozen reading rather than a live one, unlike the escalation strip's
 * hydration-deferred clock: this band is answered by a click that reloads the page, and a wait
 * already measured in hours or days does not change meaning while it is being read. The frozen
 * value is server data, so it is identical across the server render and hydration by construction.
 */
export function UnwatchedParksBand({
  slug,
  parks,
}: {
  slug: string;
  /** Absent when the watcher is armed or nothing is parked — the band is silent in both cases. */
  parks?: UnwatchedParks;
}) {
  if (!parks) return null;

  return (
    <section
      aria-labelledby="unwatched-parks-heading"
      className="mb-3 overflow-hidden rounded-xl border border-risk-med/30 bg-risk-med/[0.05]"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border/60 px-3 py-2">
        <EyeOffIcon className="size-3.5 text-risk-med" aria-hidden="true" />
        <h2 id="unwatched-parks-heading" className="text-xs font-medium text-foreground">
          Parked work, unwatched
        </h2>
        {/* The two numbers the ticket is about, as chips so they survive a glance: how much has
            stopped, and how long the worst of it has been stopped for. */}
        <MetaChip tone="risk-med">
          {parks.parkedCount} parked {parks.parkedCount === 1 ? "job" : "jobs"}
        </MetaChip>
        <MetaChip>oldest waiting {stuckFor(parks.oldestAgeMs)}</MetaChip>
      </div>

      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-xs font-medium text-foreground">{disarmedSentence(parks.disarmed)}</p>
          {/* No cadence named: the schedule row owns that, and copy here could disagree with the
              cron that actually fires. The auto-resume IS named, because the button below grants it:
              an operator clicking "turn on the watcher" off copy that promised only detection would
              be surprised by the next sweep spending quota. */}
          <p className="text-[11px] text-subtle">
            Turning the watcher on starts the stall sweep on its schedule. It resumes the two
            stalls it can prove are safe — a run whose usage limit has since reopened, and work
            whose machine died holding the lease — and both spend quota when they resume. Everything
            else is raised here as a row you can resume or abandon.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Link
            href={`/projects/${slug}/jobs?status=parked`}
            className={buttonVariants({ size: "xs", variant: "outline" })}
          >
            See parked jobs
          </Link>
          <ArmWatcherButton slug={slug} disarmed={parks.disarmed} />
        </div>
      </div>
    </section>
  );
}
