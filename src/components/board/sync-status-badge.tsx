"use client";

import { CloudOffIcon, LoaderIcon, TriangleAlertIcon, UploadIcon } from "lucide-react";
import { deriveSyncBadge } from "@/lib/sync-status";
import type { SyncStatusView } from "@/lib/types";
import { cn } from "@/lib/utils";

function ago(msEpoch: number): string {
  const s = Math.max(0, Math.round((Date.now() - msEpoch) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** "1 unpushed" / "3 unpushed" — the operator-visible backlog count. */
function unpushedLabel(n: number): string {
  return `${n} unpushed`;
}

const base =
  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium";

/**
 * Per-project beads↔Dolt sync health, rendered next to the board. Every state is visible and
 * truthful: a project with no shared remote shows "not wired"; committed-but-unpushed work shows a
 * live count that a heartbeat is retrying; and an outright sync failure is prominent, never a subtle
 * chip — so a stuck push is impossible to miss without reading server logs (anton-rn88).
 */
export function SyncStatusBadge({ sync }: { sync: SyncStatusView }) {
  switch (deriveSyncBadge(sync)) {
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
    case "unpushed-retrying":
      return (
        <span
          className={cn(base, "border-amber-500/40 text-amber-600 dark:text-amber-400")}
          title={`${unpushedLabel(sync.unpushedCount)} local change${
            sync.unpushedCount === 1 ? "" : "s"
          } committed but not yet pushed to the shared remote — retrying on the next heartbeat.${
            sync.lastPushedAt ? ` Last pushed ${ago(sync.lastPushedAt)}.` : ""
          }`}
        >
          <UploadIcon className="size-3" aria-hidden="true" />⚠ {unpushedLabel(sync.unpushedCount)} · retrying
        </span>
      );
    case "failing":
      return (
        <span
          className={cn(
            base,
            "border-destructive bg-destructive/10 font-semibold text-destructive",
          )}
          title={sync.lastError ?? undefined}
        >
          <TriangleAlertIcon className="size-3.5" aria-hidden="true" />
          Sync failing
          {sync.unpushedCount > 0 ? ` · ${unpushedLabel(sync.unpushedCount)}` : ""}
          {sync.lastPushedAt ? ` · last pushed ${ago(sync.lastPushedAt)}` : ""}
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
