/**
 * What a feature cost in TIME (anton-96ga0) — the durations that are exact, and the one that is
 * refused because it is not.
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
 * Pure and dependency-free — no db, no node builtins — so a server component, the fold and any later
 * CLI share one definition instead of three that drift. The DB reads stay with the caller:
 * invocation rows from `claude-invocations`, delivery times from `runs.listDeliveriesByBead`.
 */
import { groupInvocations, type InvocationDimensionRow } from "./model-divergence";

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
