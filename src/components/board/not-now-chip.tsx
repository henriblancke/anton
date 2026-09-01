"use client";

import { TimerResetIcon } from "lucide-react";

import { MetaChip } from "@/components/atoms";
import { useLiveNow } from "@/components/live-clock";
import { formatCountdown, formatExactTime } from "@/lib/time";

/**
 * How often the remaining window is re-read. The label's finest unit is a minute, so half of one
 * keeps it honest at every boundary without re-rendering a board of chips for nothing.
 */
const TICK_MS = 30_000;

/**
 * "not now" chip — the operator vetoed this pick and anton is holding the target until the window
 * runs out (anton-jqvy). Distinct from `snoozed`, which is bd's own shared, unbounded defer: this
 * one expires by itself, so it names WHEN rather than asking to be undone.
 *
 * A CLIENT leaf, and only because of the countdown (PR #212 review). The hold runs for a day and the
 * board it sits on is left open for a day: a label computed once at render would read `23h` until
 * something else happened to re-render it, and nothing does — an ordinary poll answers 304 while the
 * deferral set is unchanged, which is exactly the whole window. So the chip reads a shared clock and
 * moves on its own.
 *
 * Before hydration — and once the window has run out, until the next poll drops the chip — it shows
 * the bare "not now". The remaining time is an enrichment; the tooltip carries the exact expiry,
 * which is server data and never needs a clock at all.
 */
export function NotNowChip({ untilMs, className }: { untilMs: number; className?: string }) {
  const now = useLiveNow(TICK_MS);
  const iso = new Date(untilMs).toISOString();
  const countdown = now === null ? null : formatCountdown(iso, now);
  const left = countdown === null || countdown === "now" ? null : countdown;
  const exact = formatExactTime(iso);

  return (
    <MetaChip className={className}>
      <TimerResetIcon className="size-2.5" aria-hidden="true" />
      <span title={`Not now — anton offers this again ${left ? `in ${left} ` : ""}(${exact})`}>
        {left ? `not now · ${left}` : "not now"}
      </span>
    </MetaChip>
  );
}
