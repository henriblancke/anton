"use client";

import { useEffect, useState, type ReactNode } from "react";
import { HourglassIcon } from "lucide-react";

import type { BudgetLine, BudgetSignal } from "@/lib/budget-line";
import type { DeferReason } from "@/lib/jobs/budget";
import { cn } from "@/lib/utils";
import { MetaChip } from "@/components/atoms";

/**
 * The dashed budget line and the waiting cards under it (anton-vlom / R3.6).
 *
 * Two primitives rather than one lane component, because the lane owns the cards and only it knows
 * their order. It composes them: `budgetLine(signal, entries)` for the position, `BudgetDivider`
 * between the affordable prefix and the rest, `BudgetWaiting` around each card below.
 *
 * The line is ADVISORY, never a brake: a card below it still carries `[Release]`, because the
 * operator releasing one target by hand is exactly the escape hatch the governor's pacing leaves
 * open. Dimming says "anton would not start this now", not "you may not".
 *
 * Marked approximate everywhere it is worded (`≈`, "roughly"). Burn attribution is sampled, and a
 * type under its sample window is still leaning on a tier seed — a line drawn as a promise would
 * be a lie a week of real samples would expose.
 */

interface ReasonCopy {
  /** The hold, in the operator's words — what the divider and each waiting chip name. */
  label: string;
  /** What happens next, for the tooltip. A hold the operator can't wait out is a bug report. */
  blurb: string;
}

/**
 * Every hold the governor can defer on, worded for the board. Total, not partial: a reason added to
 * {@link DeferReason} must fail this build rather than render a card that waits for nothing said.
 */
const REASON_COPY: Record<DeferReason, ReasonCopy> = {
  "session-headroom": {
    label: "session headroom",
    blurb: "the 5-hour session is nearly spent — these start once it resets",
  },
  "weekly-cap": {
    label: "weekly cap",
    blurb: "this week's budget is spent — these start after the weekly window resets",
  },
  "weekly-on-track": {
    label: "weekly pacing",
    blurb: "ahead of the weekly pace-line — these start as the line catches up",
  },
  "daytime-reserve": {
    label: "daytime reserve",
    blurb: "the rest of the session is held for your own interactive use — these start tonight",
  },
};

/** How the placement is qualified in a tooltip: measured averages, or still partly a tier estimate. */
function precision(line: BudgetLine): string {
  return line.seeded
    ? "estimated from tier seeds until enough runs are sampled"
    : "from this machine's sampled per-run burn averages";
}

/**
 * Where the remaining quota runs out, drawn across the lane. Sits ABOVE the first card it can't
 * pay for — with `affordable: 0` that is the top of the lane, which is the honest answer when the
 * governor is already holding.
 */
export function BudgetDivider({ line, className }: { line: BudgetLine; className?: string }) {
  const copy = REASON_COPY[line.reason];
  const title = `Roughly where this project's quota runs out — ${copy.blurb}. Approximate: ${precision(line)}.`;

  return (
    <div
      role="separator"
      aria-label={`Budget line — ${copy.label}. ${copy.blurb}`}
      title={title}
      className={cn("flex items-center gap-2 py-1 select-none", className)}
    >
      <span className="h-0 flex-1 border-t border-dashed border-usage-warn/45" aria-hidden="true" />
      <span className="font-mono text-[10px] leading-none whitespace-nowrap text-usage-warn">
        ≈ budget · {copy.label}
      </span>
      <span className="h-0 w-4 border-t border-dashed border-usage-warn/45" aria-hidden="true" />
    </div>
  );
}

/**
 * One ranked-but-unaffordable card. Dimmed AND chipped: the dimming is the glance, the chip is the
 * answer — and it is the chip, never the opacity, that carries the reason for anyone the dimming
 * doesn't reach. The card stays fully interactive.
 */
export function BudgetWaiting({
  reason,
  className,
  children,
}: {
  reason: DeferReason;
  className?: string;
  children: ReactNode;
}) {
  const copy = REASON_COPY[reason];

  return (
    <div role="group" aria-label={`Waiting — ${copy.label}`} className={cn("flex flex-col gap-1", className)}>
      <MetaChip className="self-start">
        <HourglassIcon className="size-2.5" aria-hidden="true" />
        <span title={`Ranked but waiting: ${copy.blurb}`}>waiting · {copy.label}</span>
      </MetaChip>
      <div className="opacity-70 transition-opacity hover:opacity-100">{children}</div>
    </div>
  );
}

/** How often the lane re-reads the budget signal with no user action. Server-cached, so cheap. */
const REFRESH_MS = 60_000;

/**
 * Live budget signal for one project. Reads `/api/projects/<slug>/picker/budget` on mount and on
 * {@link REFRESH_MS}, treating `204 No Content` — not budget-aware, or usage unreadable — as "no
 * line". Fail-soft like the usage pill: a transient network error keeps the last known signal
 * rather than flickering the line away, but an explicit `204` clears it, because that is the
 * governor saying it has nothing to hold work on.
 */
export function useBudgetSignal(slug: string): BudgetSignal | null {
  const [signal, setSignal] = useState<BudgetSignal | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/projects/${slug}/picker/budget`, { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 204) {
          setSignal(null); // explicitly absent — omit the line rather than guess it
          return;
        }
        if (!res.ok) return; // transient error — keep last known good
        const data = (await res.json()) as BudgetSignal;
        if (!cancelled) setSignal(data);
      } catch {
        // network error / aborted — retry on the next tick, keep the current reading
      }
    }

    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [slug]);

  return signal;
}
