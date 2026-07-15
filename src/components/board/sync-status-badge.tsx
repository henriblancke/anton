"use client";

import { CloudOffIcon, LoaderIcon, TriangleAlertIcon } from "lucide-react";
import type { SyncStatusView } from "@/lib/types";
import { cn } from "@/lib/utils";

function ago(msEpoch: number): string {
  const s = Math.max(0, Math.round((Date.now() - msEpoch) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/**
 * Per-project beads↔Dolt sync health, rendered next to the board. Every state is visible —
 * a project with no shared remote shows "not wired", never a silent local-only mode.
 */
export function SyncStatusBadge({ sync }: { sync: SyncStatusView }) {
  const base =
    "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium";
  switch (sync.state) {
    case "synced":
      return (
        <span className={cn(base, "border-emerald-500/30 text-emerald-600 dark:text-emerald-400")}>
          <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
          Live{sync.lastSyncedAt ? ` · synced ${ago(sync.lastSyncedAt)}` : ""}
        </span>
      );
    case "syncing":
      return (
        <span className={cn(base, "border-muted-foreground/30 text-muted-foreground")}>
          <LoaderIcon className="size-3 animate-spin" aria-hidden="true" />
          Syncing…
        </span>
      );
    case "failing":
      return (
        <span
          className={cn(base, "border-destructive/40 text-destructive")}
          title={sync.lastError ?? undefined}
        >
          <TriangleAlertIcon className="size-3" aria-hidden="true" />
          Sync failing{sync.lastSyncedAt ? ` · last synced ${ago(sync.lastSyncedAt)}` : ""}
        </span>
      );
    case "not-wired":
      return (
        <span
          className={cn(base, "border-amber-500/40 text-amber-600 dark:text-amber-400")}
          title="No Dolt remote configured for this project's beads — changes stay local. Run `anton init` in the repo to wire one."
        >
          <CloudOffIcon className="size-3" aria-hidden="true" />
          Not wired to shared remote
        </span>
      );
    default:
      return null; // unknown: engine hasn't reported yet — say nothing rather than guess
  }
}
