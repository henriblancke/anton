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

/**
 * Compact forward-looking countdown to a future ISO timestamp — "2h 15m", "45m", "3d 4h" —
 * for limit reset times in the usage popover. Returns `"now"` once the moment has passed and
 * `null` when unparseable. Complements {@link formatRelativeTime}, which looks backward.
 */
export function formatCountdown(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const s = Math.floor((ms - now) / 1000);
  if (s <= 0) return "now";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}
