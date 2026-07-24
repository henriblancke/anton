"use client";

import { useEffect, useState } from "react";
import { SparklesIcon } from "lucide-react";

import { shouldNudgeShaping, type ShapingSignal } from "@/lib/usage";

/** How often the nudge re-reads its signal with no user action. Server-cached, so short is cheap. */
const REFRESH_MS = 60_000;

/**
 * Live shaping signal for the nudge. Reads `/api/usage/nudge` on mount and on {@link REFRESH_MS},
 * treating `204 No Content` (no usage read) as "hide". Fail-soft like the usage pill: a transient
 * network error keeps the last known signal rather than flashing the nudge.
 */
function useShapingSignal(): ShapingSignal | null {
  const [signal, setSignal] = useState<ShapingSignal | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/usage/nudge", { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 204) {
          setSignal(null); // explicitly absent — hide
          return;
        }
        if (!res.ok) return; // transient error — keep last known good
        const data = (await res.json()) as ShapingSignal;
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
  }, []);

  return signal;
}

/**
 * The backlog-starvation nudge (anton-eklj). Renders only when quota is idle but the ready backlog
 * is thin — behind weekly pace AND quota headroom AND a thin ready queue (see
 * {@link shouldNudgeShaping}). Pure (takes a resolved signal) so its every state renders
 * deterministically from mocked data. Informational only: it prompts shaping, it never generates
 * work.
 */
export function ShapingNudge({ signal }: { signal: ShapingSignal }) {
  if (!shouldNudgeShaping(signal)) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 rounded-lg border border-usage-warn/30 bg-usage-warn/5 px-2.5 py-2 text-[11px] leading-snug text-muted-foreground"
    >
      <SparklesIcon className="mt-px size-3.5 shrink-0 text-usage-warn" aria-hidden="true" />
      <span>
        ~<span className="font-mono font-medium tabular-nums text-foreground">{signal.weeklyRemainingPct}%</span>{" "}
        weekly left, backlog low — shape more?
      </span>
    </div>
  );
}

/**
 * Global shaping nudge for the nav. Renders nothing — no reserved slot, no layout shift — until a
 * live signal resolves, and stays hidden unless all three starvation conditions hold. Refreshes on
 * an interval with no user action.
 */
export function ShapingNudgePill() {
  const signal = useShapingSignal();
  if (!signal) return null;
  return <ShapingNudge signal={signal} />;
}
