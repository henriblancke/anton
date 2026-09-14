/**
 * Shared time formatting for the "created" metadata surfaced on tickets and epics.
 * One helper so ticket detail, tickets list, and epic detail never diverge in wording.
 */

/**
 * The one locale every user-facing date and time in anton is formatted in (anton-icda).
 *
 * Pinned rather than host-derived, because a host-derived locale is not one locale: `toLocale*` with
 * no locale resolves to the *server's* during SSR and the *browser's* on the client, so any client
 * component that server-renders can hydrate to different text. Pinning settles that by construction
 * instead of asking every call site to prove it never SSRs, and keeps dates identical across tests,
 * screenshots, and machines whatever `LANG` the server booted under. anton's UI is English-only —
 * i18n is deliberately out of scope — so a host locale would only reorder dates beneath labels that
 * stay English regardless.
 *
 * The **timezone** is deliberately NOT pinned. anton runs on the operator's own machine, so times
 * should read in their own clock; that axis can't diverge the way locale can.
 *
 * Enforced by lint (`no-restricted-syntax` in eslint.config.mjs) so new call sites can't drift back
 * to the host locale. See docs/ui-brief.md → Foundations.
 */
export const DISPLAY_LOCALE = "en-US";

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
  return new Date(ms).toLocaleString(DISPLAY_LOCALE, {
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
