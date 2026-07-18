/**
 * Client-safe usage types + the semantic ok/warn/crit ramp shared by the global nav pill.
 *
 * Mirrors the shape returned by `GET /api/usage` (see src/lib/claude/usage.ts) WITHOUT importing
 * that module — the data layer pulls in Node-only APIs (`node:child_process`, keychain reads) and
 * must never be dragged into a client bundle. Keep this file dependency-free and pure so the
 * threshold logic behind the pill's colors is unit-testable on its own.
 */

/** Normalized usage snapshot the pill consumes. Structurally matches `ClaudeUsage`. */
export interface UsageSnapshot {
  /** Current 5-hour session utilization, 0–100 percent. */
  sessionPct: number;
  /** Current week (all models) utilization, 0–100 percent. */
  weeklyPct: number;
  /** ISO-8601 timestamp the session limit resets, or null if unknown. */
  sessionResetAt: string | null;
  /** ISO-8601 timestamp the weekly limit resets, or null if unknown. */
  weeklyResetAt: string | null;
  /** Subscription plan (`max` / `pro` / …), or null if unknown. */
  plan: string | null;
}

/** The semantic severity of a utilization figure — deliberately not the indigo accent. */
export type UsageTone = "ok" | "warn" | "crit";

/** Utilization (percent) at which the ramp steps from ok → warn. */
export const USAGE_WARN_AT = 60;
/** Utilization (percent) at which the ramp steps from warn → crit. */
export const USAGE_CRIT_AT = 85;

/** Map a 0–100 utilization to its semantic tone by threshold. */
export function usageTone(pct: number): UsageTone {
  if (pct >= USAGE_CRIT_AT) return "crit";
  if (pct >= USAGE_WARN_AT) return "warn";
  return "ok";
}

/** Clamp any number into the 0–100 percent range a meter can render (NaN → 0). */
export function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

export interface TightestLimit {
  kind: "session" | "weekly";
  pct: number;
  resetAt: string | null;
}

/**
 * The tighter of the two limits — what the compact pill summarizes at a glance. Ties resolve to
 * the session limit (the one that frees up sooner), so the glance never overstates the squeeze.
 */
export function tightestLimit(usage: UsageSnapshot): TightestLimit {
  const session: TightestLimit = {
    kind: "session",
    pct: usage.sessionPct,
    resetAt: usage.sessionResetAt,
  };
  const weekly: TightestLimit = {
    kind: "weekly",
    pct: usage.weeklyPct,
    resetAt: usage.weeklyResetAt,
  };
  return weekly.pct > session.pct ? weekly : session;
}
