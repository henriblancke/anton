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
   * The `anton_version`s the cohort's features ran under: one entry per (feature, DISTINCT version it
   * recorded), and a single null for a feature that recorded none. So a feature that spans two antons
   * contributes both — which is what makes {@link CohortVersions.mixed} true of a cohort holding one
   * such feature, correctly: that feature moved for two candidate reasons on its own.
   *
   * Per feature rather than pre-deduplicated so {@link CohortVersions.versions} can order by how many
   * FEATURES saw each, and so {@link CohortVersions.unstamped} counts features rather than rows.
   */
  antonVersions: readonly (string | null | undefined)[];
  metrics: CohortMetrics;
  /**
   * Features whose own `usd` is a FLOOR rather than a total — anton could price none of their rows,
   * or only some of them ({@link CohortFeature.unpricedRows}) — the sibling of
   * {@link CohortBasis.unpricedFeatures}. Read by {@link cohortStanding} to decide whether a
   * `usdPerFeature` delta may be drawn at all: a cohort's average is a FLOOR whenever this is
   * non-zero, and a delta between two floors (or a floor and a total) is not a smaller finding than
   * a delta between two totals, it is a different question answered as if it were the same one.
   */
  unpricedFeatures: number;
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
 *
 * `usdPerFeature` is the one metric this drops even when both cohorts clear the floor: whenever
 * either side left a feature unpriced, that side's average is a FLOOR rather than a total (per
 * {@link CohortSample.unpricedFeatures}), and a directional arrow drawn between a floor and anything
 * else can point the wrong way — a cheaper-looking floor may in truth cost more once priced. That is
 * not a smaller finding than a delta between two complete totals; it is no finding, the same reading
 * {@link metricDelta} already gives a missing average.
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
        if (
          metric === "usdPerFeature" &&
          (sample.unpricedFeatures > 0 || comparableBaseline.unpricedFeatures > 0)
        ) {
          return [];
        }
        const delta = metricDelta(metric, sample.metrics[metric], comparableBaseline.metrics[metric]);
        return delta ? [delta] : [];
      })
    : [];
  return { ...base, comparable: true, deltas };
}

/* ────────────────────────────  what a view receives  ──────────────────────────── */

/**
 * Which stamp a series groups on. The fold keys on one of these; the view labels the column with it.
 *
 * `heading` names the COLUMN the key came from rather than a friendly synonym, because the key itself
 * is an opaque digest on three of these dimensions — a reader who wants to know what `a3f1…` is has
 * only the column name to go on.
 */
export const COHORT_DIMENSIONS = [
  { value: "prompt", label: "prompt", heading: "Prompt digest" },
  { value: "formula", label: "formula", heading: "Formula digest" },
  { value: "anton", label: "anton version", heading: "anton version" },
  { value: "agent", label: "agent", heading: "Agent tag" },
  { value: "skill", label: "skill", heading: "Skill digest" },
] as const;

export type CohortDimension = (typeof COHORT_DIMENSIONS)[number]["value"];

/** One dimension's display strings, or `undefined` for a key this module does not define. */
export function cohortDimension(dimension: CohortDimension) {
  return COHORT_DIMENSIONS.find((option) => option.value === dimension);
}

/** A URL value → a dimension, falling back to the first of {@link COHORT_DIMENSIONS} rather than rejecting. */
export function normalizeCohortDimension(raw: string | null | undefined): CohortDimension {
  return COHORT_DIMENSIONS.some((option) => option.value === raw)
    ? (raw as CohortDimension)
    : COHORT_DIMENSIONS[0].value;
}

/**
 * The caution a dimension's cohorts must be read WITH, or `undefined` where the key names the only
 * thing that plausibly changed.
 *
 * Agent and skill both carry one, and it is not boilerplate: `agent:alembic` rides `risk:high`
 * migration work by convention, so its higher cost per feature says as much about the tickets it was
 * handed as about the specialist (design §cohorts by agent and by skill). The view reports the key
 * and the n; it never claims a specialist caused a difference.
 *
 * A `Record` over the union rather than a partial lookup, so a dimension added later must decide
 * whether it is confounded instead of silently inheriting "clean".
 */
export const DIMENSION_CAUTIONS: Readonly<Record<CohortDimension, string | undefined>> =
  Object.freeze({
    prompt: undefined,
    formula: undefined,
    anton: undefined,
    agent:
      "An agent cohort is confounded by the work it was given — specialists ride the ticket kinds " +
      "that route to them by convention, so a difference here describes the tickets as much as the " +
      "specialist. Read it as a description of that pairing, never as a claim the agent caused it.",
    skill:
      "A skill cohort is confounded by the work the skill was loaded for — a skill that only loads " +
      "on one kind of ticket is measured over that kind of ticket, not against it.",
  });

/** When a cohort's delivered features landed — the span its averages are averages OVER. */
export interface CohortWindow {
  firstDeliveryMs: number;
  lastDeliveryMs: number;
}

/**
 * One cohort as the view receives it: a {@link CohortStanding} plus what identifies it.
 *
 * An intersection over the union rather than a wrapper object, so the discriminant stays at the top
 * level and the type-level guardrail survives: `cohort.deltas` is still unreachable until
 * `cohort.comparable` narrows it, which is the whole reason {@link UnderpoweredCohort} omits the
 * field instead of emptying it.
 */
export type Cohort = CohortStanding & {
  /**
   * The stamp value, or **null for the features that recorded none** — the pre-instrumentation
   * cohort, which is its own group rather than a blank mixed into a real one.
   */
  key: string | null;
  /**
   * Absent when no delivery in the cohort recorded a time. Optional rather than defaulted: a span
   * anton cannot measure is a gap, and a plausible wrong one would silently date every figure in the
   * row.
   */
  window: CohortWindow | undefined;
  /** What the averages were computed FROM, and where they are incomplete. */
  basis: CohortBasis;
};

/**
 * What a cohort's figures rest on — the counts that say whether an average is a total or a FLOOR.
 *
 * Required rather than optional, for {@link UnderpoweredCohort}'s reason one level down: a cohort that
 * can omit whether its cost figure covers everything in it is a cohort that reads as complete by
 * default, and `spend-breakdown`'s rule is that a partial figure must be able to say it is partial.
 */
export interface CohortBasis {
  /**
   * Features whose spend and friction went into the numerators — **deliveries and gave-ups alike**.
   * Above {@link CohortBase.n} whenever the cohort ran work that did not deliver, which is the
   * denominator rule made visible: a prompt that mostly gave up reports a HIGHER cost per delivered
   * feature, not a lower one (design §the denominator).
   */
  features: number;
  /**
   * Features whose OWN `usd` is a floor — anton could price none of their rows, or only some of
   * them. Non-zero beside a present `usdPerFeature` makes that average a FLOOR too — the same
   * discipline `spend-breakdown` applies to a partly-priced group, and the reason the cohort reports
   * this rather than folding an unpriced or partly-priced feature in as if it were complete.
   */
  unpricedFeatures: number;
}

/** One dimension's cohorts, oldest first — each measured against the one before it. */
export interface CohortSeries {
  dimension: CohortDimension;
  cohorts: Cohort[];
  /**
   * Delivered features this dimension could not attribute to any one of its values, and so that no
   * cohort holds. Reported rather than dropped silently — see {@link promptSeries}'s third rule.
   */
  spanning: SpanningFeatures;
}

/* ────────────────────────────────  the fold  ──────────────────────────────── */

/**
 * The stamp columns a cohort keys on — one per {@link CohortDimension}, each null when the invocation
 * recorded none.
 *
 * Structural, so a `claude_invocations` row satisfies it without a mapper (the same reason
 * `LedgerTimingRow` is structural), and every field optional so a fixture naming one dimension does
 * not have to spell the other four.
 */
export interface CohortStampRow {
  /** The composed SYSTEM prompt's digest — `prompt`. */
  promptDigest?: string | null;
  /** The cooked pipeline's digest — `formula`. */
  formulaDigest?: string | null;
  /** The release + revision that ran it — `anton`. */
  antonVersion?: string | null;
  /** The ticket's resolved `agent:<tag>` — `agent`. */
  agentTag?: string | null;
  /**
   * The `skill:<id>` a step resolved to, read alongside {@link skillDigest} so a scaffolding
   * fallback (see {@link SCAFFOLDING_SKILL_IDS}) can be told apart from a project's own choice.
   */
  skillId?: string | null;
  /** The digest of the skill text a step resolved — `skill`. */
  skillDigest?: string | null;
  /**
   * Whether {@link skillId} named anton's own bundled default (no `prompt:`/`skill:` override and
   * no project setting configured it) rather than something a project explicitly chose — stamped by
   * the resolver at write time (PR #331 review), since a project is free to name its own skill
   * `review` or `describe` and that row must not be read as the scaffolding fallback just because the
   * id collides. `null`/`undefined` on a row written before this column existed, or on any row a
   * resolver never marked either way; {@link stampValue} falls back to the id-only heuristic for
   * those rather than treating "unmarked" as "explicit".
   */
  skillIsDefault?: boolean | null;
  /**
   * The resolved formula-step handler this row ran under (`claude-invocations.ts`'s `stepHandler`) —
   * read only to tell `step:describe`'s own invocations apart from every other phase (PR #331
   * review). Not a general phase classifier: the fold reads exactly one literal off it, named at
   * {@link DESCRIBER_STEP_HANDLER}.
   */
  stepHandler?: string | null;
}

/**
 * Which column each dimension keys on. This table IS "the same fold, keyed differently" (design
 * §cohorts by agent and by skill) — agent and skill are two more dimensions of the stamp tuple, so
 * they are a different lookup here rather than machinery of their own.
 *
 * A `Record` over the union for {@link METRIC_IMPROVES}'s reason: a dimension added to
 * {@link COHORT_DIMENSIONS} fails typecheck until it names the column it reads, instead of silently
 * folding every feature into one cohort keyed on `undefined`.
 */
export const DIMENSION_COLUMNS: Readonly<Record<CohortDimension, keyof CohortStampRow>> =
  Object.freeze({
    prompt: "promptDigest",
    formula: "formulaDigest",
    anton: "antonVersion",
    agent: "agentTag",
    skill: "skillDigest",
  });

/**
 * One feature as the fold receives it: what it delivered, what it cost, and the rows that say what
 * produced it.
 *
 * The caller resolves all of this — `featureLedger` already answers every field — so this module
 * stays pure. One entry per FEATURE, never per run: a feature's cost is the cost of every run that
 * worked on it, which is the unit the whole comparison is per.
 */
export interface CohortFeature {
  /** The feature's run target. Identity only — it is what keeps a feature from being folded twice. */
  beadId: string;
  /**
   * Whether the feature DELIVERED. Only deliveries count toward `n` (ticket §acceptance) while a
   * gave-up feature's spend and attention stay in the numerators — see {@link promptSeries}.
   */
  delivered: boolean;
  /**
   * When it last delivered, epoch ms. Absent for a feature that did not deliver, and absent for one
   * that delivered without a recorded time — which is why {@link CohortWindow} is optional rather
   * than defaulted.
   */
  deliveredAtMs?: number;
  /**
   * When the feature last had ANY recorded activity, epoch ms — its rows' latest `recordedAt`,
   * regardless of outcome. A feature that never delivered has no {@link deliveredAtMs} and so no
   * place in the delivery order {@link promptSeries} sorts by, but it still ran at a real point in
   * time; this is what lets the fold attribute it to the episode that was actually current WHEN it
   * ran, rather than to whichever episode of its key happens to be the last one on record (PR #331
   * review). Absent only when the feature carries no timed rows at all.
   */
  activityAtMs?: number;
  /**
   * What the feature cost, or **undefined when anton could price none of its rows** — never 0, per
   * `spend-breakdown`'s rule. `LedgerTotals.totals.usd` answers this directly.
   */
  usd: number | undefined;
  /**
   * Rows this feature's own {@link usd} could not price (`LedgerTotals.totals.unpricedRows`).
   * Optional, like the friction counters beside it — absent reads as 0. Read beside `usd` rather
   * than folded into it: a feature can carry BOTH a defined `usd` and a non-zero count here when
   * only some of its rows priced, and that combination still makes `usd` a FLOOR for this one
   * feature, not a total — the same distinction `PhaseTotals.unpricedRows` draws at the ledger
   * level, carried through so the cohort fold can draw it too (PR #331 review).
   */
  unpricedRows?: number;
  /** Rounds its self-review took to reach a clean verdict (`LedgerFriction.reviewRounds`). */
  reviewRounds?: number;
  /** Times a person had to touch it (`LedgerFriction.humanTouches`). */
  humanTouches?: number;
  /** Escalations raised against it, gates included (`LedgerFriction.escalations`). */
  escalations?: number;
  /**
   * The feature's `claude_invocations` rows — what it is keyed BY. Only the stamp columns are read,
   * so a caller passes the rows it already holds.
   */
  rows: readonly CohortStampRow[];
}

/**
 * Features the fold could attribute to no single value of the dimension, and so left out of every
 * cohort. The visible remainder — see {@link promptSeries} for why they are not split.
 */
export interface SpanningFeatures {
  /**
   * DELIVERED features excluded. What closes the arithmetic: `Σ cohort.n + delivered` is every
   * delivered feature the fold was handed, so a surface summing the cohorts can say what it is
   * missing rather than quietly under-reporting the series.
   */
  delivered: number;
  /** Every excluded feature, delivered or not — the spend that left the fold with them. */
  features: number;
}

/**
 * Bundled skill ids anton's own scaffolding phases fall back to when a project has named no
 * override of its own — `step:describe`'s and `step:review`'s always-on defaults, and their
 * siblings. Both phases run by default on essentially every feature (design §cohorts by agent and
 * by skill's own review), so counting them as the feature's "skill" stamps nearly every delivered
 * feature with TWO distinct skill digests — `describe`'s and `review`'s — and {@link featureKeys}
 * would then read every such feature as spanning several skills, emptying the skill dimension into
 * {@link SpanningFeatures} instead of a cohort. These ids carry no opinion about which skill a
 * project is trying out — PROVIDED the row is actually the fallback: {@link isScaffoldingFallback}
 * is what a row is tested against, this set is only its last resort for rows written before
 * {@link CohortStampRow.skillIsDefault} existed (PR #331 review). A project is free to name its own
 * `.claude/skills/review` and have it run under `skill:review`; that row must still read as its own
 * digest, not fold into the unstamped cohort just because the id happens to match.
 *
 * Discarding every one of them from the "skill" dimension unconditionally, though, would make it
 * impossible to ever answer whether editing a BUNDLED skill's own text helped — every such row
 * would read as no signal at all, before and after the edit alike. See
 * {@link SKILL_DIGEST_FALLBACK_IDS} and {@link featureKeys} for the one carve-out.
 */
const SCAFFOLDING_SKILL_IDS = new Set(["describe", "review", "review-fix", "scan-triage"]);

/**
 * The {@link SCAFFOLDING_SKILL_IDS} that still carry a digest signal worth reading as a last resort
 * — every one of them except `describe`, whose composed prompt is structurally boilerplate (see
 * {@link DESCRIBER_STEP_HANDLER}), never a project's own choice to iterate on. `review-fix` and
 * `scan-triage` are real bundled skill files a project can edit the same way it can `review`'s, so
 * restricting this set to `review` alone silently dropped any signal from editing either of the
 * other two (PR #331 review) — a feature whose only fallback skill happened to be `review-fix` read
 * as having named no skill at all, rather than the bundled skill it actually ran under. A feature
 * that ran under two distinct ids from this set still reads as spanning once both digests land in
 * {@link featureKeys}'s key set — the same call the "two real specialist skills" case makes, since
 * it genuinely ran under two bundled skills a project could edit independently.
 */
const SKILL_DIGEST_FALLBACK_IDS = new Set(["review", "review-fix", "scan-triage"]);

/**
 * Whether a row's {@link CohortStampRow.skillId} is anton's own scaffolding fallback rather than a
 * project's explicit choice. Trusts {@link CohortStampRow.skillIsDefault} when the resolver stamped
 * it; falls back to the id-only heuristic ({@link SCAFFOLDING_SKILL_IDS}) only for a row written
 * before that column existed, since "unmarked" there means "we don't know", not "explicit".
 */
function isScaffoldingFallback(row: CohortStampRow): boolean {
  if (row.skillIsDefault !== undefined && row.skillIsDefault !== null) return row.skillIsDefault;
  return !!row.skillId && SCAFFOLDING_SKILL_IDS.has(row.skillId);
}

/**
 * `step:describe`'s own formula-step handler (`resolve.ts`'s `stepName`, `feature-ledger.ts`'s
 * `HANDLER_PHASES.describe`) — the one phase whose composed system prompt is structurally narrower
 * than every other, by construction rather than by choice.
 *
 * `describe.ts` composes base+seed only (no `agentPrompt`), while `step:implement` and both PR-fix
 * paths compose base+agent+seed (PR #331 review): a ticket carrying an `agent:` tag therefore runs
 * its describer under a DIFFERENT `promptDigest` than the one that actually did the work, on every
 * such feature. Reading that describer digest as a second "prompt" this feature ran under makes
 * `featureKeys(feature, "prompt")` see two keys and throws the feature into {@link SpanningFeatures}
 * instead of the cohort its implementation ran under — silently excluding nearly every agent-run
 * delivered feature from the one dimension meant to measure it.
 */
const DESCRIBER_STEP_HANDLER = "describe";

/**
 * `review-gate.ts`'s own formula-step handler (`meter`'s `stepHandler: "review"`) — the phase whose
 * `agentTag` names WHO REVIEWED, not who implemented.
 *
 * `review-gate.ts` stamps the review meter with the resolved `reviewAgent`, which a project is free
 * to configure as a dedicated specialist distinct from the ticket's own `agent:` tag (PR #313
 * review). Reading that reviewer tag as a second "agent" this feature ran under makes
 * `featureKeys(feature, "agent")` see two keys and throws the feature into {@link SpanningFeatures}
 * instead of the cohort its implementation ran under — a project with a dedicated reviewer would then
 * see every reviewed feature excluded from every agent cohort.
 */
const REVIEWER_STEP_HANDLER = "review";

/**
 * One stamp value as a cohort key, or `undefined` for a row that recorded none.
 *
 * A blank or whitespace-only stamp is ABSENT rather than a distinct key, the same reading
 * {@link cohortVersions} gives it: the never-fail-a-run rule writes a null on a digest it could not
 * compute, and a cohort keyed on `""` would present that failure as a prompt.
 */
function stampValue(row: CohortStampRow, dimension: CohortDimension): string | undefined {
  if (dimension === "skill" && isScaffoldingFallback(row)) return undefined;
  // The describer's own system prompt is scaffolding for THIS dimension only — see
  // DESCRIBER_STEP_HANDLER. It still counts under every other dimension (formula, anton, agent,
  // skill), where its composition carries no such asymmetry.
  if (dimension === "prompt" && row.stepHandler === DESCRIBER_STEP_HANDLER) return undefined;
  // The reviewer's agent tag answers "who reviewed", not "who implemented" — see
  // REVIEWER_STEP_HANDLER. It still counts under every other dimension, where the review row's own
  // prompt/formula/anton/skill stamps carry no such asymmetry.
  if (dimension === "agent" && row.stepHandler === REVIEWER_STEP_HANDLER) return undefined;
  const raw = row[DIMENSION_COLUMNS[dimension]];
  const value = typeof raw === "string" ? raw.trim() : "";
  return value || undefined;
}

/** The distinct values a feature's rows named for one dimension, in first-seen order. */
function featureKeys(feature: CohortFeature, dimension: CohortDimension): string[] {
  const keys = new Set<string>();
  for (const row of feature.rows) {
    const value = stampValue(row, dimension);
    if (value !== undefined) keys.add(value);
  }
  if (keys.size === 0 && dimension === "skill") {
    // Nothing named a project skill, so the only signal left is one of anton's own bundled
    // fallbacks in {@link SKILL_DIGEST_FALLBACK_IDS} — and its digest changing IS the "did editing
    // the bundled skill help" question this dimension exists to answer (PR #331 review). Reached
    // only when the loop above found no real skill at all: a feature that named one is never routed
    // through here. A feature that ran under two distinct fallback ids (e.g. `review` and
    // `review-fix`) still ends up spanning once both digests land in `keys` — the same honest call
    // the "two real specialist skills" branch above makes, not a bug this loop should paper over.
    for (const row of feature.rows) {
      if (!isScaffoldingFallback(row)) continue;
      if (!row.skillId || !SKILL_DIGEST_FALLBACK_IDS.has(row.skillId)) continue;
      const digest = row.skillDigest?.trim();
      if (digest) keys.add(digest);
    }
  }
  return [...keys];
}

/** The distinct antons a feature ran under, or `[null]` for one that recorded none. */
function featureVersions(feature: CohortFeature): (string | null)[] {
  const versions = featureKeys(feature, "anton");
  return versions.length > 0 ? versions : [null];
}

/** A cohort mid-fold: the running numerators, and the denominator they will be divided by. */
interface CohortAccumulator {
  key: string | null;
  /** DELIVERED features — the denominator, and the `n` the floor is read against. */
  n: number;
  features: number;
  unpricedFeatures: number;
  /** Σ usd over every attributed feature, or undefined while none has been priced. */
  usd: number | undefined;
  reviewRounds: number;
  humanTouches: number;
  escalations: number;
  antonVersions: (string | null)[];
  firstDeliveryMs: number | undefined;
  lastDeliveryMs: number | undefined;
}

function emptyAccumulator(key: string | null): CohortAccumulator {
  return {
    key,
    n: 0,
    features: 0,
    unpricedFeatures: 0,
    usd: undefined,
    reviewRounds: 0,
    humanTouches: 0,
    escalations: 0,
    antonVersions: [],
    firstDeliveryMs: undefined,
    lastDeliveryMs: undefined,
  };
}

/** A reported non-negative figure, or 0 — the reading `feature-ledger` and `spend-breakdown` share. */
function count(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** One feature folded into its cohort. Mutates; the fold owns the accumulator. */
function accumulate(into: CohortAccumulator, feature: CohortFeature): void {
  into.features += 1;
  // Every numerator sums over EVERY attributed feature while only deliveries touch `n` below. That
  // asymmetry is the denominator rule (design §the denominator): drop a gave-up run's spend and the
  // prompt that gives up earliest reads as the cheapest.
  if (feature.usd !== undefined) into.usd = (into.usd ?? 0) + feature.usd;
  // A feature counts as unpriced whenever its OWN `usd` is a floor rather than a total — either it
  // priced nothing at all, or it priced only some of its rows (`unpricedRows > 0`). Both leave the
  // cohort average unable to say it covers everything folded into it (PR #331 review).
  if (feature.usd === undefined || count(feature.unpricedRows) > 0) into.unpricedFeatures += 1;
  into.reviewRounds += count(feature.reviewRounds);
  into.humanTouches += count(feature.humanTouches);
  into.escalations += count(feature.escalations);
  into.antonVersions.push(...featureVersions(feature));

  if (!feature.delivered) return;
  into.n += 1;
  const at = feature.deliveredAtMs;
  if (at === undefined || !Number.isFinite(at)) return;
  if (into.firstDeliveryMs === undefined || at < into.firstDeliveryMs) into.firstDeliveryMs = at;
  if (into.lastDeliveryMs === undefined || at > into.lastDeliveryMs) into.lastDeliveryMs = at;
}

/**
 * A cohort's per-DELIVERED-feature averages.
 *
 * Empty when the cohort delivered nothing: there is no per-delivered-feature figure when no feature
 * was delivered, and reporting the raw sums there would label a gave-up cohort's whole spend as the
 * cost of one delivery. `usdPerFeature` is likewise absent — never 0 — when anton could price none of
 * the cohort's features, per `spend-breakdown`'s rule.
 */
function cohortMetrics(from: CohortAccumulator): CohortMetrics {
  if (from.n === 0) return {};
  return {
    ...(from.usd === undefined ? {} : { usdPerFeature: from.usd / from.n }),
    reviewRounds: from.reviewRounds / from.n,
    humanTouches: from.humanTouches / from.n,
    escalations: from.escalations / from.n,
  };
}

/** A cohort's window, or `undefined` when no delivery in it recorded a time. */
function cohortWindow(from: CohortAccumulator): CohortWindow | undefined {
  return from.firstDeliveryMs === undefined || from.lastDeliveryMs === undefined
    ? undefined
    : { firstDeliveryMs: from.firstDeliveryMs, lastDeliveryMs: from.lastDeliveryMs };
}

/**
 * Cohorts oldest first — the order the deltas are then drawn along.
 *
 * Keyed on the FIRST delivery rather than the last, so a cohort still accruing does not overtake the
 * one it succeeded. A cohort with no window at all sorts last (it delivered nothing, or nothing
 * timed), and ties break on the key so a read is stable rather than dependent on encounter order.
 */
function byWindow(a: CohortAccumulator, b: CohortAccumulator): number {
  const left = a.firstDeliveryMs;
  const right = b.firstDeliveryMs;
  if (left !== right) {
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return left - right;
  }
  return (a.key ?? "").localeCompare(b.key ?? "");
}

/**
 * When `episode` stopped being the open one for ITS key — the first delivery timestamp of whichever
 * episode (any key) opened immediately after it in {@link promptSeries}'s global `episodes` list,
 * which is delivery-order because `episodes` is only ever appended to as {@link dated} is walked in
 * that order. `undefined` when `episode` is still the newest thing on record — nothing has closed it.
 */
function episodeClosesAt(
  episode: CohortAccumulator,
  episodes: readonly CohortAccumulator[],
): number | undefined {
  const index = episodes.indexOf(episode);
  if (index === -1) return undefined;
  for (let i = index + 1; i < episodes.length; i++) {
    const next = episodes[i].firstDeliveryMs;
    if (next !== undefined) return next;
  }
  return undefined;
}

/**
 * Which of a key's episodes (oldest first, per {@link promptSeries}'s `episodesByKey`) an undated
 * feature at `activityAtMs` belongs to.
 *
 * Not simply "the last one whose OWN window had already started by then": once an intervening
 * episode of a DIFFERENT key has opened, that key's own episode is closed for good, and any later
 * activity for THIS key belongs to whatever comes next for it — even before that next episode has
 * itself delivered anything. A → B → A restores the key, so a failed attempt that ran after B started
 * but before the restored A's first delivery is pre-delivery work for the RESTORED episode, not a
 * straggler from the original one (fresh boundary beyond the original episode-split fix, PR #331
 * review) — walking {@link episodeClosesAt} forward through `candidates` is what tells the two apart,
 * since a same-key-only view has no way to see B ever happened.
 *
 * Falls back to the EARLIEST episode when the activity predates all of them (a feature that ran
 * before its key ever delivered), and to the LAST one when there is no activity timestamp to place it
 * by at all — the same "no better evidence than the current era" reading a repeat delivery under an
 * unchanged key already gets. `undefined` only when the key has formed no episode yet, so the caller
 * opens one.
 */
function episodeFor(
  candidates: CohortAccumulator[] | undefined,
  episodes: readonly CohortAccumulator[],
  activityAtMs: number | undefined,
): CohortAccumulator | undefined {
  if (!candidates || candidates.length === 0) return undefined;
  if (activityAtMs === undefined || !Number.isFinite(activityAtMs)) {
    return candidates[candidates.length - 1];
  }
  let current = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    const closesAt = episodeClosesAt(candidates[i - 1], episodes);
    if (closesAt === undefined || activityAtMs < closesAt) break;
    current = candidates[i];
  }
  return current;
}

/**
 * Fold features into cohorts keyed on one dimension of the stamp tuple (anton-85y8j) — the read D2's
 * stamps were recorded for.
 *
 * Three rules decide what lands where, and each of them is about a way this fold could lie:
 *
 *  - **Only DELIVERED features count toward `n`, while every attributed feature's spend and
 *    attention stay in the numerators.** A cohort is "what did this prompt cost us per feature it
 *    actually shipped", so a cohort that burned six runs to deliver one reports six runs' cost
 *    against `n=1` — the figure a cheap-because-it-gave-up cohort would otherwise read as its best
 *    (design §the denominator). {@link CohortBasis.features} beside `n` is where that shows.
 *  - **Features that recorded NO value form their own cohort, keyed `null`.** Pre-instrumentation
 *    work is real delivery and stays countable, but it is not evidence about any prompt — folding it
 *    into a named cohort would attribute a period nothing was stamped in to whatever ran next.
 *  - **A feature naming SEVERAL values of the dimension is attributed to none of them.** A grouped
 *    run whose tickets used two specialists genuinely belongs to neither agent's cohort, and both
 *    ways of forcing it into one are wrong: counting it in both double-counts the delivery, and
 *    awarding it to the value that ran most is a proportional split of exactly the kind
 *    `feature-ledger`'s third rule refuses. It leaves the fold and is counted in
 *    {@link CohortSeries.spanning} — a visible remainder instead of an invisible error.
 *
 * Each cohort is measured against the one immediately before it in delivery order. Not against the
 * nearest COMPARABLE predecessor: skipping an underpowered cohort would draw an arrow across a period
 * the row does not name, so a series with a thin cohort in the middle reports no move there rather
 * than one spanning both sides of it. {@link cohortStanding} then owns the floor.
 *
 * A feature appears at most once per cohort: repeated `beadId`s are folded once, since a caller
 * composing a board read can hand the same run target over twice and a doubled feature would inflate
 * both sides of the average.
 *
 * **A repeated stamp value gets a fresh cohort per contiguous episode, not one merged bucket per
 * value (PR #331 review).** A stamp used, replaced, and later restored — prompt A → B → A — is two
 * separate periods that happen to share a key, not one: keying the fold on the value alone would pool
 * both A periods into a cohort whose window (and whose average) reaches past B's own delivery, so
 * comparing B against "A" compares it against a figure that includes deliveries B could not possibly
 * have moved. Splitting by episode instead draws three cohorts in the order they actually ran — A,
 * then B, then A again — each measured only against what came immediately before it.
 *
 * DELIVERED features are what decide episode boundaries, sorted by {@link CohortFeature.deliveredAtMs}
 * — the only field that says WHEN one happened; a feature that gave up records no such time and so
 * cannot be placed in that sequence at all. It still must land somewhere (every attributed feature's
 * spend stays in the numerators, per rule 1), so it is folded into whichever of its key's episodes was
 * open at its own {@link CohortFeature.activityAtMs} — the last one that had already started by then
 * — falling back to the earliest episode for the key when its activity predates every one of them, or
 * to the MOST RECENT episode when it carries no activity timestamp at all. Defaulting to "most recent"
 * unconditionally (as this fold once did) mis-files a failed attempt from a stamp's FIRST run into its
 * later, restored run whenever the stamp came back — A → B → A inflates the second A episode's cost
 * with a failure that actually happened during the first, and can reverse B's own delta against it
 * (PR #331 review). Opens a fresh episode only when the key has formed none yet.
 */
export function promptSeries(
  features: readonly CohortFeature[],
  dimension: CohortDimension,
): CohortSeries {
  const spanning: SpanningFeatures = { delivered: 0, features: 0 };
  const seen = new Set<string>();

  const dated: { feature: CohortFeature; key: string | null }[] = [];
  const undated: { feature: CohortFeature; key: string | null }[] = [];

  for (const feature of features) {
    if (seen.has(feature.beadId)) continue;
    seen.add(feature.beadId);

    const keys = featureKeys(feature, dimension);
    if (keys.length > 1) {
      spanning.features += 1;
      if (feature.delivered) spanning.delivered += 1;
      continue;
    }
    // No stamp at all is the pre-instrumentation cohort, keyed null — see rule 2.
    const key = keys[0] ?? null;
    const at = feature.deliveredAtMs;
    (feature.delivered && at !== undefined && Number.isFinite(at) ? dated : undated).push({
      feature,
      key,
    });
  }

  // Oldest first, so a run of the same key found here is genuinely contiguous in delivery order —
  // the property {@link byWindow} needs the episodes it draws deltas across to actually have.
  dated.sort((a, b) => (a.feature.deliveredAtMs as number) - (b.feature.deliveredAtMs as number));

  const episodes: CohortAccumulator[] = [];
  // Every episode a key has formed so far, oldest first — {@link dated}'s own sort order, since a
  // new episode is only ever appended, never inserted. What lets an undated feature below pick the
  // one that was actually open at its own activity time instead of always the last.
  const episodesByKey = new Map<string | null, CohortAccumulator[]>();
  let open: CohortAccumulator | undefined;
  for (const { feature, key } of dated) {
    if (!open || open.key !== key) {
      open = emptyAccumulator(key);
      episodes.push(open);
      episodesByKey.set(key, [...(episodesByKey.get(key) ?? []), open]);
    }
    accumulate(open, feature);
  }
  for (const { feature, key } of undated) {
    const candidates = episodesByKey.get(key);
    const episode = episodeFor(candidates, episodes, feature.activityAtMs);
    if (episode) {
      accumulate(episode, feature);
      continue;
    }
    const fresh = emptyAccumulator(key);
    episodes.push(fresh);
    episodesByKey.set(key, [...(candidates ?? []), fresh]);
    accumulate(fresh, feature);
  }

  const ordered = episodes.sort(byWindow);
  return {
    dimension,
    cohorts: ordered.map((cohort, index) => {
      const previous = ordered[index - 1];
      const standing = cohortStanding(sampleOf(cohort), previous ? sampleOf(previous) : undefined);
      return {
        ...standing,
        key: cohort.key,
        window: cohortWindow(cohort),
        basis: {
          features: cohort.features,
          unpricedFeatures: cohort.unpricedFeatures,
        },
      };
    }),
    spanning,
  };
}

/** One accumulator as the guardrails read it — the bridge from the fold to {@link cohortStanding}. */
function sampleOf(from: CohortAccumulator): CohortSample {
  return {
    n: from.n,
    antonVersions: from.antonVersions,
    metrics: cohortMetrics(from),
    unpricedFeatures: from.unpricedFeatures,
  };
}
