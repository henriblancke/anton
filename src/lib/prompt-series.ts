/**
 * The cohort read's guardrails (anton-0itcy): the floor under which a cohort may carry NO verdict,
 * and the flag a cohort spanning two antons must wear.
 *
 * `promptSeries` groups DELIVERED features by the stamp tuple `claude_invocations` records, so a
 * founder can ask whether a prompt, agent or skill change helped. That question is the one a metrics
 * surface most easily lies about, which is why the guardrails are part of the feature rather than a
 * follow-up (design §the attribution read). Two things make the lie easy:
 *
 *  - **Volume.** anton delivers a handful of features a week, so most comparisons anyone actually
 *    makes are between cohorts of two or three. A ↓ drawn on n=2 is not a weak signal, it is noise
 *    wearing the costume of a finding — and it is worse than no arrow, because the reader acts on it.
 *    {@link MIN_COHORT} is the floor, and below it a cohort reports its `n` and nothing else.
 *  - **Confounding.** A cohort whose features ran under two different antons moved for two candidate
 *    reasons, and the prompt edit is only one of them. That cohort still reports its figures — they
 *    are real — but it must say what it spans, or a runtime upgrade gets credited to a prompt.
 *
 * ## The floor is a TYPE, not a check a view can skip
 *
 * {@link CohortStanding} is a discriminated union, and {@link UnderpoweredCohort} has no `deltas`
 * field at all — not an empty one. A view cannot render an arrow on an underpowered cohort by
 * forgetting a condition, because there is nothing there to read: it is a typecheck failure, in the
 * same spirit as ADR-0001 clause 3 making an undeclared phase a build problem. The guardrail that
 * lives in an `if` is the guardrail someone removes while chasing a layout bug.
 *
 * Likewise {@link CohortVersions.mixed} is a required boolean on every standing, underpowered or
 * not. An optional flag is one a view renders only when it remembers to.
 *
 * ## There is no threshold knob, deliberately
 *
 * {@link MIN_COHORT} is a constant, not config and not a parameter. A configurable floor is a way to
 * turn the guardrail off — and it would be turned off precisely when a cohort is too small to say
 * anything, which is the one moment it is load-bearing. The same reasoning as
 * `review-trajectory.ts`'s `RECENT_SCORED_TARGETS`: a window chosen for what makes the number
 * honest is not a preference.
 *
 * It is a FLOOR, not a significance test (design §non-goals). Clearing it does not make a delta
 * significant; it makes it worth showing. anton has no p-values here and should not pretend to.
 *
 * Pure and dependency-free — no db, no node builtins — so the fold, a server component and any later
 * CLI share one definition of "too small to call" instead of three that drift.
 */

/**
 * How many DELIVERED features a cohort needs before it may carry a verdict. Five, from the design.
 *
 * Not tuned and not tunable. The number answers "how few is obviously too few", and at anton's real
 * volume nearly every cohort starts below it — so the honest reading of most of this surface, most of
 * the time, is "not enough data yet". That is the feature working, not a gap in it.
 */
export const MIN_COHORT = 5;

/**
 * The cohort figures a delta may be drawn on. Every one is a per-delivered-feature average the fold
 * computes; this module only compares them.
 */
export const COHORT_METRICS = [
  "usdPerFeature",
  "reviewRounds",
  "humanTouches",
  "escalations",
] as const;

export type CohortMetric = (typeof COHORT_METRICS)[number];

/**
 * Which way each metric IMPROVES. Every one of them improves downward — cheaper, fewer rounds, fewer
 * touches, fewer escalations — which is what lets {@link MetricDelta.direction} name a fall as better
 * without the caller supplying a polarity per metric.
 *
 * A `Record` over the union rather than a lookup with a default, so a metric added later cannot
 * silently inherit "lower is better": it fails typecheck until it declares. A future metric where
 * higher is better (a delivery count, a score) is exactly the case a default would get backwards, and
 * an arrow pointing the wrong way is the worst output this module can produce.
 */
export const METRIC_IMPROVES: Readonly<Record<CohortMetric, "lower" | "higher">> = Object.freeze({
  usdPerFeature: "lower",
  reviewRounds: "lower",
  humanTouches: "lower",
  escalations: "lower",
});

/**
 * One cohort's per-feature averages. Each is optional because a cohort can genuinely fail to produce
 * one: `usdPerFeature` is absent when anton could price none of the cohort's rows, which
 * `spend-breakdown`'s rule says is reported as missing and never as 0.
 */
export type CohortMetrics = Partial<Record<CohortMetric, number>>;

/** How anton reads the antons a cohort's features ran under. Always present; see the header. */
export interface CohortVersions {
  /**
   * The distinct `anton_version` values in the cohort, most-seen first, then lexically so the list is
   * stable across reads. Features that recorded none are counted in {@link unstamped} instead of
   * appearing here as a blank.
   */
  versions: string[];
  /**
   * Whether this cohort spans more than one anton — **the flag a view must render**. True when the
   * cohort holds two known versions, and equally true when it holds one known version beside
   * features that recorded none: a cohort half of which predates the stamp is confounded by whatever
   * that half ran, which is the same problem and not a lesser one.
   */
  mixed: boolean;
  /**
   * Delivered features whose rows carried no `anton_version` — pre-instrumentation work. Reported
   * rather than dropped, because it is the half of a mixed cohort that cannot be named.
   */
  unstamped: number;
}

/** What the guardrails need from a folded cohort. The key, window and averages stay with the fold. */
export interface CohortSample {
  /** DELIVERED features in the cohort. Only deliveries count toward the floor — see the epic. */
  n: number;
  /**
   * The `anton_version` each delivered feature recorded, one entry per feature, null or undefined for
   * a feature that recorded none. Passed per feature rather than pre-deduplicated so
   * {@link CohortVersions.versions} can order by how often each was seen.
   */
  antonVersions: readonly (string | null | undefined)[];
  metrics: CohortMetrics;
}

/** One metric's move against a baseline cohort — the arrow, and the number under it. */
export interface MetricDelta {
  metric: CohortMetric;
  /** This cohort's average. */
  value: number;
  /** The baseline cohort's average, which the move is measured from. */
  baseline: number;
  /** `value − baseline`. Signed in the metric's own units; direction is read off {@link direction}. */
  delta: number;
  /**
   * The move as a fraction of the baseline, or **undefined when the baseline was 0** — a fall from
   * zero has no percentage, and rendering one as ∞ or 100% would invent a figure. The absolute
   * {@link delta} is always there beside it.
   */
  ratio: number | undefined;
  /**
   * Which way the arrow points, resolved through {@link METRIC_IMPROVES}. Strictly by sign: a move is
   * `flat` only when the two averages are equal.
   *
   * No noise band, on purpose. A band would be a second unnamed threshold doing the same job as
   * {@link MIN_COHORT} — deciding what is too small to believe — while hiding in a different unit,
   * and the magnitude is rendered beside the arrow anyway, so a reader can see that a move is
   * trivial. The floor is where this module refuses to call a difference; there is only one.
   */
  direction: "better" | "worse" | "flat";
}

/** What every cohort reports regardless of whether it cleared the floor: its size and its span. */
interface CohortBase {
  n: number;
  metrics: CohortMetrics;
  versions: CohortVersions;
}

/**
 * A cohort below {@link MIN_COHORT}. Reports its `n`, its metrics and its span — and carries NO
 * `deltas` field, so no view can draw an arrow off it (see the header).
 *
 * The metrics are still here because they are real measurements of real runs. What the cohort may not
 * do is claim a DIRECTION from them.
 */
export interface UnderpoweredCohort extends CohortBase {
  comparable: false;
  /** How many more delivered features this cohort needs. The honest thing to render instead of a verdict. */
  shortfall: number;
}

/** A cohort that cleared the floor, so a move against a baseline is worth showing. */
export interface ComparableCohort extends CohortBase {
  comparable: true;
  /**
   * The verdict: one entry per metric both cohorts produced. **Empty when there was no comparable
   * baseline** — the first cohort in a series has nothing to move against, and a baseline that is
   * itself underpowered is noise whichever side of the subtraction it sits on.
   */
  deltas: MetricDelta[];
}

/** One cohort as the view receives it. Discriminated on {@link ComparableCohort.comparable}. */
export type CohortStanding = UnderpoweredCohort | ComparableCohort;

/** Whether a cohort of this size may carry a verdict at all. The floor, in one place. */
export function isComparable(n: number): boolean {
  return n >= MIN_COHORT;
}

/**
 * The antons a cohort's delivered features ran under.
 *
 * A blank or whitespace-only stamp counts as unstamped rather than as a version: it is a recording
 * that failed, and treating it as a distinct value would flag a cohort as mixed on the strength of a
 * null that the ledger's never-fail-a-run rule expects to see.
 */
export function cohortVersions(
  antonVersions: readonly (string | null | undefined)[],
): CohortVersions {
  const seen = new Map<string, number>();
  let unstamped = 0;
  for (const raw of antonVersions) {
    const version = typeof raw === "string" ? raw.trim() : "";
    if (!version) {
      unstamped += 1;
      continue;
    }
    seen.set(version, (seen.get(version) ?? 0) + 1);
  }
  const versions = [...seen.keys()].sort((a, b) => {
    const byCount = (seen.get(b) ?? 0) - (seen.get(a) ?? 0);
    return byCount !== 0 ? byCount : a < b ? -1 : 1;
  });
  // Unstamped features are a version this cohort spans that anton cannot name, so they mix a cohort
  // exactly as a second known version does — see CohortVersions.mixed.
  return { versions, mixed: versions.length + (unstamped > 0 ? 1 : 0) > 1, unstamped };
}

/**
 * One metric's move, or `undefined` when there is nothing to subtract — either cohort may have failed
 * to produce the average (an unpriced cohort has no `usdPerFeature`), and a delta against a missing
 * baseline is not a smaller finding, it is no finding.
 */
export function metricDelta(
  metric: CohortMetric,
  value: number | undefined,
  baseline: number | undefined,
): MetricDelta | undefined {
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) return undefined;
  const from = baseline as number;
  const to = value as number;
  const delta = to - from;
  const fell = delta < 0;
  const improvesDown = METRIC_IMPROVES[metric] === "lower";
  return {
    metric,
    value: to,
    baseline: from,
    delta,
    ratio: from === 0 ? undefined : delta / from,
    direction: delta === 0 ? "flat" : fell === improvesDown ? "better" : "worse",
  };
}

/**
 * One cohort's standing: below the floor it reports its `n` and its shortfall, above it the deltas
 * against `baseline`.
 *
 * The baseline must clear the floor too. A comparison is only as sound as its weaker side, and
 * measuring a well-populated cohort against an n=2 predecessor produces a confident arrow off two
 * runs — the exact output {@link MIN_COHORT} exists to prevent, arrived at from the other direction.
 *
 * Mixed versions do NOT suppress the verdict, and this is the deliberate asymmetry: an underpowered
 * cohort has not measured enough to say anything, while a mixed one has measured plenty and merely
 * cannot attribute it. Suppressing the second would throw away a real finding; flagging it hands the
 * reader the ambiguity to resolve, which is the only place it can be resolved.
 */
export function cohortStanding(
  sample: CohortSample,
  baseline?: CohortSample,
): CohortStanding {
  const base: CohortBase = {
    n: sample.n,
    metrics: sample.metrics,
    versions: cohortVersions(sample.antonVersions),
  };
  if (!isComparable(sample.n)) {
    return { ...base, comparable: false, shortfall: MIN_COHORT - sample.n };
  }
  const comparableBaseline = baseline && isComparable(baseline.n) ? baseline : undefined;
  const deltas = comparableBaseline
    ? COHORT_METRICS.flatMap((metric) => {
        const delta = metricDelta(metric, sample.metrics[metric], comparableBaseline.metrics[metric]);
        return delta ? [delta] : [];
      })
    : [];
  return { ...base, comparable: true, deltas };
}
