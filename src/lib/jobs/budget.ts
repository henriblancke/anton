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

  /**
   * The bead labels this project NOMINATED as value signals, highest tier first (anton-prng). anton
   * ships none: an empty list means work ranks on its native fields alone (age, here), which is the
   * honest default on a board whose vocabulary anton has never seen. Order is the band order — see
   * {@link jobValueScore}.
   */
  valueLabels: readonly string[];
  /** Age window backing {@link jobValueScore}'s tie-break: a job this old scores the full age band. */
  valueAgeWindowMs: number;
  /** Session headroom% at/below which budget is "scarce" (high-value only), even absent an ahead-of-pace read. */
  scarceHeadroomPct: number;
  /** Session headroom% at/above which budget is "abundant" (admit down to cleanup), absent a behind-pace read. */
  abundantHeadroomPct: number;
  /** Value threshold when scarce/ahead-of-pace — the TOP nominated band's floor, so only it admits. */
  valueThresholdScarce: number;
  /** Value threshold on-pace — the lowest nominated band's floor: unnominated cleanup waits, nominated work runs. */
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
  valueLabels: [],
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
  /** Where the even pace-line sits at `now` (NaN without a weekly signal), for callers that project. */
  expectedPct: number;
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
  if (!havePace) {
    return { behindPace: false, aheadPace: false, havePace: false, weeklyResetMs, expectedPct: NaN };
  }
  const expectedPct = policy.weeklyTargetPct * elapsedWeekFraction(now, weeklyResetMs, policy.weekMs);
  return {
    behindPace: usage.weeklyPct < expectedPct - policy.paceSlackPct,
    aheadPace: usage.weeklyPct > expectedPct + policy.paceSlackPct,
    havePace: true,
    weeklyResetMs,
    expectedPct,
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

  // `behindPace` (from the same even pace-line) still feeds the daytime-reserve waiver below.
  const { behindPace, weeklyResetMs } = computePace(usage, policy, now);
  const cap = policy.weeklyTargetPct;

  // 2. Weekly ceiling (idle-fill, anton-ld7j). Spare weekly budget is spent freely — only the top of
  //    the plan is paced. Skipped entirely without a weekly signal (unknown reset or cap ≤ 0), which
  //    leaves pure idle-fill up to the session/daytime gates.
  if (!Number.isNaN(weeklyResetMs) && cap > 0) {
    // 2a. At/above the cap: the weekly budget is spent — stop until the window resets so the reserve
    //     (100 − cap) and Claude's own hard limit are protected.
    if (usage.weeklyPct >= cap) {
      return { admit: false, retryAt: new Date(weeklyResetMs), reason: "weekly-cap" };
    }
    // 2b. Inside the throttle band just below the cap: pace what's left so it lasts to the reset —
    //     defer only when ahead of the even line, retrying when the line catches up. BELOW the band
    //     it's idle-fill: run freely, day or night, so a productive early-week burst isn't benched.
    const throttleFloor = cap - policy.throttleBandPct;
    if (usage.weeklyPct >= throttleFloor) {
      const expectedPct = cap * elapsedWeekFraction(now, weeklyResetMs, policy.weekMs);
      if (usage.weeklyPct > expectedPct + policy.paceSlackPct) {
        return {
          admit: false,
          retryAt: new Date(paceCatchUp(usage.weeklyPct, weeklyResetMs, policy)),
          reason: "weekly-on-track",
        };
      }
    }
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

/**
 * How much quota the governor will still spend before each of its holds bites — the same thresholds
 * {@link budgetGate} defers on, expressed as what's LEFT rather than as a yes/no (anton-vlom).
 *
 * It lives here, beside the gate, because the two must never disagree: a surface that computed its
 * own idea of "remaining" would draw a budget line the governor does not keep. Both sides are
 * reported (session and weekly) rather than the tighter one, because which binds depends on what
 * the caller intends to spend it on, and the reason the operator is shown has to name the hold that
 * actually stops the work.
 *
 * Fail-open, exactly like the gate: a null usage read returns `null` — "unknown", never zero. A
 * caller that cannot read the meter must omit its claim rather than guess a limit the gate would
 * not enforce.
 */
export interface BudgetHeadroom {
  /** Session%-points still spendable before the tightest session-side hold trips. Never negative. */
  sessionPct: number;
  /** Which session-side hold bounds it: the hard floor, or the day window's reserve. */
  sessionReason: Extract<DeferReason, "session-headroom" | "daytime-reserve">;
  /** Weekly%-points still spendable before the weekly hold trips; null with no weekly signal. */
  weeklyPct: number | null;
  /** Which weekly hold bounds it: the cap, or the pace-line inside the throttle band. */
  weeklyReason: Extract<DeferReason, "weekly-cap" | "weekly-on-track">;
  /**
   * Whether spending exactly {@link weeklyPct} already trips the hold. The cap and the throttle
   * floor bite AT their threshold (`usage >= limit`); the pace-line bites only PAST it
   * (`usage > ceiling`), so a caller that charged both inclusively would hold back one run the
   * gate admits.
   */
  weeklyInclusive: boolean;
  /**
   * The daytime reserve is waived only while weekly usage is BEHIND pace, and a projection spends
   * weekly budget — so the waiver expires partway down the queue (PR #212 review). Null whenever it
   * is not in force: at night, without a weekly signal, on/ahead of pace, or with a reserve looser
   * than the hard floor. Set, it says where the waived-but-tighter ceiling takes over.
   */
  reserveWaiver: {
    /** Weekly%-points of projected burn the waiver survives; past that the reserve binds again. */
    afterWeeklyPct: number;
    /** Session%-points spendable in total once it does — the reserve's ceiling, ≤ `sessionPct`. */
    sessionPct: number;
  } | null;
}

export function budgetHeadroom(
  usage: ClaudeUsage | null,
  policy: BudgetPolicy,
  now: number,
): BudgetHeadroom | null {
  if (!usage) return null;

  const { behindPace, expectedPct, weeklyResetMs } = computePace(usage, policy, now);

  // Session side. The daytime reserve is a *tighter* ceiling on the same meter, so inside the day
  // window it — not the hard floor — is what the operator is about to run out of. Behind pace it
  // is waived (work spills into the day), and an operator who set a reserve looser than the floor
  // never sees it bind.
  const hardFloor = 100 - policy.minSessionHeadroomPct;
  const dayFloor = 100 - policy.daytimeReservePct;
  const hour = localHour(now, policy.utcOffsetMinutes);
  const inDayWindow = hour >= policy.dayStartHour && hour < policy.dayEndHour;
  const reserveBinds = inDayWindow && dayFloor < hardFloor;
  const reserveHolds = reserveBinds && !behindPace;
  const sessionLimit = reserveHolds ? dayFloor : hardFloor;

  // …and the waiver is not permanent. A caller PROJECTING a queue spends weekly budget as it walks,
  // and once that burn catches usage up to the pace-line the gate stops waiving the reserve — so a
  // projection that held the hard floor for the whole queue would call cards affordable the governor
  // then defers at the reserve (PR #212 review). Report where the waiver runs out.
  const reserveWaiver = reserveBinds && behindPace
    ? {
        afterWeeklyPct: Math.max(0, expectedPct - policy.paceSlackPct - usage.weeklyPct),
        sessionPct: Math.max(0, dayFloor - usage.sessionPct),
      }
    : null;

  // Weekly side, skipped entirely without a weekly signal — the same condition under which the gate
  // itself skips the weekly ceiling, leaving pure idle-fill.
  const cap = policy.weeklyTargetPct;
  let weeklyPct: number | null = null;
  let weeklyReason: BudgetHeadroom["weeklyReason"] = "weekly-cap";
  let weeklyInclusive = true;
  if (!Number.isNaN(weeklyResetMs) && cap > 0) {
    // Below the throttle floor spending is free whatever the pace (idle-fill, anton-ld7j), so the
    // pace-line only binds where it sits above that floor — and never above the cap.
    const throttleFloor = cap - policy.throttleBandPct;
    const paceCeiling = cap * elapsedWeekFraction(now, weeklyResetMs, policy.weekMs) + policy.paceSlackPct;
    const weeklyLimit = Math.min(cap, Math.max(throttleFloor, paceCeiling));
    const remaining = weeklyLimit - usage.weeklyPct;
    weeklyReason = weeklyLimit < cap ? "weekly-on-track" : "weekly-cap";
    // Which comparison the gate makes at the limit. Only the pace-line is exclusive, and only where
    // it is what binds — a limit pinned to the cap or held up by the throttle floor defers AT it.
    // Already over (`remaining` clamped to 0) is inclusive too: there is nothing left to spend.
    weeklyInclusive = remaining <= 0 || weeklyLimit >= cap || paceCeiling < throttleFloor;
    weeklyPct = Math.max(0, remaining);
  }

  return {
    sessionPct: Math.max(0, sessionLimit - usage.sessionPct),
    sessionReason: reserveHolds ? "daytime-reserve" : "session-headroom",
    weeklyPct,
    weeklyReason,
    weeklyInclusive,
    reserveWaiver,
  };
}

// ── Pace-modulated prioritization (anton-k05r) ──────────────────────────────────────────────────
// Once budgetGate says work MAY run, this finer gate decides which jobs are worth admitting *now*.
// A job's value comes from the labels its project nominated; pace-state (plus session headroom) sets
// a minimum value threshold. Scarce budget → high-value only; abundant → drain low-value cleanup; night lowers the
// bar for heavy jobs. This governs anton's own admission order only — it never forks beads' board.

/** The inputs to {@link jobValueScore}: a bead's labels and how long the work has waited. */
export interface JobValueInput {
  /** The bead's labels, exactly as the board carries them (e.g. `risk:high`, `size:M`). */
  labels: readonly string[];
  /** How long the job has been waiting, in ms. Older work scores higher within its band. */
  ageMs?: number;
}

/** Top of the unnominated band: work carrying no nominated label scores on age alone, in [0, this]. */
const UNNOMINATED_BAND_TOP = 0.4;
/**
 * Where the TOP and BOTTOM nominated bands floor, whatever the tier count. They mirror
 * {@link DEFAULT_BUDGET_POLICY}'s `valueThresholdScarce` / `valueThresholdNormal` — the bars
 * {@link admitJob} was tuned on — so "scarce admits the top tier only" and "on-pace admits anything
 * nominated" stay true for one nomination or five, instead of holding only at the two anton's own
 * board happens to use. A budget test asserts they stay in step.
 */
const TOP_BAND_FLOOR = 0.8;
const BOTTOM_BAND_FLOOR = 0.5;
/** How tall a band's age range may get — the top band's height, so the oldest top-tier work hits 1. */
const MAX_BAND_AGE_SPAN = 0.2;
/**
 * How much of the gap between adjacent band floors a band's age range may fill when tiers are packed
 * tighter than {@link MAX_BAND_AGE_SPAN}. Below 1 so the bands never touch: the oldest bead in a tier
 * still scores under the freshest bead one tier up.
 */
const AGE_FILL = 2 / 3;

/**
 * Score a job's value in [0,1] from the labels its project NOMINATED (`policy.valueLabels`, highest
 * tier first), with age as a within-band tie-break. anton ships no vocabulary of its own: a project
 * that nominates nothing ranks purely on age, and a project's nominations are just strings its own
 * board uses.
 *
 * The tiers floor at evenly spaced points from 0.8 (top) down to 0.5 (lowest nominated), each band's
 * age range filling two thirds of the gap below the next tier up; unnominated work fills [0, 0.4].
 * Every band is therefore disjoint and the ordering is total: any tier-1 job outranks any tier-2
 * job, which outranks any unnominated job however old. Age only breaks ties among peers — a week-old
 * cleanup job never overtakes a fresh nominated one.
 *
 * With the two-tier nomination anton's own board uses (`risk:high`, `blocking-PR`) that is exactly
 * the shipped arithmetic: [0.8, 1.0], [0.5, 0.7], [0, 0.4].
 */
export function jobValueScore(input: JobValueInput, policy: BudgetPolicy): number {
  const ageFrac =
    policy.valueAgeWindowMs > 0
      ? Math.min(1, Math.max(0, (input.ageMs ?? 0) / policy.valueAgeWindowMs))
      : 0;
  const tiers = policy.valueLabels;
  // First match wins: the nomination order IS the tier order, so a bead carrying two nominated
  // labels scores in the higher one.
  const tier = tiers.findIndex((label) => input.labels.includes(label));
  if (tier < 0) return UNNOMINATED_BAND_TOP * ageFrac;
  // A sole nomination floors at the top and keeps the shipped [0.8, 1.0] band — there is no tier
  // below it to make room for. Interpolated rather than stepped down by `spacing` so the top and
  // bottom floors land on their thresholds exactly, without float drift through the middle tiers.
  const depth = tiers.length > 1 ? tier / (tiers.length - 1) : 0;
  const floor = TOP_BAND_FLOOR * (1 - depth) + BOTTOM_BAND_FLOOR * depth;
  const spacing = tiers.length > 1 ? (TOP_BAND_FLOOR - BOTTOM_BAND_FLOOR) / (tiers.length - 1) : 0;
  const ageSpan = spacing > 0 ? Math.min(MAX_BAND_AGE_SPAN, spacing * AGE_FILL) : MAX_BAND_AGE_SPAN;
  return floor + ageSpan * ageFrac;
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
 *   • scarce   (ahead-of-pace in the throttle band OR headroom ≤ scarceHeadroomPct) → high-value only
 *   • abundant (behind-pace OR session headroom ≥ abundantHeadroomPct)             → admit down to cleanup
 *   • on-pace  (neither)                                                           → the normal bar
 * Scarce wins ties: being ahead of plan holds the line even if the session looks fresh. Ahead-of-pace
 * only reads as scarce inside the throttle band — below it `budgetGate` runs freely (idle-fill,
 * anton-ld7j), and the value bar must not quietly tighten where the coarse gate admits everything.
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
  // Mirror budgetGate's idle-fill zoning: ahead-of-pace tightens the bar only inside the throttle
  // band. (aheadPace already implies havePace, so no separate pace-known check is needed.)
  const inThrottleBand = usage.weeklyPct >= policy.weeklyTargetPct - policy.throttleBandPct;
  const scarce = (aheadPace && inThrottleBand) || headroomPct <= policy.scarceHeadroomPct;
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
