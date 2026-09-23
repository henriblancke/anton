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
 *  - `activeMs` — what claude actually worked. The sum of each invocation's own `durationMs`.
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
 * Pure and dependency-free — no db, no node builtins, and the two union types below are imported
 * for their types only — so a server component, the fold and any later CLI share one definition
 * instead of three that drift. The DB reads stay with the caller: invocation rows from
 * `claude-invocations`, delivery times from `runs.listDeliveriesByBead`.
 */
import type { JobType } from "./jobs/queue";
import type { BuiltinStepId } from "./jobs/step-ids";
import { groupInvocations, type InvocationDimensionRow } from "./model-divergence";

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
   * What claude worked, summed over INVOCATIONS — never over rows. See {@link activeMs} for why the
   * distinction is load-bearing rather than pedantic.
   */
  activeMs: number;
  /** Invocations folded. `0` is an empty scope, which the caller reports as nothing-recorded. */
  invocations: number;
  /**
   * How many of those actually reported a duration. Below {@link invocations} the active figure is
   * a FLOOR, not a total — the same discipline as `spend-breakdown`'s priced/unpriced counts, so a
   * partly-measured span can say so instead of quietly reading as complete.
   */
  timedInvocations: number;
  /**
   * First invocation to last delivery, spanning every park in between — or `undefined` when the
   * scope has not delivered, which is absent rather than zero.
   */
  leadMs: number | undefined;
}

/** A duration a result reported, or 0 — absent and unreadable both contribute nothing. */
function millis(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * One invocation's duration, taken from whichever of its rows reported one.
 *
 * The fact table's grain is (invocation, model) and `duration_ms` is an INVOCATION-level measure
 * copied onto each of those rows (`claude-invocations.ts` writes it into the shared half), so every
 * row of one invocation carries the same figure. Reading the first that reported one is therefore
 * the value, not a sample of several.
 */
function invocationDuration(rows: readonly LedgerTimingRow[]): number | undefined {
  for (const row of rows) {
    if (typeof row.durationMs === "number" && Number.isFinite(row.durationMs) && row.durationMs >= 0) {
      return row.durationMs;
    }
  }
  return undefined;
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
  for (const fact of groupInvocations(rows)) total += millis(invocationDuration(fact.rows));
  return total;
}

/**
 * When the scope's first invocation BEGAN, in epoch ms, or `undefined` when nothing was recorded.
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
 */
export function firstInvocationStartMs(rows: readonly LedgerTimingRow[]): number | undefined {
  let earliest: number | undefined;
  for (const fact of groupInvocations(rows)) {
    const endedAt = recordedAtMs(fact.rows);
    if (endedAt === undefined) continue;
    const startedAt = endedAt - millis(invocationDuration(fact.rows));
    if (earliest === undefined || startedAt < earliest) earliest = startedAt;
  }
  return earliest;
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
  let active = 0;
  let timed = 0;
  for (const fact of facts) {
    const duration = invocationDuration(fact.rows);
    if (duration === undefined) continue;
    active += duration;
    timed += 1;
  }

  return {
    activeMs: active,
    invocations: facts.length,
    timedInvocations: timed,
    leadMs: leadMs(firstInvocationStartMs(rows), deliveredAtMs),
  };
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
 * to produce. `undefined` whenever lead is, since a span that cannot be stated cannot be divided.
 */
export function waitingMs(timing: LedgerTiming): number | undefined {
  return timing.leadMs === undefined ? undefined : Math.max(0, timing.leadMs - timing.activeMs);
}
