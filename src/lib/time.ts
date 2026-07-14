/**
 * Shared time formatting for the "created" metadata surfaced on tickets and epics.
 * One helper so ticket detail, tickets list, and epic detail never diverge in wording.
 */

/** Compact "3m ago" / "2h ago" / "5d ago" from an ISO timestamp. `null` when unparseable. */
export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Full, human-readable timestamp for the hover title. `null` when unparseable. */
export function formatExactTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
