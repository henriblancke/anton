/**
 * Budget governor (anton-7tcc). The keystone arbiter: from live Claude usage, a policy, and the
 * clock it decides whether autonomous work may start *now* or must defer (with a `retryAt`).
 *
 * The model is **idle-fill** (anton-ld7j): the whole point is to soak up otherwise-idle weekly
 * quota — capacity that resets unused each week and is simply wasted if not spent — so spare weekly
 * budget is used freely, and only the real limits push back. The weekly plan is a *ceiling*, not an
 * even-pace rail: run below it, throttle only the last stretch so it lasts to the reset, stop at it.
 * A productive early-week burst is NOT benched just for being ahead of an even line. A daytime
 * reserve still holds the tail of the *session* for interactive use, so anton doesn't eat the last
 * of your 5-hour window out from under you during the day.
 *
 * Pure + injected clock (mirrors `nextAction` in ./runner): no timers, no I/O, `now` is a plain
 * epoch-ms argument, so every branch is unit-testable deterministically.
 *
 * The defer reasons, in priority order:
 *   • session-headroom — the 5-hour session is nearly exhausted; a hard floor that outranks the
 *     weekly plan (never burn the last sliver of a session). Defers to the session reset.
 *   • weekly-cap       — weekly usage has hit the cap (the operator's weekly budget). Stop until the
 *     weekly window resets, protecting the reserve (100 − cap) and Claude's own hard limit.
 *   • weekly-on-track  — inside the throttle band just below the cap AND *ahead* of the even
 *     pace-line: ease off until the line catches up, so the last stretch of budget lasts to reset.
 *   • daytime-reserve  — inside the day window with the session running low: hold the remaining
 *     session for interactive daytime use and defer to tonight — UNLESS we're *behind* pace, in
 *     which case work spills into the day.
 *
 * Fail-open is the master rule: a null usage read (missing creds, offline, a broken fetch) admits,
 * so a degraded read never halts anton.
 */
import type { ClaudeUsage } from "../claude/usage";

/** Why work was deferred. The runner/admission-gate surfaces this to the operator. */
export type DeferReason = "session-headroom" | "weekly-cap" | "weekly-on-track" | "daytime-reserve";

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
  /**
   * Weekly cap: the ceiling on weekly utilization anton will spend on autonomous work (idle-fill,
   * anton-ld7j). At/above it work stops until the weekly resets, protecting the reserve (100 − this)
   * and Claude's own hard limit. Below the {@link throttleBandPct} band it's spent freely.
   */
  weeklyTargetPct: number;
  /**
   * Throttle band (percentage points below the cap) where pacing engages (anton-ld7j). In
   * `[cap − this, cap)` anton paces against the even line so the last stretch lasts to the reset;
   * below `cap − this` it's pure idle-fill (run freely). Internal — not an operator knob.
   */
  throttleBandPct: number;
  /** Dead-band around the pace-line, applied to both sides (behind and ahead). */
  paceSlackPct: number;
  /** Length of the weekly window backing the pace math (Claude's is 7 days). */
  weekMs: number;
  /** Fallback session-reset horizon when `sessionResetAt` is unknown (Claude's window is 5h). */
  sessionWindowMs: number;

  // ── Pace-modulated prioritization (anton-k05r) ──
  // A second, finer gate layered on {@link budgetGate}: once work MAY run, which jobs are worth
  // admitting *now*. Pace-state (plus session headroom) sets a minimum value threshold; a job's
  // value comes from its bead labels. Scarce budget → only high-value; abundant → down to cleanup.

  /** Age window backing {@link jobValueScore}'s tie-break: a job this old scores the full age band. */
  valueAgeWindowMs: number;
  /** Session headroom% at/below which budget is "scarce" (high-value only), even absent an ahead-of-pace read. */
  scarceHeadroomPct: number;
  /** Session headroom% at/above which budget is "abundant" (admit down to cleanup), absent a behind-pace read. */
  abundantHeadroomPct: number;
  /** Value threshold when scarce/ahead-of-pace — matches the risk:high band, so only high-value admits. */
  valueThresholdScarce: number;
  /** Value threshold on-pace — matches the blocking-PR band, so cleanup waits but urgent work runs. */
  valueThresholdNormal: number;
  /** Value threshold when abundant/behind-pace — admit everything, including low-value cleanup. */
  valueThresholdAbundant: number;
  /** Max threshold reduction at night, scaled by job cost — night lowers the bar for heavy/long jobs. */
  nightValueDiscount: number;
  /** Session%-cost at/above which a night job earns the full {@link nightValueDiscount} (heavy = long). */
  nightHeavyCostPct: number;
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
  throttleBandPct: 20,
  paceSlackPct: 5,
  weekMs: 7 * DAY_MS,
  sessionWindowMs: 5 * HOUR_MS,
  valueAgeWindowMs: 7 * DAY_MS,
  scarceHeadroomPct: 20,
  abundantHeadroomPct: 60,
  valueThresholdScarce: 0.8,
  valueThresholdNormal: 0.5,
  valueThresholdAbundant: 0,
  nightValueDiscount: 0.3,
  nightHeavyCostPct: 15,
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
 * longer ahead of plan. Capped at `weeklyResetAt` — at the reset the week refreshes anyway. No
 * lower bound is needed: the only caller runs on `aheadPace`, which guarantees the catch-up time
 * is in the future.
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
 * Where the weekly pace-line sits relative to current usage. `weeklyResetMs` is carried (NaN when
 * unknown) so callers that defer on ahead-of-pace can compute the catch-up time without re-parsing.
 */
interface Pace {
  behindPace: boolean;
  aheadPace: boolean;
  havePace: boolean;
  weeklyResetMs: number;
}

/**
 * Behind/ahead of the weekly pace-line at `now`. Only computable when the weekly reset is known;
 * without it we run without pace (behind/ahead both false), so the daytime reserve holds
 * conservatively and there's no ahead-of-pace defer. Shared by {@link budgetGate} (coarse: work at
 * all?) and {@link admitJob} (fine: which jobs are worth admitting now?).
 */
function computePace(usage: ClaudeUsage, policy: BudgetPolicy, now: number): Pace {
  const weeklyResetMs = usage.weeklyResetAt ? Date.parse(usage.weeklyResetAt) : NaN;
  const havePace = !Number.isNaN(weeklyResetMs) && policy.weeklyTargetPct > 0;
  if (!havePace) return { behindPace: false, aheadPace: false, havePace: false, weeklyResetMs };
  const expectedPct = policy.weeklyTargetPct * elapsedWeekFraction(now, weeklyResetMs, policy.weekMs);
  return {
    behindPace: usage.weeklyPct < expectedPct - policy.paceSlackPct,
    aheadPace: usage.weeklyPct > expectedPct + policy.paceSlackPct,
    havePace: true,
    weeklyResetMs,
  };
}

/**
 * Whether weekly usage is *behind* the pace-line at `now` — the plan still has room this week.
 * Exposed for the shaping nudge (anton-eklj), which only prompts the operator to shape more when
 * quota is genuinely idle. A null usage read means the pace is unknown, so it returns false: we
 * never nag on a guess.
 */
export function isBehindPace(usage: ClaudeUsage | null, policy: BudgetPolicy, now: number): boolean {
  if (!usage) return false;
  return computePace(usage, policy, now).behindPace;
}

/** True when `now` falls outside the policy's day window — the preferred window for heavy work. */
function isNight(now: number, policy: BudgetPolicy): boolean {
  const hour = localHour(now, policy.utcOffsetMinutes);
  return !(hour >= policy.dayStartHour && hour < policy.dayEndHour);
}

/**
 * Decide whether autonomous work may start now. See the module header for the reason ordering.
 * `now` is epoch-ms (injected for tests). A null `usage` fails OPEN — a broken read never halts.
 *
 * `opts.skipPacing` is the "run directly" bypass (anton-d8i4): an epic the operator approved for
 * immediate execution skips the weekly (cap/throttle) and daytime-reserve *pacing* holds but NOT the
 * session-headroom floor — that hard limit still protects the tail of a 5-hour session, so an
 * immediate run can't blow past the cap it would only hit mid-run. With it set, the gate admits as
 * soon as the session floor clears.
 */
export function budgetGate(
  usage: ClaudeUsage | null,
  policy: BudgetPolicy,
  now: number,
  opts?: { skipPacing?: boolean },
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

  // Run-directly (immediate approval): only the session floor above holds it — weekly/daytime pacing
  // is deliberately skipped, so an operator who asked for "now" gets it the moment the session allows.
  if (opts?.skipPacing) return { admit: true };

  const { behindPace, aheadPace, weeklyResetMs } = computePace(usage, policy, now);

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

// ── Pace-modulated prioritization (anton-k05r) ──────────────────────────────────────────────────
// Once budgetGate says work MAY run, this finer gate decides which jobs are worth admitting *now*.
// A job's value comes from its bead labels; pace-state (plus session headroom) sets a minimum value
// threshold. Scarce budget → high-value only; abundant → drain low-value cleanup; night lowers the
// bar for heavy jobs. This governs anton's own admission order only — it never forks beads' board.

/** Bead label marking the highest-value work — a risky change that must land before it rots. */
export const VALUE_LABEL_RISK_HIGH = "risk:high";
/** Bead label marking work that unblocks an open PR — high value, below risk:high. */
export const VALUE_LABEL_BLOCKING_PR = "blocking-PR";

/** The inputs to {@link jobValueScore}: a bead's labels and how long the work has waited. */
export interface JobValueInput {
  /** The bead's labels (e.g. `risk:high`, `blocking-PR`, `size:M`). */
  labels: readonly string[];
  /** How long the job has been waiting, in ms. Older work scores higher within its band. */
  ageMs?: number;
}

/**
 * Score a job's value in [0,1] from its bead labels, with age as a within-band tie-break. The bands
 * are disjoint so the ordering `risk:high > blocking-PR > age` is total: any risk:high job outranks
 * any blocking-PR job, which outranks any unlabeled job however old. Age only breaks ties among
 * peers — a week-old cleanup job never overtakes a fresh blocking-PR one.
 *
 *   • risk:high    → [0.8, 1.0]
 *   • blocking-PR  → [0.5, 0.7]
 *   • otherwise    → [0.0, 0.4]  (pure age; this is the "low-value cleanup" band)
 */
export function jobValueScore(input: JobValueInput, policy: BudgetPolicy): number {
  const ageFrac =
    policy.valueAgeWindowMs > 0
      ? Math.min(1, Math.max(0, (input.ageMs ?? 0) / policy.valueAgeWindowMs))
      : 0;
  if (input.labels.includes(VALUE_LABEL_RISK_HIGH)) return 0.8 + 0.2 * ageFrac;
  if (input.labels.includes(VALUE_LABEL_BLOCKING_PR)) return 0.5 + 0.2 * ageFrac;
  return 0.4 * ageFrac;
}

/** A job as the admission gate sees it: its value score and its projected session%-cost to run. */
export interface GovernedJob {
  /** Value in [0,1] from {@link jobValueScore}. */
  value: number;
  /** Projected session%-cost of running this job now — the sampler's per-type burn average. */
  sessionCost: number;
}

/** Why {@link admitJob} held a job, or that it admitted. */
export type AdmitReason = "admitted" | "value-below-threshold" | "cost-exceeds-headroom";

/** The value gate's verdict, carrying the threshold that was applied for observability. */
export interface AdmitDecision {
  admit: boolean;
  /** The minimum value threshold in effect for this decision. */
  threshold: number;
  reason: AdmitReason;
}

/**
 * Decide whether a single job clears the current value bar. `budgetGate` decides *whether* to work;
 * this decides *what* to spend the budget on. Fail-open on a null usage read (mirrors budgetGate) —
 * a broken meter must never starve the queue.
 *
 * The threshold moves with the budget's scarcity:
 *   • scarce   (ahead-of-pace OR session headroom ≤ scarceHeadroomPct)   → high-value only
 *   • abundant (behind-pace OR session headroom ≥ abundantHeadroomPct)   → admit down to cleanup
 *   • on-pace  (neither)                                                 → the normal bar
 * Scarce wins ties: being ahead of plan holds the line even if the session looks fresh.
 *
 * Night lowers the bar for heavy/long jobs — the preferred window, so a big burner that would wait
 * behind higher-value work by day can run at night. And when budget is scarce, a job whose cost
 * overruns what's left of the session is held regardless of value: it can't fit, so admitting it
 * would just exhaust the session mid-run.
 */
export function admitJob(
  usage: ClaudeUsage | null,
  policy: BudgetPolicy,
  now: number,
  job: GovernedJob,
): AdmitDecision {
  if (!usage) return { admit: true, threshold: 0, reason: "admitted" };

  const { behindPace, aheadPace } = computePace(usage, policy, now);
  const headroomPct = 100 - usage.sessionPct;
  const scarce = aheadPace || headroomPct <= policy.scarceHeadroomPct;
  const abundant = !scarce && (behindPace || headroomPct >= policy.abundantHeadroomPct);

  let threshold = scarce
    ? policy.valueThresholdScarce
    : abundant
      ? policy.valueThresholdAbundant
      : policy.valueThresholdNormal;

  // Night discount, scaled by cost: heavy jobs (cost ≥ nightHeavyCostPct) get the full discount.
  if (isNight(now, policy)) {
    const heaviness =
      policy.nightHeavyCostPct > 0 ? Math.min(1, job.sessionCost / policy.nightHeavyCostPct) : 1;
    threshold = Math.max(0, threshold - policy.nightValueDiscount * heaviness);
  }

  // When budget is scarce, refuse a job that can't fit the remaining session — no value clears a
  // guaranteed mid-run exhaustion (anton-k05r acceptance #3).
  if (scarce && job.sessionCost > headroomPct) {
    return { admit: false, threshold, reason: "cost-exceeds-headroom" };
  }
  if (job.value < threshold) {
    return { admit: false, threshold, reason: "value-below-threshold" };
  }
  return { admit: true, threshold, reason: "admitted" };
}

/**
 * Filter a ready queue to the jobs admissible now, ordered by value (highest first) — anton's own
 * admission order among ready work. This reorders nothing on the beads board; it only decides which
 * of the already-ready jobs anton spends the current budget on, and in what order.
 */
export function admissibleJobs<T extends GovernedJob>(
  usage: ClaudeUsage | null,
  policy: BudgetPolicy,
  now: number,
  jobs: readonly T[],
): T[] {
  return jobs
    .filter((job) => admitJob(usage, policy, now, job).admit)
    .sort((a, b) => b.value - a.value);
}
