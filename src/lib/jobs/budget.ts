/**
 * Budget governor + pace-line (anton-7tcc). The keystone arbiter: from live Claude usage, a
 * policy, and the clock it decides whether autonomous work may start *now* or must defer (with a
 * `retryAt`). It reconciles two pulls — "spend the whole weekly plan" vs "keep a daytime reserve /
 * prefer nights" — along a single pace-line.
 *
 * Pure + injected clock (mirrors `nextAction` in ./runner): no timers, no I/O, `now` is a plain
 * epoch-ms argument, so every branch is unit-testable deterministically.
 *
 * The three defer reasons, in priority order:
 *   • session-headroom — the 5-hour session is nearly exhausted; a hard floor that outranks the
 *     weekly plan (never burn the last sliver of a session). Defers to the session reset.
 *   • weekly-on-track  — usage is *ahead* of where the pace-line says it should be for this point
 *     in the week (a front-loaded burst). Ease off until the pace-line catches up, day OR night.
 *   • daytime-reserve  — inside the day window with the session running low: hold the remaining
 *     session for interactive daytime use and defer to tonight — UNLESS we're *behind* pace, in
 *     which case work spills into the day to hit the weekly plan.
 *
 * Fail-open is the master rule: a null usage read (missing creds, offline, a broken fetch) admits,
 * so a degraded read never halts anton.
 */
import type { ClaudeUsage } from "../claude/usage";

/** Why work was deferred. The runner/admission-gate surfaces this to the operator. */
export type DeferReason = "session-headroom" | "daytime-reserve" | "weekly-on-track";

/**
 * Operator-tunable pace policy. Percentages are 0–100 (same scale as {@link ClaudeUsage}). The
 * day window uses a fixed UTC offset rather than an IANA zone deliberately: it keeps the function
 * pure and DST-free, and "prefer nights" doesn't need sub-hour precision. Persistence and a config
 * UI are a separate ticket — tests build these by hand.
 */
export interface BudgetPolicy {
  /** Hard session floor: defer once `sessionPct >= 100 - this`. Protects the tail of a session. */
  minSessionHeadroomPct: number;
  /** Daytime session reserve: during the day, defer once `sessionPct >= 100 - this`. */
  daytimeReservePct: number;
  /** Local hour [0,24) the day window opens. */
  dayStartHour: number;
  /** Local hour [0,24) the day window closes (night begins). Assumed > `dayStartHour`. */
  dayEndHour: number;
  /** Offset applied to the clock to derive local hour/boundaries (e.g. -420 for PDT). */
  utcOffsetMinutes: number;
  /** Target weekly utilization by the week's reset — the "spend the whole plan" line. */
  weeklyTargetPct: number;
  /** Dead-band around the pace-line, applied to both sides (behind and ahead). */
  paceSlackPct: number;
  /** Length of the weekly window backing the pace math (Claude's is 7 days). */
  weekMs: number;
  /** Fallback session-reset horizon when `sessionResetAt` is unknown (Claude's window is 5h). */
  sessionWindowMs: number;
}

/**
 * The gate's verdict. `admit` is the discriminant; a defer carries the reason and the earliest
 * time work should be reconsidered so the caller can reschedule instead of busy-polling.
 */
export type BudgetDecision =
  | { admit: true }
  | { admit: false; retryAt: Date; reason: DeferReason };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
  minSessionHeadroomPct: 5,
  daytimeReservePct: 40,
  dayStartHour: 8,
  dayEndHour: 22,
  utcOffsetMinutes: 0,
  weeklyTargetPct: 100,
  paceSlackPct: 5,
  weekMs: 7 * DAY_MS,
  sessionWindowMs: 5 * HOUR_MS,
};

/** Local hour-of-day (fractional, [0,24)) under the policy's fixed offset. */
function localHour(nowMs: number, offsetMinutes: number): number {
  const localMs = nowMs + offsetMinutes * 60_000;
  const msIntoDay = ((localMs % DAY_MS) + DAY_MS) % DAY_MS;
  return msIntoDay / HOUR_MS;
}

/** The next epoch-ms at which the day window closes (local `dayEndHour`) — the night boundary. */
function nextNightBoundary(nowMs: number, policy: BudgetPolicy): number {
  const offsetMs = policy.utcOffsetMinutes * 60_000;
  const localMs = nowMs + offsetMs;
  const localMidnight = localMs - (((localMs % DAY_MS) + DAY_MS) % DAY_MS);
  let boundaryLocal = localMidnight + policy.dayEndHour * HOUR_MS;
  if (localMs >= boundaryLocal) boundaryLocal += DAY_MS; // already past tonight → tomorrow's
  return boundaryLocal - offsetMs;
}

/** Fraction of the current week elapsed at `now`, in [0,1], derived from the weekly reset time. */
function elapsedWeekFraction(nowMs: number, weeklyResetAtMs: number, weekMs: number): number {
  const remaining = (weeklyResetAtMs - nowMs) / weekMs;
  return Math.min(1, Math.max(0, 1 - remaining));
}

/**
 * When (epoch-ms) the pace-line rises to meet current usage, i.e. the earliest time we're no
 * longer ahead of plan. Clamped to (now, weeklyResetAt]; at the reset the week refreshes anyway.
 */
function paceCatchUp(
  weeklyPct: number,
  weeklyResetAtMs: number,
  policy: BudgetPolicy,
): number {
  const targetElapsed = (weeklyPct - policy.paceSlackPct) / policy.weeklyTargetPct;
  const weekStart = weeklyResetAtMs - policy.weekMs;
  const t = weekStart + targetElapsed * policy.weekMs;
  return Math.min(weeklyResetAtMs, t);
}

/**
 * Decide whether autonomous work may start now. See the module header for the reason ordering.
 * `now` is epoch-ms (injected for tests). A null `usage` fails OPEN — a broken read never halts.
 */
export function budgetGate(
  usage: ClaudeUsage | null,
  policy: BudgetPolicy,
  now: number,
): BudgetDecision {
  if (!usage) return { admit: true };

  // 1. Session floor — hard limit, outranks the weekly plan. Defer to the known reset, or a
  //    session-window horizon when the reset time is missing (the 5h window bounds the wait).
  if (usage.sessionPct >= 100 - policy.minSessionHeadroomPct) {
    const resetMs = usage.sessionResetAt
      ? Date.parse(usage.sessionResetAt)
      : NaN;
    const retryAt = Number.isNaN(resetMs) ? new Date(now + policy.sessionWindowMs) : new Date(resetMs);
    return { admit: false, retryAt, reason: "session-headroom" };
  }

  // Pace-line: where should weekly usage be by now, and are we behind/ahead of it? Only computable
  // when the weekly reset is known; without it we run without pace (behind/ahead both false), so
  // the daytime reserve holds conservatively and there's no ahead-of-pace defer.
  const weeklyResetMs = usage.weeklyResetAt ? Date.parse(usage.weeklyResetAt) : NaN;
  const havePace = !Number.isNaN(weeklyResetMs) && policy.weeklyTargetPct > 0;
  let behindPace = false;
  let aheadPace = false;
  if (havePace) {
    const expectedPct =
      policy.weeklyTargetPct * elapsedWeekFraction(now, weeklyResetMs, policy.weekMs);
    behindPace = usage.weeklyPct < expectedPct - policy.paceSlackPct;
    aheadPace = usage.weeklyPct > expectedPct + policy.paceSlackPct;
  }

  // 2. Ahead of the weekly plan (a front-loaded burst): ease off until the pace-line catches up.
  //    Applies day and night — it's about the weekly budget, not the daily reserve.
  if (aheadPace) {
    return {
      admit: false,
      retryAt: new Date(paceCatchUp(usage.weeklyPct, weeklyResetMs, policy)),
      reason: "weekly-on-track",
    };
  }

  // 3. Daytime reserve: inside the day window with the session running low, hold what's left for
  //    interactive daytime use and defer to tonight — unless we're behind the weekly plan, in
  //    which case work spills into the day to hit the target.
  const hour = localHour(now, policy.utcOffsetMinutes);
  const inDayWindow = hour >= policy.dayStartHour && hour < policy.dayEndHour;
  if (inDayWindow && usage.sessionPct >= 100 - policy.daytimeReservePct && !behindPace) {
    return {
      admit: false,
      retryAt: new Date(nextNightBoundary(now, policy)),
      reason: "daytime-reserve",
    };
  }

  return { admit: true };
}
