"use client";

import { useEffect, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { clampPct, tightestLimit, usageTone, type UsageTone } from "@/lib/usage";
import { MeterTrack, UsageRow } from "@/components/usage/usage-pill";
import type { RouterUsageView } from "@/lib/claude/router-usage-view";

/** Mirrors the nav pill's own refresh cadence — the route is server-cached, so this collapses to
 * one upstream fetch. See src/lib/claude/usage.ts / router-usage.ts. */
const REFRESH_MS = 60_000;

const TONE_TEXT: Record<UsageTone, string> = {
  ok: "text-usage-ok",
  warn: "text-usage-warn",
  crit: "text-usage-crit",
};

const TONE_BORDER: Record<UsageTone, string> = {
  ok: "border-usage-ok/30",
  warn: "border-usage-warn/35",
  crit: "border-usage-crit/45",
};

/**
 * Live routed-meter view for one project. Reads `/api/projects/<slug>/router-usage` on mount and on
 * {@link REFRESH_MS}. A `204` means "not routed" (no gateway configured) — distinct from a routed
 * project whose router failed, which the route answers as a 200 body with `state: "unreadable"` so
 * that state is never confused with "nothing to show". Fail-soft to a network fault: keeps the last
 * known view rather than flashing the meter away for one bad poll.
 */
function useRouterUsage(slug: string): RouterUsageView | null {
  const [view, setView] = useState<RouterUsageView | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/projects/${slug}/router-usage`, { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 204) {
          setView(null); // not routed — nothing to show here, the nav pill already covers it
          return;
        }
        if (!res.ok) return; // transient error — keep last known good
        const data = (await res.json()) as RouterUsageView;
        if (!cancelled) setView(data);
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

  return view;
}

function DashboardLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="flex w-fit items-center gap-1 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
    >
      Open router dashboard
      <ExternalLinkIcon className="size-3" aria-hidden="true" />
    </a>
  );
}

/** The unreadable-router state: a stated unknown naming what to check, never an empty or zeroed
 * meter (anton-ds7e acceptance) — so it gets its own trigger rather than reusing the meter's. */
function UnreadableRouterPill({
  endpointHost,
  connectionId,
  dashboardUrl,
}: {
  endpointHost: string;
  connectionId: string;
  dashboardUrl: string;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={`Router quota unknown for ${endpointHost}`}
        className="group flex items-center gap-2 rounded-lg border border-usage-warn/35 bg-card px-2.5 py-1.5 text-left transition-colors hover:border-usage-warn/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <TriangleAlertIcon className="size-3.5 shrink-0 text-usage-warn" aria-hidden="true" />
        <span className="font-mono text-[10px] tracking-[0.04em] text-usage-warn uppercase">
          router quota unknown
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} className="z-50">
          <Popover.Popup className="w-72 rounded-xl border border-border bg-popover p-3.5 text-popover-foreground shadow-lg ring-1 ring-foreground/5 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none">
            <Popover.Title className="mb-2 font-heading text-[13px] font-medium">
              Router quota unknown
            </Popover.Title>
            <p className="text-[11px] text-subtle">
              Couldn&apos;t read usage from{" "}
              <code className="font-mono text-[11px] text-foreground">{endpointHost}</code> for
              connection{" "}
              <code className="font-mono text-[11px] text-foreground">{connectionId}</code>. Check
              the router is reachable and the connection id is still valid.
            </p>
            <div className="mt-3">
              <DashboardLink url={dashboardUrl} />
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The project's own routed meter (anton-ds7e) — what actually governs this project's quota when it
 * is pointed at a gateway. Mirrors the nav pill's pill-and-popover shape (`UsageMeter`) so the two
 * read as the same kind of thing, but is never the same meter: this one is labelled with the
 * endpoint host and the collapse rule, and links the router's own dashboard for per-provider detail
 * — the global pill keeps reading the Anthropic subscription untouched.
 */
function RoutedQuotaPill({
  view,
}: {
  view: Extract<RouterUsageView, { state: "ok" }>;
}) {
  const tightest = tightestLimit(view.usage);
  const pct = clampPct(tightest.pct);
  const rounded = Math.round(pct);
  const tone = usageTone(pct);

  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={`Routed quota via ${view.endpointHost} — ${tightest.kind} limit ${rounded}% used`}
        className={cn(
          "group flex items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-left transition-colors hover:border-ring/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          TONE_BORDER[tone],
        )}
      >
        <span className="font-mono text-[10px] tracking-[0.04em] text-subtle uppercase">
          router quota
        </span>
        <MeterTrack pct={pct} tone={tone} className="h-1.5 w-14" />
        <span className={cn("shrink-0 font-mono text-[11px] font-medium tabular-nums", TONE_TEXT[tone])}>
          {rounded}%
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} className="z-50">
          <Popover.Popup className="w-72 rounded-xl border border-border bg-popover p-3.5 text-popover-foreground shadow-lg ring-1 ring-foreground/5 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none">
            <div className="mb-1 flex items-center justify-between gap-2">
              <Popover.Title className="font-heading text-[13px] font-medium">
                Routed quota
              </Popover.Title>
              {view.usage.plan && (
                <span className="font-mono text-[10px] tracking-[0.04em] text-subtle uppercase">
                  {view.usage.plan}
                </span>
              )}
            </div>
            <p className="mb-3 text-[10.5px] text-subtle">
              via <code className="font-mono text-[10.5px] text-foreground">{view.endpointHost}</code>{" "}
              · connection{" "}
              <code className="font-mono text-[10.5px] text-foreground">{view.connectionId}</code>
            </p>
            <div className="flex flex-col gap-3">
              <UsageRow
                label="Session · 5h"
                pct={view.usage.sessionPct}
                resetAt={view.usage.sessionResetAt}
              />
              <UsageRow
                label="Weekly · all models"
                pct={view.usage.weeklyPct}
                resetAt={view.usage.weeklyResetAt}
              />
            </div>
            <p className="mt-3 text-[10.5px] text-subtle">
              This project meters on <strong className="font-medium text-foreground">one</strong>{" "}
              router connection, never a sum across connections.
            </p>
            <div className="mt-2">
              <DashboardLink url={view.dashboardUrl} />
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The routed project's own meter on the project view (anton-ds7e) — distinct from the global nav
 * pill, which stays machine-wide and keeps reading the Anthropic subscription. Renders nothing for
 * an unrouted project: showing a second meter here that measures nothing routed would be exactly
 * the "pill pretending to be two meters at once" this ticket exists to end.
 */
export function RouterUsageMeter({ slug }: { slug: string }) {
  const view = useRouterUsage(slug);
  if (!view) return null;

  switch (view.state) {
    case "unreadable":
      return (
        <UnreadableRouterPill
          endpointHost={view.endpointHost}
          connectionId={view.connectionId}
          dashboardUrl={view.dashboardUrl}
        />
      );
    case "ok":
      return <RoutedQuotaPill view={view} />;
    default:
      // `unrouted`, or a shape this client doesn't recognize (a stale poll racing a schema
      // change) — say nothing rather than render off a snapshot that isn't there.
      return null;
  }
}
