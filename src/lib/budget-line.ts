/**
 * Where the ranked queue stops being affordable (anton-vlom / R3.6) — the placement behind the Up
 * Next lane's dashed budget line.
 *
 * The lane ranks more work than the current window can pay for. Without the line the ordering reads
 * as a wish list; with it, the operator can see how much of the plan is a plan. Placement is
 * arithmetic, not a forecast: charge each queued target its measured per-type burn average and walk
 * down until the governor's remaining headroom (`budgetHeadroom`) runs out.
 *
 * FAIL-OPEN is the governor's master rule — "a null usage read admits" — and this surface must not
 * contradict it. Every input it cannot justify a line from resolves to `null` (no line drawn), never
 * to a guessed position: an unreadable meter, a job type with no recorded average, a queue that costs
 * nothing. Drawing a line anton would not enforce is worse than drawing none.
 *
 * APPROXIMATE by construction, and the UI says so. Burn attribution is sampled (`burn_samples`, one
 * window per job type, blended with a tier seed until it fills), so the line marks roughly where the
 * budget goes — it is not a promise about the card sitting on it.
 *
 * Client-safe and pure: the types cross the wire from `/api/projects/[slug]/picker/budget`, and only
 * TYPES are imported from the governor, so nothing in `jobs/` is dragged into the board bundle.
 */
import type { BudgetHeadroom, DeferReason } from "./jobs/budget";

/** One job type's rolling burn average, as the API reports it (see `getBurnAverage`). */
export interface BurnCost {
  /** Mean session%-points one run of this type burns. */
  sessionPct: number;
  /** Mean weekly%-points one run of this type burns. */
  weeklyPct: number;
  /** The average still leans on the tier seed — fewer real samples than the window holds. */
  seeded: boolean;
}

/**
 * The job type a queued run target runs as. Every Up Next card is one `execute-epic`; the averages
 * are keyed by type anyway, so a lane that later ranks other job types charges each at its own
 * measured rate rather than at this one's.
 */
export const RUN_JOB_TYPE = "execute-epic";

/**
 * What the budget line is computed from, resolved server-side. Absent (a `204`) whenever the
 * governor has nothing to say — the project is not budget-aware, or usage is unreadable — which is
 * the fail-open path: no signal, no line.
 */
export interface BudgetSignal {
  headroom: BudgetHeadroom;
  /** Per-type burn averages, keyed by job type. */
  burn: Record<string, BurnCost>;
}

/** One card in the ranked queue, as the line sees it: only what it costs to run. */
export interface BudgetLineEntry {
  /** Defaults to {@link RUN_JOB_TYPE} — what a run target costs. */
  jobType?: string;
}

export interface BudgetLine {
  /**
   * How many leading cards the remaining budget affords — including the one that crosses the
   * threshold, which the governor admits because it tests the meter before the run rather than
   * reserving its cost. `0` puts the line above the whole queue.
   */
  affordable: number;
  /** Which of the governor's holds the queue runs into — the reason the cards below are waiting. */
  reason: DeferReason;
  /** Some charged average is still seeded, so the placement leans on estimates over measurements. */
  seeded: boolean;
}

/**
 * Place the budget line in a ranked queue, or `null` when there is none to draw.
 *
 * `null` means exactly one thing to a caller — render no line — and it covers both honest cases: the
 * budget cannot be read (fail open), and the whole queue is affordable (nothing to mark).
 *
 * A card that exhausts BOTH sides at once reports whichever hold the gate would actually apply. Only
 * the hard session floor outranks the weekly checks; the daytime reserve is tested AFTER them, so a
 * card over both reports the weekly hold — telling the operator to wait for tonight when the real
 * wait runs to weekly catch-up or reset would misstate the hold.
 */
export function budgetLine(
  signal: BudgetSignal | null,
  entries: readonly BudgetLineEntry[],
): BudgetLine | null {
  if (!signal) return null;

  const { headroom, burn } = signal;
  let session = 0;
  let weekly = 0;
  let seeded = false;

  for (const [index, entry] of entries.entries()) {
    const cost = burn[entry.jobType ?? RUN_JOB_TYPE];
    // A type this machine has no average for is a cost we would have to invent. Omit the line.
    if (!cost) return null;

    // Admit first, charge second — the order the governor itself works in. `budgetGate` reads the
    // meter BEFORE a run starts and reserves nothing, so the run that spends the last of the
    // headroom is still admitted and only the one after it waits. Charging first would put the line
    // one card too high, marking a card as waiting that anton is about to start.
    // Each side is charged at the boundary the gate itself tests. Both session holds defer AT their
    // threshold; on the weekly side only the pace-line defers past it (`weeklyInclusive`), so a card
    // whose burn lands exactly on the pace ceiling is one the governor still starts.
    // The daytime reserve is waived only while weekly usage is behind pace, and the burn charged
    // above catches it up — so past `afterWeeklyPct` the governor stops waiving it and the tighter
    // reserve ceiling binds the rest of the queue (PR #212 review). Charging the hard floor all the
    // way down would mark cards affordable that the governor defers at the reserve.
    const waiver = headroom.reserveWaiver;
    const reserveBack = waiver !== null && weekly >= waiver.afterWeeklyPct;
    const sessionLimit = reserveBack ? waiver.sessionPct : headroom.sessionPct;
    const sessionReason = reserveBack ? "daytime-reserve" : headroom.sessionReason;

    const overSession = session >= sessionLimit;
    const overWeekly =
      headroom.weeklyPct !== null &&
      (headroom.weeklyInclusive ? weekly >= headroom.weeklyPct : weekly > headroom.weeklyPct);
    if (overSession || overWeekly) {
      // budgetGate's order is session-headroom → weekly-cap → weekly-on-track → daytime-reserve, so
      // only the hard floor beats a weekly hold when both are exhausted.
      const sessionFirst = overSession && (!overWeekly || sessionReason === "session-headroom");
      return {
        affordable: index,
        reason: sessionFirst ? sessionReason : headroom.weeklyReason,
        seeded,
      };
    }

    session += cost.sessionPct;
    weekly += cost.weeklyPct;
    seeded ||= cost.seeded;
  }

  return null;
}
