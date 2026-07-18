"use client";

import { useEffect, useState } from "react";
import { Popover } from "@base-ui/react/popover";

import { cn } from "@/lib/utils";
import { formatCountdown, formatExactTime } from "@/lib/time";
import {
  clampPct,
  tightestLimit,
  usageTone,
  type UsageSnapshot,
  type UsageTone,
} from "@/lib/usage";

/** How often the pill re-reads live usage with no user action. The route is server-cached, so a
 * short client interval collapses to one upstream fetch — see src/lib/claude/usage.ts. */
const REFRESH_MS = 60_000;

const TONE_TEXT: Record<UsageTone, string> = {
  ok: "text-usage-ok",
  warn: "text-usage-warn",
  crit: "text-usage-crit",
};

const TONE_FILL: Record<UsageTone, string> = {
  ok: "bg-usage-ok",
  warn: "bg-usage-warn",
  crit: "bg-usage-crit",
};

const TONE_BORDER: Record<UsageTone, string> = {
  ok: "border-usage-ok/30",
  warn: "border-usage-warn/35",
  crit: "border-usage-crit/45",
};

/**
 * Live usage for the pill. Reads `/api/usage` on mount and on {@link REFRESH_MS}, treating the
 * route's `204 No Content` (flag off / no creds / upstream down) as "hide". Fail-soft to a fault:
 * a transient network error keeps the last known value rather than flashing the pill away.
 */
function useClaudeUsage(): UsageSnapshot | null {
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/usage", { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 204) {
          setUsage(null); // explicitly absent — hide the pill
          return;
        }
        if (!res.ok) return; // transient error — keep last known good
        const data = (await res.json()) as UsageSnapshot;
        if (!cancelled) setUsage(data);
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

  return usage;
}

/** The meter fill track shared by the pill and the popover rows. Width transition is disabled
 * under `prefers-reduced-motion`; the track keeps a neutral bg so a 0% bar is still legible. */
function MeterTrack({ pct, tone, className }: { pct: number; tone: UsageTone; className?: string }) {
  return (
    <span className={cn("relative block overflow-hidden rounded-full bg-muted", className)}>
      <span
        className={cn(
          "absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-out motion-reduce:transition-none",
          TONE_FILL[tone],
        )}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

/** One labelled limit row in the popover: name, % used, meter, and (relative + absolute) reset. */
export function UsageRow({
  label,
  pct,
  resetAt,
}: {
  label: string;
  pct: number;
  resetAt: string | null;
}) {
  const clamped = clampPct(pct);
  const rounded = Math.round(clamped);
  const tone = usageTone(clamped);
  const countdown = formatCountdown(resetAt);
  const exact = formatExactTime(resetAt);

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span className={cn("font-mono text-[11px] font-medium tabular-nums", TONE_TEXT[tone])}>
          {rounded}% used
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={rounded}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} — ${rounded}% used`}
      >
        <MeterTrack pct={clamped} tone={tone} className="h-1.5" />
      </div>
      {countdown && (
        <p className="mt-1 font-mono text-[10px] text-subtle">
          resets in {countdown}
          {exact ? ` · ${exact}` : ""}
        </p>
      )}
    </div>
  );
}

/**
 * The always-on glance: a compact meter pill summarizing the tightest active limit, opening a
 * popover with the full session + weekly breakdown. Pure (takes a resolved snapshot) so its
 * every state renders deterministically from mocked data.
 */
export function UsageMeter({ usage }: { usage: UsageSnapshot }) {
  const tightest = tightestLimit(usage);
  const pct = clampPct(tightest.pct);
  const rounded = Math.round(pct);
  const tone = usageTone(pct);

  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={`Claude usage — ${tightest.kind} limit ${rounded}% used`}
        className={cn(
          "group flex w-full items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-left transition-colors hover:border-ring/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          TONE_BORDER[tone],
        )}
      >
        <span className="font-mono text-[10px] tracking-[0.04em] text-subtle uppercase">usage</span>
        <MeterTrack pct={pct} tone={tone} className="h-1.5 flex-1" />
        <span
          className={cn(
            "shrink-0 font-mono text-[11px] font-medium tabular-nums",
            TONE_TEXT[tone],
          )}
        >
          {rounded}%
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={8} className="z-50">
          <Popover.Popup
            className={cn(
              "w-64 rounded-xl border border-border bg-popover p-3.5 text-popover-foreground shadow-lg ring-1 ring-foreground/5 outline-none",
              "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none",
            )}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <Popover.Title className="font-heading text-[13px] font-medium">
                Claude usage
              </Popover.Title>
              {usage.plan && (
                <span className="font-mono text-[10px] tracking-[0.04em] text-subtle uppercase">
                  {usage.plan}
                </span>
              )}
            </div>
            <div className="flex flex-col gap-3">
              <UsageRow label="Session · 5h" pct={usage.sessionPct} resetAt={usage.sessionResetAt} />
              <UsageRow
                label="Weekly · all models"
                pct={usage.weeklyPct}
                resetAt={usage.weeklyResetAt}
              />
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * Global usage pill for the nav. Renders nothing — no reserved slot, no layout shift — until live
 * usage resolves, and hides again if the API later reports absence. Refreshes on an interval with
 * no user action.
 */
export function UsagePill() {
  const usage = useClaudeUsage();
  if (!usage) return null;
  return <UsageMeter usage={usage} />;
}
