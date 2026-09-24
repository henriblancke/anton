/**
 * The feature ledger's pure halves: which PHASE a recorded invocation belongs to (anton-6p4kd), and
 * what a feature cost in TIME (anton-96ga0).
 *
 * ## Phases — classified by the HANDLER, never by the author's step id
 *
 * A feature's spend splits into `implement` / `self-review` / `describe` / `pr-fix`, beside the
 * `overhead` of the scheduled passes. The split keys on `claude_invocations.step_handler` — the
 * resolved `stepName(step)` — and never on `step`, which carries the formula AUTHOR's own id for
 * that step. On the bundled formula the two coincide; on a project formula whose implement step is
 * called `code-ticket` they do not, and a fold keyed on the id would miss every predicate and dump a
 * custom pipeline's whole spend into `unattributed` (PR #311 review).
 *
 * The one place `step` is read is the review gate's own correction round — and it is not an author's
 * id there. The gate passes its OWN literals (`review-gate.ts`: `review` for the review session,
 * `review-fix` for the fix that follows) whatever the formula called the step that invoked it, so
 * under `stepHandler = "review"` the step is anton's constant rather than project data. That row's
 * job type is still `execute-epic`, and counting it as implement spend would hide the cost of
 * correcting a run inside the cost of doing it.
 *
 * A row that classifies to nothing is `undefined` here, never a guess — the caller buckets it as
 * unattributed (design rule 3: cost is never split proportionally). ADR-0001 clause 3 makes an
 * unclassified pair a BUILD problem rather than a silent bucket: both tables below are `Record`s
 * over their union, so a new job type or step id fails typecheck until it declares a phase, and the
 * exhaustiveness test names any pair anton actually records that maps to nothing.
 *
 * ## Timing — the durations that are exact, and the one that is refused because it is not
 *
 * Two figures are derivable from rows anton already writes, and both are reported:
 *
 *  - `activeMs` — what claude actually worked. The UNION of each invocation's own `[start, end]`
 *    span, so overlapping invocations (a scope reparented across concurrent histories can have them)
 *    are not double-counted.
 *  - `leadMs` — first invocation to last delivery. Includes every overnight quota park in between.
 *
 * `lead − active` is the figure the split was built for: it separates WORKING from WAITING, which is
 * the question that says whether to buy more quota. A feature parked 14h on a usage limit has ~20min
 * active and ~14h lead, and one number reported alone hides whichever half is being asked about.
 *
 * ## There is no `wallMs`, and this type may not grow one
 *
 * Wall time — start to finish INCLUDING retries — is not derivable from what exists today, so it is
 * absent from {@link LedgerTiming} rather than approximated. `runs.attempt_started_at` is REWRITTEN
 * every time a resume picks a parked row back up (`jobs/execute-epic-start.ts`; the column's own
 * comment says so, since that rewrite is exactly what the repair weigher needs it for). A settled
 * row therefore carries only the LAST attempt's start beside a final `ended_at`, and every earlier
 * interval is already gone. `Σ (endedAt − attemptStartedAt)` would yield the last attempt's duration
 * while claiming to be wall time including retries — understating precisely the runs that struggled
 * most, which is the opposite of what anyone asks wall time for.
 *
 * **What would unblock it:** a per-attempt record — a `run_attempts` row (run id, attempt number,
 * started, ended, outcome), append-only, the same shape as `claude_invocations`. Filed as its own
 * bead rather than smuggled into this fold. Until that lands, no field here carries wall time and no
 * caller can render a wrong one.
 *
 * The rejected alternative was reporting the last attempt's duration as `lastAttemptMs`. It is a
 * third number nobody asked for, and its RESEMBLANCE to wall time is the trap: a plausible wrong
 * figure survives into every cohort comparison, where an absent one is merely a visible gap. Same
 * rule as `spend-breakdown`'s unpriced-is-not-zero — nothing here derives a number it cannot stand
 * behind.
 *
 * ## Totals — three honesty rules, and what each of them refuses to do
 *
 * {@link ledgerTotals} folds the rows into one {@link PhaseTotals} per phase. Two of its rules are
 * inherited verbatim from `spend-breakdown`, and the third is new here:
 *
 *  - An unpriced model is TOKENS-ONLY, never free. A bucket anton could price nothing in reports its
 *    tokens and `usd: undefined`; a partly-priced one reports the dollars it has beside a non-zero
 *    `unpricedRows`, so a floor cannot read as a total.
 *  - Nothing recorded is EMPTY, not zero. An empty scope returns `recorded: false` and NO phases.
 *    "We measured nothing" and "we measured zero spend" are opposite facts about a feature.
 *  - **Cost is never split proportionally.** *(new to this module)* Spend that classifies to no
 *    phase lands whole in {@link LedgerTotals.unattributed}, and a scheduled pass's spend lands
 *    whole in {@link LedgerTotals.overhead} — outside the feature's bill entirely (design §D4).
 *    Neither is divided across the phases around it. A split looks precise and is not: it would
 *    move real money onto phases that did not spend it, and the error is invisible afterwards
 *    because the figures still add up. An unallocated bucket is a visible gap; a split is a lie
 *    that survives into every cohort comparison.
 *
 * Pricing is per ROW, because the fact table's grain is (invocation, model) and each of those rows
 * is billed at its own model's rates — an opus invocation's haiku sidecar costs haiku money. The
 * MEASURES are per invocation (`duration_ms`, `duration_api_ms`, `num_turns`, `outcome` are all
 * copied onto every row of one invocation), so the fold walks invocations and prices their rows.
 *
 * ## Friction — the six intervention signals, counted one source at a time
 *
 * The other half of the ledger: how much human attention a feature took (design §D3), read entirely
 * from tables anton already writes so the series cannot rot from neglect. Each counter at the bottom
 * of this file takes only its own source and increments alone, and every one is a PROXY signal — see
 * that section's own note for why no surface may render them as a quality score.
 *
 * Pure and dependency-free — no db, no node builtins; the two union types below are imported for
 * their types only, and `rework-marks` is a leaf module of string constants — so a server component,
 * the fold and any later CLI share one definition instead of three that drift. The DB reads stay with
 * the caller: invocation rows from `claude-invocations`, delivery times from
 * `runs.listDeliveriesByBead`, and the friction counters' own four sources (see below).
 */
import type { JobType } from "./jobs/queue";
import type { BuiltinStepId } from "./jobs/step-ids";
import {
  groupInvocations,
  type InvocationDimensionRow,
  type InvocationFact,
} from "./model-divergence";
import {
  costOf,
  isMissingPriceEntry,
  type GatewayPricing,
  type TokenCounts,
} from "./model-pricing";
import { isSendBackNote } from "./rework-marks";

/** The phases a feature's recorded spend splits into. */
export const LEDGER_PHASES = ["implement", "self-review", "describe", "pr-fix", "overhead"] as const;

export type LedgerPhase = (typeof LEDGER_PHASES)[number];

/**
 * Scheduled passes serve the WHOLE board, so their spend is reported against the project and never
 * divided across features (design §D4) — splitting it would be a fabricated number, and the same
 * discipline as `spend-breakdown`'s unpriced rule says an unallocated line beats an invented split.
 * Exported as a predicate rather than left as a comment so a caller can enforce it.
 */
export function isProjectLevelPhase(phase: LedgerPhase): boolean {
  return phase === "overhead";
}

/**
 * The phases a FEATURE's own totals may carry. Callers fold over this rather than
 * {@link LEDGER_PHASES}, so project-level overhead cannot reach a per-feature figure by omission.
 */
export const FEATURE_PHASES: readonly LedgerPhase[] = LEDGER_PHASES.filter(
  (phase) => !isProjectLevelPhase(phase),
);

/** A job type whose rows are classified by their step's handler, not by the type itself. */
export const BY_HANDLER = "by-handler";

/**
 * What a job type declares about its rows: one phase for every row it writes, {@link BY_HANDLER}
 * when it walks a formula and its steps decide, or `null` to state that it dispatches no claude at
 * all and therefore writes no ledger row. `null` is a DECLARATION, not a fallthrough — a row that
 * turns up under one is an anomaly the caller sees as unattributed, which is the point.
 */
export type JobTypePhase = LedgerPhase | typeof BY_HANDLER | null;

/**
 * Every job type's phase. A `Record` over {@link JobType} on purpose: adding a job type fails
 * typecheck here until it declares one, which is the mechanism ADR-0001 clause 3 relies on to stay
 * true rather than decay.
 */
export const JOB_TYPE_PHASES: Readonly<Record<JobType, JobTypePhase>> = Object.freeze({
  // The only type that walks a formula (`step-ids.PIPELINE_JOB_TYPE`), so its steps classify it.
  "execute-epic": BY_HANDLER,
  // Both PR-fix types are one phase: the cost of a run being corrected after it opened its PR.
  "review-fix": "pr-fix",
  "review-fix-pr": "pr-fix",
  // The scheduled passes that spend against the board rather than any one feature.
  "nightly-stringer": "overhead",
  gardener: "overhead",
  "product-master": "overhead",
  "board-picker": "overhead",
  // Mechanical jobs — a board sync, a reaper, a health probe. None dispatches claude, so none writes
  // a ledger row; stating that is what keeps the next one from being classified by guesswork.
  "orphan-grooming": null,
  "sync-push": null,
  "run-health": null,
  unstick: null,
  "gate-check": null,
  "worktree-reaper": null,
});

/**
 * Every builtin step handler's phase. A `Record` over {@link BuiltinStepId} for the same reason as
 * {@link JOB_TYPE_PHASES}: a new step id cannot ship without declaring where its spend belongs.
 *
 * `verify`, `commit` and `pr` dispatch no claude of their own today, so in practice they write no
 * rows — they are mapped rather than declared spend-nothing because they are part of the same arc
 * as `implement`: getting THIS run's work made and landed, as opposed to reviewing it, describing
 * it, or correcting it. A handler that later grows a dispatch therefore lands in the phase a reader
 * would already expect, instead of appearing as unattributed spend.
 */
export const HANDLER_PHASES: Readonly<Record<BuiltinStepId, LedgerPhase>> = Object.freeze({
  implement: "implement",
  verify: "implement",
  commit: "implement",
  pr: "implement",
  claude: "implement",
  review: "self-review",
  describe: "describe",
});

/** The handler the review gate stamps on BOTH of its sessions — the review, and the fix after it. */
const REVIEW_HANDLER: BuiltinStepId = "review";

/**
 * The `step` the review gate records for its correction round. anton's own literal, not a formula
 * author's id — see the header for why reading it here does not reintroduce the bug this module
 * exists to avoid.
 */
export const REVIEW_FIX_STEP = "review-fix";

/** The dimensions a phase is read from. Structural, so a ledger row satisfies it without a mapper. */
export interface LedgerPhaseRow {
  jobType: string | null | undefined;
  /** The author's step id — read ONLY to tell the review gate's two sessions apart. */
  step?: string | null;
  /** The resolved handler (`step_handler`). Null on rows written before the column existed. */
  stepHandler?: string | null;
}

/**
 * Which phase a recorded invocation belongs to, or `undefined` when anton cannot say.
 *
 * `undefined` is returned rather than a default bucket for three real cases, all of which the caller
 * reports as unattributed: a job type this anton no longer defines, a job type that declared it
 * spends nothing, and a row whose handler is absent or unknown. The last of those covers every row
 * written before `step_handler` existed — they carry null forever, and falling back to `step` would
 * be exactly the author-id guess this module refuses, on the rows least able to survive it.
 */
export function ledgerPhase(row: LedgerPhaseRow): LedgerPhase | undefined {
  const { jobType } = row;
  if (typeof jobType !== "string" || !Object.hasOwn(JOB_TYPE_PHASES, jobType)) return undefined;

  const declared = JOB_TYPE_PHASES[jobType as JobType];
  if (declared !== BY_HANDLER) return declared ?? undefined;

  const handler = row.stepHandler;
  if (typeof handler !== "string") return undefined;

  // The gate's fix round, still under `execute-epic`. Checked before the handler lookup because the
  // gate stamps `review` on BOTH its sessions today, so the handler alone would file the correction
  // as self-review. Either spelling counts, and neither can be forged by a formula: `review-fix` is
  // no builtin step id, so a handler that reads it came from anton; and the `step` clause is gated
  // on the gate's own handler, so an author who names their implement step `review-fix` is still
  // classified by what ran rather than by what they called it.
  if (handler === REVIEW_FIX_STEP || (handler === REVIEW_HANDLER && row.step === REVIEW_FIX_STEP)) {
    return "pr-fix";
  }

  return Object.hasOwn(HANDLER_PHASES, handler) ? HANDLER_PHASES[handler as BuiltinStepId] : undefined;
}

/**
 * The columns a timing fold reads: an invocation's own duration, plus the dimensions that say which
 * rows belong to ONE invocation. Structural, so a ledger row satisfies it without a mapper.
 */
export interface LedgerTimingRow extends InvocationDimensionRow {
  /** What the driver measured for the whole invocation. Null when the result reported none. */
  durationMs: number | null;
}

/** How long a feature took, in the two senses that are exact. Deliberately carries NO wall time. */
export interface LedgerTiming {
  /**
   * What claude worked, folded over INVOCATIONS — never over rows. See {@link activeMs} for why the
   * distinction is load-bearing rather than pedantic.
   *
   * Unlike the standalone {@link activeMs}, this is the UNION of invocation spans rather than their
   * sum: two invocations that overlap (a reparented scope can combine them from concurrent histories)
   * contribute their covered time once, not twice, so `waitingMs` (lead − active) never goes negative
   * off the back of double-counted overlap.
   *
   * Excludes an invocation that PROVABLY ended after {@link leadMs}'s delivery — strictly after, with
   * no flooring ambiguity — because that work is real but sits outside this span, and counting it
   * would let `waitingMs` understate, or falsely zero, how long the scope actually waited. An
   * invocation whose floored end merely TIES the delivery second is not provably later (see
   * {@link splitAmbiguous}) and stays folded in here; {@link timedInvocations} counts both kinds.
   */
  activeMs: number;
  /** Invocations folded. `0` is an empty scope, which the caller reports as nothing-recorded. */
  invocations: number;
  /**
   * How many of those actually reported a duration — including one excluded from {@link activeMs}
   * for having provably ended after delivery. Below {@link invocations} the active figure is a FLOOR,
   * not a total — the same discipline as `spend-breakdown`'s priced/unpriced counts, so a
   * partly-measured span can say so instead of quietly reading as complete.
   */
  timedInvocations: number;
  /**
   * First invocation to last delivery, spanning every park in between — or `undefined` when the
   * scope has not delivered, which is absent rather than zero.
   */
  leadMs: number | undefined;
  /**
   * True when some invocation's floored end landed in the SAME SECOND as the scope's delivery.
   *
   * `recordedAt` and the delivery timestamp are both floored to whole seconds, so a tie between them
   * does not prove the invocation happened before OR after delivery — it is exactly as likely to be
   * the invocation that PRODUCED the delivery (the common case: work finishes, the push follows in
   * the same second) as one that merely followed it with no result. Resolving that tie by assuming
   * either direction is a guess this fold refuses to make — the same refusal discipline {@link leadMs}
   * and `firstInvocationStartMs` already apply to their own unresolvable ties. {@link waitingMs}
   * checks this and refuses to report a split rather than silently pick a side.
   */
  splitAmbiguous: boolean;
}

/**
 * A reported non-negative figure, or 0 — absent and unreadable both contribute nothing, the same
 * reading as `model-pricing` and `spend-breakdown` give a count. Serves durations and token counts
 * alike: an absent measure adds nothing, and every total below reports the row and invocation counts
 * that say whether it is complete.
 */
function count(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * One invocation-level measure, taken from whichever of its rows reported one.
 *
 * The fact table's grain is (invocation, model) and these are INVOCATION-level measures copied onto
 * each of those rows (`claude-invocations.ts` writes them into the shared half), so every row of one
 * invocation carries the same figure. Reading the first that reported one is therefore the value,
 * not a sample of several — and summing the rows instead would multiply it by the model count.
 */
function invocationMeasure<Row extends LedgerTimingRow>(
  rows: readonly Row[],
  field: keyof Row & ("durationMs" | "durationApiMs" | "numTurns"),
): number | undefined {
  for (const row of rows) {
    const value = row[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

/** One invocation's own duration. {@link invocationMeasure} on the field the timing half reads. */
function invocationDuration(rows: readonly LedgerTimingRow[]): number | undefined {
  return invocationMeasure(rows, "durationMs");
}

/** When an invocation's row was stamped — the moment it ENDED, in epoch ms. */
function recordedAtMs(rows: readonly LedgerTimingRow[]): number | undefined {
  const at = rows[0]?.recordedAt?.getTime();
  return typeof at === "number" && Number.isFinite(at) ? at : undefined;
}

/**
 * What claude worked across these rows, summed PER INVOCATION.
 *
 * Summing the rows directly would double-count every invocation that reported usage under more than
 * one model — an ordinary opus invocation reports a `claude-haiku-*` sidecar row too, and that row
 * carries the same `duration_ms` as its parent. A per-row sum would therefore inflate the active
 * figure of essentially every real invocation, and inflate it by a factor nobody could see.
 *
 * Regrouping is delegated to {@link groupInvocations} rather than re-derived here, so this fold and
 * the divergence read agree on what one invocation IS — including the reconstruction that legacy
 * rows written before the invocation id need.
 */
export function activeMs(rows: readonly LedgerTimingRow[]): number {
  let total = 0;
  for (const fact of groupInvocations(rows)) total += count(invocationDuration(fact.rows));
  return total;
}

/**
 * When the scope's first invocation BEGAN, in epoch ms, or `undefined` when nothing was recorded —
 * or when an earlier invocation's start cannot be reconstructed (see below).
 *
 * Reconstructed as `recorded_at − duration_ms`, because `recorded_at` is stamped as an invocation
 * ENDS. Taking the stamp itself as the origin would start the span after the first invocation had
 * already done its work, which on a single-invocation feature makes `lead − active` negative — a
 * nonsense figure for the one quantity the split exists to produce.
 *
 * Nothing is lost here in the way wall time is lost (see the header): an invocation's start is
 * exactly its end minus its own measured duration. `recorded_at` is floored to whole seconds, so the
 * reconstruction can sit up to a second EARLY and never late — it cannot manufacture a lead shorter
 * than the truth.
 *
 * `metered` records a failed driver call without a duration before rethrowing, so a retry can be the
 * first invocation THIS fold can time even when it is not the first invocation that ran. An untimed
 * invocation's own start is unrecoverable — there is no duration to subtract from its end — so its
 * mere presence means a real invocation happened whose start this fold cannot place. Reporting a
 * later, timed invocation's reconstructed start as the origin anyway would silently understate lead
 * and waiting time, so this refuses instead: it returns `undefined` rather than a start it cannot
 * stand behind.
 *
 * That refusal does not depend on comparing the untimed invocation's end to the timed one's
 * reconstructed start. An end that lands AFTER that start does not prove the untimed invocation
 * began later too — once a child can be reparented into a scope whose rows come from a different,
 * possibly concurrent history, "ended after" no longer implies "started after": it may have begun
 * earlier and merely ended later, or ended later only because flooring `recorded_at` to whole
 * seconds hides the true order. Neither this nor any other row carries the untimed invocation's own
 * start, so there is no ordering this fold can stand behind either way — refuse whenever an untimed
 * invocation exists in scope, not only when it provably precedes the reconstructed start.
 */
export function firstInvocationStartMs(rows: readonly LedgerTimingRow[]): number | undefined {
  let earliestStart: number | undefined;
  for (const fact of groupInvocations(rows)) {
    const endedAt = recordedAtMs(fact.rows);
    if (endedAt === undefined) continue;
    const duration = invocationDuration(fact.rows);
    if (duration === undefined) return undefined;
    const startedAt = endedAt - duration;
    if (earliestStart === undefined || startedAt < earliestStart) earliestStart = startedAt;
  }
  return earliestStart;
}

/**
 * The scope's last delivery in epoch ms, from the map `runs.listDeliveriesByBead` returns.
 *
 * That read answers in epoch SECONDS and per bead; a feature's scope is the bead plus its children,
 * so the latest across all of them is when the feature was last delivered.
 */
export function lastDeliveryMs(
  deliveries: ReadonlyMap<string, readonly number[]>,
  beadIds: readonly string[],
): number | undefined {
  let latest: number | undefined;
  for (const beadId of beadIds) {
    for (const seconds of deliveries.get(beadId) ?? []) {
      if (!Number.isFinite(seconds)) continue;
      const at = seconds * 1000;
      if (latest === undefined || at > latest) latest = at;
    }
  }
  return latest;
}

/**
 * Both exact durations for one scope. **No wall time** — see the header for why, and for what would
 * unblock it.
 *
 * `deliveredAtMs` is the scope's last delivery ({@link lastDeliveryMs}); omit it for a feature that
 * has not delivered, which reports `leadMs: undefined` rather than 0.
 */
export function ledgerTiming(
  rows: readonly LedgerTimingRow[],
  deliveredAtMs?: number,
): LedgerTiming {
  const facts = groupInvocations(rows);
  const intervals: Interval[] = [];
  let untethered = 0;
  let timed = 0;
  let splitAmbiguous = false;
  for (const fact of facts) {
    const duration = invocationDuration(fact.rows);
    if (duration === undefined) continue;
    timed += 1;
    // An invocation that PROVABLY ended after the scope's last delivery did not go into producing it —
    // a review-fix session that answers feedback but lands no new delivery, say. Folding its whole
    // duration into `active` would let it outrun `leadMs` below, so `waitingMs` (lead − active)
    // understates — or falsely zeroes — how long the scope actually waited (PR #320 review). Only the
    // PROVEN-later portion is excluded: reparenting can combine concurrent histories, so an invocation
    // can have started before the last delivery and still end after it — clip it at the delivery
    // boundary and keep the pre-delivery portion rather than discarding the whole span (PR #320
    // review). One with no recorded end stays in, same as `firstInvocationStartMs` refusing to guess
    // in the other direction.
    //
    // Both `recordedAt` and `deliveredAtMs` are floored to whole seconds, so a tie between them proves
    // NEITHER direction: it is exactly as likely to be the invocation that produced the delivery
    // itself (work ends, the push follows within the same second — the ordinary case) as one that
    // followed it with no result. An earlier fix here treated the tie as proven-later, which broke the
    // ordinary case outright: a single invocation whose push landed in the same second reported ZERO
    // active time and a fully "waiting" lead (PR #320 review, fresh finding). Guessing "earlier"
    // instead would just relocate the wrong confident answer to the opposite case. Neither guess is
    // safe, so a tie is left folded into `active` (unlike a proven-later exclusion) and flagged via
    // `splitAmbiguous` instead, so `waitingMs` can refuse the split rather than silently pick a side.
    const endedAt = recordedAtMs(fact.rows);
    if (deliveredAtMs !== undefined && endedAt !== undefined) {
      if (endedAt === deliveredAtMs) splitAmbiguous = true;
      else if (endedAt > deliveredAtMs) {
        const startedAt = endedAt - duration;
        if (startedAt < deliveredAtMs) intervals.push({ start: startedAt, end: deliveredAtMs });
        continue;
      }
    }
    // `recordedAt` is a non-nullable column, so `endedAt` is absent only when a row is malformed
    // beyond what this fold can place on the timeline — fall back to counting its duration outright
    // rather than dropping it, the same "add it anyway" reading `count()` gives an absent measure.
    if (endedAt === undefined) {
      untethered += duration;
      continue;
    }
    intervals.push({ start: endedAt - duration, end: endedAt });
  }

  return {
    activeMs: untethered + unionMs(intervals),
    invocations: facts.length,
    timedInvocations: timed,
    leadMs: leadMs(firstInvocationStartMs(rows), deliveredAtMs),
    splitAmbiguous,
  };
}

interface Interval {
  start: number;
  end: number;
}

/**
 * The total time covered by a set of possibly-overlapping intervals — the UNION, not the sum.
 *
 * Reparenting can retroactively combine invocations from concurrent histories into one scope, so two
 * invocations' recorded spans can genuinely overlap. Summing their durations in that case double-
 * counts the overlap and lets `activeMs` outrun the truth: two calls running 0–20 and 10–25 minutes
 * sum to 35 minutes of "activity" despite covering only 25 real minutes, which would understate — or
 * zero out — `waitingMs` (lead − active) for exactly the minutes that were genuinely idle.
 */
function unionMs(intervals: readonly Interval[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let { start: curStart, end: curEnd } = sorted[0];
  for (const { start, end } of sorted.slice(1)) {
    if (start > curEnd) {
      total += curEnd - curStart;
      curStart = start;
      curEnd = end;
    } else if (end > curEnd) {
      curEnd = end;
    }
  }
  return total + (curEnd - curStart);
}

/**
 * The span from the first invocation to the last delivery, or `undefined` when there is no span to
 * report — nothing recorded, or nothing delivered yet.
 *
 * A delivery that PRECEDES the scope's first recorded invocation yields `undefined` too. It happens
 * when a bead is reparented into a scope it did not deliver under, or when the rows behind an older
 * delivery are outside the window read; either way there is no honest span between the two, and a
 * negative lead — or a zero clamped over one — would be a figure this read cannot stand behind.
 */
function leadMs(startedAtMs: number | undefined, deliveredAtMs: number | undefined): number | undefined {
  if (startedAtMs === undefined || deliveredAtMs === undefined) return undefined;
  const span = deliveredAtMs - startedAtMs;
  return span >= 0 ? span : undefined;
}

/**
 * How long the scope spent WAITING rather than working — the figure the active/lead split was built
 * to produce. `undefined` whenever lead is, since a span that cannot be stated cannot be divided, and
 * also `undefined` when {@link LedgerTiming.splitAmbiguous} is set — a same-second tie between an
 * invocation's end and the delivery could go either way, and neither reading of `activeMs` is one
 * this split can stand behind, so it refuses rather than silently pick a side.
 */
export function waitingMs(timing: LedgerTiming): number | undefined {
  if (timing.splitAmbiguous) return undefined;
  return timing.leadMs === undefined ? undefined : Math.max(0, timing.leadMs - timing.activeMs);
}

/**
 * The counts one bucket's rows reported. Five, as the design names them — summed across ROWS, since
 * the token counts are the one thing that genuinely varies per (invocation, model).
 *
 * There is no `total` field. A single tokens column is a DISPLAY choice (`spend-breakdown`'s
 * `formatTokens` owns it) and computing one here would invite summing {@link thinking} into it.
 */
export interface LedgerTokens {
  input: number;
  output: number;
  /**
   * Inside {@link output}, never additional to it (see `model-pricing`'s header). Reported for
   * completeness and NEVER added into anything — doing so double-charges every thinking model.
   */
  thinking: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * What one bucket of the ledger cost: the money, the tokens behind it, and the measures that say
 * what produced it.
 *
 * Every measure but the tokens is per INVOCATION, because that is the grain the driver measured
 * them at: `duration_ms`, `duration_api_ms`, `num_turns` and `outcome` are invocation-level figures
 * copied onto each of an invocation's per-model rows, so summing the rows would multiply each of
 * them by however many models the invocation reported usage under.
 */
export interface PhaseTotals {
  /**
   * Invocations in this bucket — the design's name for the count. NOT ledger rows (there is one per
   * model, so an opus invocation with a haiku sidecar writes two) and NOT `runs` table rows (one run
   * dispatches many invocations across many phases).
   */
  runs: number;
  tokens: LedgerTokens;
  /**
   * USD across the rows anton could price, or **undefined when it could price none of them** — never
   * 0 for an unpriced bucket. With a non-zero {@link unpricedRows} beside it, this is a FLOOR.
   */
  usd: number | undefined;
  /** Rows that produced no dollar figure: a model with no price, or an invocation that measured nothing. */
  unpricedRows: number;
  /** Rows that did produce one. Beside {@link unpricedRows} so a partial figure can say it is partial. */
  pricedRows: number;
  /** Ledger rows folded in. `pricedRows + unpricedRows`. */
  rows: number;
  /** What claude worked, summed over invocations. A floor when fewer reported a duration than `runs`. */
  activeMs: number;
  /** How much of {@link activeMs} the driver reported as API time — the rest is tool and hook time. */
  apiMs: number;
  turns: number;
  /** Invocations claude itself reported as failed. Money spent without a result, kept countable. */
  errors: number;
}

/**
 * One scope's spend, bucketed. Nothing here is ever divided across buckets — see the header's third
 * rule.
 *
 * An empty bucket is ABSENT rather than zeroed, one level down from {@link recorded}: a phase
 * missing from {@link phases} recorded nothing, which is a different fact from a phase that spent
 * zero, and a UI that iterates the map renders only what happened.
 */
export interface LedgerTotals {
  /**
   * Whether the ledger holds ANY row for this scope. `false` is the empty state and must render as
   * "nothing recorded", never as `$0.00` — see the header's second rule.
   */
  recorded: boolean;
  /** The feature's own phases, keyed by phase. Only phases that recorded something are present. */
  phases: Map<LedgerPhase, PhaseTotals>;
  /**
   * What this scope spent: {@link phases} plus {@link unattributed}, which is money the scope really
   * spent even though anton cannot say on what. Board-wide {@link overhead} is deliberately NOT in
   * here (design §D4) — it is not this feature's bill.
   */
  totals: PhaseTotals;
  /**
   * Spend that classified to no phase, whole and undivided — `undefined` when there was none. A row
   * lands here when its job type is one this anton no longer defines, when its job type declares it
   * dispatches no claude, or when it predates `step_handler` and so records no handler to classify
   * on. The bucket is the point: it is the visible remainder that a proportional split would hide.
   */
  unattributed: PhaseTotals | undefined;
  /**
   * The scheduled passes' spend, if any row in the scope carried one — reported against the project
   * and never divided into the feature (design §D4). `undefined` when there was none, which is the
   * ordinary case: a board-wide pass stamps no bead id.
   */
  overhead: PhaseTotals | undefined;
  /** Ledger rows folded, across every bucket. */
  rows: number;
  /**
   * The distinct model ids anton has no price for, most-seen first — the actionable half of an
   * incomplete total, as in `spend-breakdown`: it names what to add to the price table.
   */
  unpricedModels: string[];
}

/** The columns the totals fold reads: the timing dimensions, the handler, and the measured counts. */
export interface LedgerTotalsRow extends LedgerTimingRow, TokenCounts {
  /** The resolved handler the phase is classified on. See {@link LedgerPhaseRow}. */
  stepHandler?: string | null;
  /** A SUBSET of `outputTokens`, so it is reported and never added into a total. */
  thinkingTokens?: number | null;
  numTurns?: number | null;
  durationApiMs?: number | null;
}

/** A bucket with nothing in it yet. Zeroed on purpose — it is only published once a row lands in it. */
function emptyTotals(): PhaseTotals {
  return {
    runs: 0,
    tokens: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0 },
    usd: undefined,
    unpricedRows: 0,
    pricedRows: 0,
    rows: 0,
    activeMs: 0,
    apiMs: 0,
    turns: 0,
    errors: 0,
  };
}

/** One row's token counts added into a bucket. Mutates; the caller owns the object. */
function addTokens(into: LedgerTokens, row: LedgerTotalsRow): void {
  into.input += count(row.inputTokens);
  into.output += count(row.outputTokens);
  into.thinking += count(row.thinkingTokens);
  into.cacheRead += count(row.cacheReadInputTokens);
  into.cacheWrite += count(row.cacheCreationInputTokens);
}

/**
 * One whole invocation folded into one bucket: its rows' tokens and dollars, its own measures once.
 *
 * The bucket is chosen per INVOCATION rather than per row, because the phase is a property of what
 * anton was doing and every row of one invocation shares those dimensions — while `duration_ms`,
 * `num_turns` and `outcome` would each be multiplied by the invocation's model count if the fold
 * walked rows.
 */
function accumulate(
  into: PhaseTotals,
  fact: InvocationFact<LedgerTotalsRow>,
  gatewayPricing: GatewayPricing | undefined,
  unpricedModels: Map<string, number>,
): void {
  into.runs += 1;
  into.activeMs += count(invocationMeasure(fact.rows, "durationMs"));
  into.apiMs += count(invocationMeasure(fact.rows, "durationApiMs"));
  into.turns += count(invocationMeasure(fact.rows, "numTurns"));
  if (fact.outcome === "error") into.errors += 1;

  for (const row of fact.rows) {
    addTokens(into.tokens, row);
    into.rows += 1;
    const cost = costOf(row.modelReported, row, row.endpointHost, gatewayPricing);
    if (cost === undefined) {
      into.unpricedRows += 1;
      // `costOf` is also undefined when a PRICED model simply measured no counts (a crashed
      // invocation), or when a null endpointHost's default transport may be an unbilled
      // subscription rather than a model anton has no price for (PR #320 review) — only a model
      // that is a genuine price-table gap belongs in this list. Only a NAMED model is worth
      // reporting back — a row with no model names nothing to add.
      const model = row.modelReported?.trim();
      if (model && isMissingPriceEntry(row.modelReported, row, row.endpointHost, gatewayPricing)) {
        unpricedModels.set(model, (unpricedModels.get(model) ?? 0) + 1);
      }
      continue;
    }
    into.pricedRows += 1;
    into.usd = (into.usd ?? 0) + cost;
  }
}

/** A bucket's figures added into the scope's total. The only summing done ACROSS buckets. */
function mergeInto(into: PhaseTotals, from: PhaseTotals): void {
  into.runs += from.runs;
  into.tokens.input += from.tokens.input;
  into.tokens.output += from.tokens.output;
  into.tokens.thinking += from.tokens.thinking;
  into.tokens.cacheRead += from.tokens.cacheRead;
  into.tokens.cacheWrite += from.tokens.cacheWrite;
  into.unpricedRows += from.unpricedRows;
  into.pricedRows += from.pricedRows;
  into.rows += from.rows;
  into.activeMs += from.activeMs;
  into.apiMs += from.apiMs;
  into.turns += from.turns;
  into.errors += from.errors;
  // An unpriced bucket must not drag a priced total down to a sum that reads as complete, and it
  // must not turn an all-unpriced total into 0 either: undefined + undefined stays undefined.
  if (from.usd !== undefined) into.usd = (into.usd ?? 0) + from.usd;
}

/**
 * Fold one scope's ledger rows into per-phase totals, under the header's three rules.
 *
 * `rows` is every `claude_invocations` row for the scope's beads (`ledgerScope`, feature-scope.ts).
 * An empty list returns `recorded: false` with no phases and no buckets — not a set of zeroes.
 *
 * `gatewayPricing` is the caller's own rate snapshot for one routed endpoint, passed through to
 * {@link costOf} unchanged. Without it a routed row is unpriced rather than guessed, which is what
 * makes `unpricedRows` mean something.
 */
export function ledgerTotals(
  rows: readonly LedgerTotalsRow[],
  gatewayPricing?: GatewayPricing,
): LedgerTotals {
  const phases = new Map<LedgerPhase, PhaseTotals>();
  const unpricedModels = new Map<string, number>();
  let unattributed: PhaseTotals | undefined;
  let overhead: PhaseTotals | undefined;

  for (const fact of groupInvocations(rows)) {
    // Every row of one invocation carries the same dimensions (they come from one `shared` object in
    // `claude-invocations.ts`), so the first row classifies the whole invocation.
    const phase = fact.rows[0] ? ledgerPhase(fact.rows[0]) : undefined;
    let bucket: PhaseTotals;
    if (phase === undefined) {
      bucket = unattributed ??= emptyTotals();
    } else if (isProjectLevelPhase(phase)) {
      bucket = overhead ??= emptyTotals();
    } else {
      bucket = phases.get(phase) ?? emptyTotals();
      phases.set(phase, bucket);
    }
    accumulate(bucket, fact, gatewayPricing, unpricedModels);
  }

  // The feature's own bill: its phases plus what could not be placed within them. Overhead stays
  // out — §D4 — and is reported on its own field instead.
  const totals = emptyTotals();
  for (const bucket of phases.values()) mergeInto(totals, bucket);
  if (unattributed) mergeInto(totals, unattributed);

  return {
    recorded: rows.length > 0,
    phases,
    totals,
    unattributed,
    overhead,
    rows: rows.length,
    unpricedModels: [...unpricedModels.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([model]) => model),
  };
}

// ── friction: the intervention signals, each read from the table that already records it ──
//
// (anton-464lw) How much human attention a feature actually took, counted from rows anton already
// writes so the series cannot rot from neglect (design §D3). Each counter below takes ONLY its own
// source, so a fixture that exercises one leaves every other at zero — which is what makes the sum
// (anton-l6a9z: `countHumanTouches`, and the quota-park exclusion from it) provable one term at a
// time rather than as one opaque total.
//
// ## Every figure here is a PROXY, and no surface may present it as a score
//
// `reviewRounds > 1` is the best cheap quality signal available and is still only a signal: a run
// that took three rounds may have been badly implemented, ambitiously scoped, or strictly reviewed,
// and nothing recorded tells the three apart. Same for the rest — an escalation says anton stopped
// and asked, not that it was wrong to. Design §D3 accepts that cost explicitly; the countervailing
// rule is that these are labelled as observed signals everywhere they are shown.
//
// ## Nothing recorded is EMPTY, not zero — the same rule `ledgerTotals` applies to money
//
// Each counter is a plain number, and a scope that really recorded nothing genuinely counted zero
// interventions — a feature that sailed through and one nobody has run yet both read 0 here. What
// must NOT happen is the second being PRESENTED as the first, so that distinction lives one level
// up rather than in these return types: every counter takes rows a caller has already resolved for a
// scope, and the caller says "nothing recorded" from the ledger's own flag (see
// `LedgerTotals.recorded`), never by reading a wall of zeroes as a frictionless run.

/**
 * One review round as this counter reads it: the verdict it settled on.
 *
 * Structural, so a `ReviewScoreEntry` replayed off the board (`review-report.ts`) satisfies it
 * without a mapper — and so this fold stays free of `jobs/review-score.ts`, which reaches bd.
 */
export interface FrictionReviewRound {
  /** The round's verdict. `clean` is the only one that ends the gate with nothing left to fix. */
  verdict?: string | null;
}

/** The verdict that ends a review gate with nothing outstanding — see {@link countReviewRounds}. */
const CLEAN_VERDICT = "clean";

/**
 * How many rounds it took to reach a CLEAN verdict — not how many comments the thread holds, and
 * not how many rounds ran.
 *
 * The distinction is the whole value of the number. Every round the gate runs appends its own
 * comment, and a round that found blocking findings appends one too — so a comment count answers
 * "how chatty was the reviewer", while what a founder is asking is "how many times did this work
 * have to go back before it passed". Those diverge exactly on the runs worth looking at.
 *
 * Counted up to and INCLUDING the first clean round, because reaching clean is what the rounds were
 * spent on: two rounds where the second came back clean is one round of rework, reported as 2. Rounds
 * after a clean verdict belong to a LATER gate — a resumed run restarts at round 1, and a send-back
 * re-reviews the same target — so they are not part of the arc this figure describes.
 *
 * A thread that never reached clean returns every round in it. That is the honest answer for a
 * feature still in flight or one that exhausted the round cap: the rounds were really spent, and
 * reporting 0 for "never got clean" would make the worst outcome read as the best one. `round`
 * numbers are deliberately NOT read — a resumed gate restarts its numbering, so they are not a total
 * order (see `review-report.ts`) — the position in the thread is.
 */
export function countReviewRounds(rounds: readonly FrictionReviewRound[]): number {
  const clean = rounds.findIndex((r) => r.verdict === CLEAN_VERDICT);
  return clean === -1 ? rounds.length : clean + 1;
}

/** The columns a friction count reads off a `jobs` row. Structural, like every other row type here. */
export interface FrictionJobRow {
  /** The job's type — `review-fix` / `review-fix-pr` are the PR-fix rounds. */
  type?: string | null;
  /** `queued` | `running` | `parked` | `done` | `failed` | `cancelled`. */
  status?: string | null;
  /**
   * How many times this row paused on an exhausted usage limit, ever — only ever incremented
   * (`reschedule`, jobs/queue.ts). Optional so a fixture that never sets it reads as zero.
   */
  quotaParkCount?: number | null;
  /**
   * How many times this row was parked for a human to clear, ever — only ever incremented (`park`,
   * jobs/queue.ts). Optional for the same reason as {@link quotaParkCount}.
   */
  failureParkCount?: number | null;
}

/** The job types that exist to correct a run AFTER its PR opened — `JOB_TYPE_PHASES`' `pr-fix` pair. */
const PR_FIX_JOB_TYPES: readonly string[] = ["review-fix", "review-fix-pr"];

/**
 * How many times a PR of this feature's had to be corrected after it opened.
 *
 * Counts SETTLED rows only. A queued or running job has not corrected anything yet, and counting one
 * would make the figure fall back down when the job finishes — a friction number that decreases as
 * work continues is one nobody can trend. A parked or failed round is counted: it cost the attention
 * the number exists to measure, and it is the rounds that went badly that a founder most wants
 * counted.
 *
 * `review-fix` (the scheduled dispatcher) and `review-fix-pr` (one PR's own pass) are both counted,
 * because the ledger's own `JOB_TYPE_PHASES` bills their spend to the one `pr-fix` phase: a rounds
 * figure that disagreed with the phase it is read beside would be unreconcilable. In practice the
 * dispatcher carries no bead in its payload, so a bead-scoped read hands this only per-PR rows.
 */
export function countPrFixRounds(jobs: readonly FrictionJobRow[]): number {
  return jobs.filter(
    (job) => typeof job.type === "string" && PR_FIX_JOB_TYPES.includes(job.type) && isSettled(job),
  ).length;
}

/** Job statuses that are over — the only ones a friction counter reads. See {@link countPrFixRounds}. */
const SETTLED_JOB_STATUSES: readonly string[] = ["done", "failed", "parked", "cancelled"];

function isSettled(job: FrictionJobRow): boolean {
  return typeof job.status === "string" && SETTLED_JOB_STATUSES.includes(job.status);
}

/**
 * How many times an operator terminally killed a job in this scope (`jobs.status = 'cancelled'`).
 *
 * A cancel is the most unambiguous human touch anton records: no durability path reaches this status
 * — the runner parks, reschedules or fails, and only an operator's click cancels (see `JobStatus`,
 * jobs/queue.ts) — so unlike every other counter here this one needs no heuristic at all.
 */
export function countCancels(jobs: readonly FrictionJobRow[]): number {
  return jobs.filter((job) => job.status === "cancelled").length;
}

/**
 * How many times this scope's work paused on an exhausted quota.
 *
 * Reported ALONGSIDE the human-touch counters and never inside them (design §friction): a usage limit
 * is not a human intervention and not anton failing. Folding it in would make the metric degrade
 * every time anton is used MORE, which is the opposite of what it is for — so this is the one counter
 * whose value is that it stays out of the sum a sibling ticket composes.
 *
 * Sums the durable `quotaParkCount` rather than sniffing the row's CURRENT `status`/`lastError` for
 * the runner's usage-limit marker (PR #322 review): `reschedule` overwrites `lastError` on the job's
 * very next settle, so a row that quota-paused twice, or has since completed, read as at most one
 * pause under the old heuristic — a friction number that fell as work proceeded is one nobody could
 * trend. The counter only ever increments (jobs/queue.ts), so this is a true lifetime total.
 */
export function countQuotaParks(jobs: readonly FrictionJobRow[]): number {
  return jobs.reduce((total, job) => total + (job.quotaParkCount ?? 0), 0);
}

/**
 * How many times this scope's work stopped for a reason a HUMAN has to clear — a poison, an
 * exhausted attempt budget, a push that kept being rejected.
 *
 * The other half of the park split, and the reason quota parks can leave the friction sum without a
 * signal going missing with them: a park is either a usage window anton resumes from on its own or a
 * stop nothing re-dispatches, and design §gap-3 is explicit that those two have OPPOSITE meanings
 * and must not collapse into one "parks" number. This half IS anton failing, and is counted as one.
 *
 * Sums the durable `failureParkCount` rather than reading the row's CURRENT `status` (PR #322
 * review): `resumeJob` flips a parked row back to `queued`, so a failure park counted off `status`
 * alone vanished the moment an operator un-stuck the very job the count exists to remember. The
 * counter only ever increments (`park`, jobs/queue.ts), and — mirroring {@link countQuotaParks} —
 * never the same increment as that one: `park()` and a quota `reschedule()` are disjoint call sites.
 */
export function countFailureParks(jobs: readonly FrictionJobRow[]): number {
  return jobs.reduce((total, job) => total + (job.failureParkCount ?? 0), 0);
}

/** The one column the escalation counters read: the finding kind the row was raised from. */
export interface FrictionEscalationRow {
  /** `parked-run` | `stale-pr` | `dead-lease` | `exhausted-job` | `needs-human` | `autopilot-disarm`. */
  kind?: string | null;
}

/** The escalation kind that IS a human gate — a wait only a person can end (`run-health.ts`). */
const HUMAN_GATE_KIND = "needs-human";

/**
 * Every escalation raised against this scope — gates INCLUDED, because a gate is one of these rows.
 *
 * `needs-human` is a `kind` WITHIN the escalations table, not a separate source, so this total and
 * {@link countHumanGates} overlap by construction. They are reported separately because they mean
 * different things — anton stopped and asked a person, versus anton stopped for any reason — and the
 * sum rule a sibling ticket composes subtracts the overlap rather than adding both (PR #311 review,
 * which is where summing them double-counted every gate and inflated precisely the features that
 * needed the most attention).
 */
export function countEscalations(escalations: readonly FrictionEscalationRow[]): number {
  return escalations.length;
}

/**
 * The escalations that are human GATES: an open ask only a person can answer. A strict SUBSET of
 * {@link countEscalations} — see there for why that is stated rather than left to be inferred.
 */
export function countHumanGates(escalations: readonly FrictionEscalationRow[]): number {
  return escalations.filter((e) => e.kind === HUMAN_GATE_KIND).length;
}

/**
 * The escalations that are NOT gates — anton stopped for something nobody was asked to answer.
 *
 * The disjoint remainder of {@link countEscalations}, named rather than left implicit so
 * {@link countHumanTouches} can add the gates back exactly once instead of summing two overlapping
 * totals, and so a surface can show both halves of the escalation total without re-deriving them.
 */
export function countNonGateEscalations(escalations: readonly FrictionEscalationRow[]): number {
  return escalations.filter((e) => e.kind !== HUMAN_GATE_KIND).length;
}

/** What a send-back count reads off a bead: its append-only notes blob, already split into entries. */
export interface FrictionNote {
  text: string;
}

/**
 * How many times a human sent work in this scope BACK — a reopen with instructions, or a follow-up
 * opened off a review.
 *
 * Counted from the notes a send-back writes rather than from the stage-label strip that accompanies
 * it, because the strip is an ERASURE: `RUN_STAGE_LABELS` being absent now says nothing about how
 * many times it was taken off, and a bead re-run after a send-back is wearing them again. The note is
 * the only per-occurrence record on the board, and `rework-marks.ts` is where its phrasing lives so
 * this predicate and the renderer cannot drift apart.
 *
 * ORIGIN-side notes only, so each send-back is worth exactly one even when the follow-up it created
 * lands in this same feature — see `rework-marks.ts` for the two-sided write this deliberately reads
 * half of.
 */
export function countSendBacks(notes: readonly FrictionNote[]): number {
  return notes.filter((note) => isSendBackNote(note.text)).length;
}

/**
 * How many times a PERSON had to touch this feature — the one number the friction counters exist to
 * produce, and the only one that sums them (design §friction).
 *
 * ```
 * humanTouches = nonGateEscalations + humanGates + sendBacks + cancels
 * ```
 *
 * ## Why the escalation total is split before it is added
 *
 * `needs-human` is a KIND WITHIN the escalations table (`run-health.ts`), not a separate source. So
 * `escalations + humanGates` counts every gate TWICE — and it does so worst on the features that
 * needed the most attention, which biases every cohort comparison toward whichever prompt raised
 * more gates (PR #311 review). Splitting first and adding the disjoint halves makes the overlap
 * impossible to reintroduce: a lone `needs-human` is one escalation that is also one gate, and it
 * lands here as 1. {@link countEscalations} and {@link countHumanGates} stay reported separately
 * because they answer different questions; they are just never added to each other.
 *
 * ## Why quota parks are not in the sum at all
 *
 * A usage limit is not a human intervention and not anton failing — nobody was asked anything, and
 * the runner resumes on its own. Folding {@link countQuotaParks} in would make this number grow
 * every time anton is used MORE, degrading precisely as the tool succeeds, which is the opposite of
 * what it is for. It is reported alongside, never inside — as is {@link countFailureParks}, which IS
 * anton failing but is still not a person touching anything.
 *
 * Review rounds and PR-fix rounds are likewise excluded: a review round is the system working, and
 * both are anton's own passes rather than a human's.
 *
 * Still a PROXY, like every counter it sums — see this section's header. Four touches says a feature
 * took four interruptions, not that it was done badly.
 */
export function countHumanTouches(scope: {
  escalations?: readonly FrictionEscalationRow[];
  notes?: readonly FrictionNote[];
  jobs?: readonly FrictionJobRow[];
}): number {
  const { escalations = [], notes = [], jobs = [] } = scope;
  return (
    countNonGateEscalations(escalations) +
    countHumanGates(escalations) +
    countSendBacks(notes) +
    countCancels(jobs)
  );
}

/**
 * One scope's friction, composed — every counter above read off its own source in one shape.
 *
 * ## Each field is an observed SIGNAL, and no surface may render it as a quality score
 *
 * The rule the whole section is written under (design §D3), restated on the type because this is
 * what a caller actually holds: these are proxies for how much attention a feature took, not
 * measurements of how well it was done. Three review rounds may mean a weak implementation, an
 * ambitious scope or a strict reviewer, and nothing recorded tells them apart. A surface renders
 * them labelled as what was observed.
 *
 * ## Zero here means "nothing happened", never "nothing was measured"
 *
 * Every field is a plain number, so a feature that sailed through and a feature nobody has run yet
 * both read 0. The ledger's own {@link LedgerTotals.recorded} is what tells those apart — see the
 * section header for why that distinction stays one level up rather than turning these into
 * `undefined`s each caller would have to re-handle.
 */
export interface LedgerFriction {
  /**
   * Rounds the self-review took to reach a clean verdict — the cheapest quality SIGNAL anton has,
   * and still only a signal ({@link countReviewRounds}). Not a person's doing: excluded from
   * {@link humanTouches}.
   */
  reviewRounds: number;
  /**
   * Times a PR had to be corrected after it opened ({@link countPrFixRounds}). anton's own pass, so
   * likewise outside {@link humanTouches}.
   */
  prFixRounds: number;
  /**
   * Every escalation raised against the scope, gates INCLUDED ({@link countEscalations}) — anton
   * stopped and said something, for any reason. Overlaps {@link humanGates} by construction; the two
   * are never added to each other.
   */
  escalations: number;
  /**
   * The escalations that were human GATES — an open ask only a person could answer
   * ({@link countHumanGates}). A strict SUBSET of {@link escalations}.
   */
  humanGates: number;
  /**
   * The disjoint remainder: escalations that asked nobody anything
   * ({@link countNonGateEscalations}). Reported so both halves of the total are readable without
   * re-deriving them, and so the sum below can add each gate exactly once.
   */
  nonGateEscalations: number;
  /**
   * Times a human sent work in this scope back ({@link countSendBacks}) — a reopen with
   * instructions, or a follow-up opened off a review. Read from free-text notes, so a proxy in the
   * strongest sense: a founder can write the phrase by hand.
   */
  sendBacks: number;
  /**
   * Jobs an operator terminally killed ({@link countCancels}) — the one counter here that rests on
   * no heuristic, since no durability path reaches `cancelled`.
   */
  cancels: number;
  /**
   * Times the scope's work paused on an exhausted usage limit ({@link countQuotaParks}). Reported
   * beside {@link humanTouches} and deliberately never inside it: a quota window is not a person
   * intervening, and folding it in would degrade the metric every time anton is used MORE.
   */
  quotaParks: number;
  /**
   * Parks a human has to clear ({@link countFailureParks}) — the other half of the park split, and
   * the one that IS anton failing. Still not a person touching anything, so also outside the sum.
   */
  failureParks: number;
  /**
   * How many times a PERSON had to touch this feature ({@link countHumanTouches}) — the one figure
   * that sums the others, and the only one that does. Four touches says four interruptions, not
   * that the work was done badly.
   */
  humanTouches: number;
}

/**
 * Fold one scope's four friction sources into {@link LedgerFriction}.
 *
 * Pure, like the rest of this module: the caller resolves the rows (review rounds off the run
 * target's comment thread, jobs by payload, escalations by bead, notes off the board) and this
 * composes them. Each source is optional because they are read independently and a scope can be
 * missing any of them — an unreviewed target has no thread, a feature nobody escalated has no rows.
 */
export function ledgerFriction(scope: {
  rounds?: readonly FrictionReviewRound[];
  jobs?: readonly FrictionJobRow[];
  escalations?: readonly FrictionEscalationRow[];
  notes?: readonly FrictionNote[];
}): LedgerFriction {
  const { rounds = [], jobs = [], escalations = [], notes = [] } = scope;
  return {
    reviewRounds: countReviewRounds(rounds),
    prFixRounds: countPrFixRounds(jobs),
    escalations: countEscalations(escalations),
    humanGates: countHumanGates(escalations),
    nonGateEscalations: countNonGateEscalations(escalations),
    sendBacks: countSendBacks(notes),
    cancels: countCancels(jobs),
    quotaParks: countQuotaParks(jobs),
    failureParks: countFailureParks(jobs),
    humanTouches: countHumanTouches({ escalations, notes, jobs }),
  };
}
