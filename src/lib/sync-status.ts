/**
 * Pure presentation-derivation for the beads↔Dolt sync badge (anton-rn88). Kept free of server
 * imports so the client SyncStatusBadge and its unit tests can both consume it.
 *
 * The registry (bd.ts) records raw facts — pass lifecycle, the unpushed-commit backlog, timestamps.
 * This collapses them into the one badge kind the operator sees, so a stuck push is never silent:
 *   - failing            a sync pass errored outright — the loud, prominent state
 *   - unpushed-retrying  inbound is current but local commits are queued and being retried
 *   - synced             caught up with the remote
 */
import type { SyncStatusView } from "./types";

export type SyncBadgeKind =
  | "unknown"
  | "not-wired"
  | "syncing"
  | "synced"
  | "unpushed-retrying"
  | "failing";

export function deriveSyncBadge(status: SyncStatusView): SyncBadgeKind {
  switch (status.state) {
    case "syncing":
      return "syncing";
    case "not-wired":
      return "not-wired";
    case "unknown":
      return "unknown";
    case "failing":
      // A failing pass is the loud state even with a backlog — the count rides along in the badge.
      return "failing";
    case "synced":
      // Inbound landed, but committed-but-unpushed work is still queued for the backstop to retry.
      return status.unpushedCount > 0 ? "unpushed-retrying" : "synced";
  }
}
