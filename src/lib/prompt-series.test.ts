import { describe, expect, it } from "vitest";

import {
  COHORT_DIMENSIONS,
  COHORT_METRICS,
  DIMENSION_COLUMNS,
  MIN_COHORT,
  METRIC_IMPROVES,
  cohortStanding,
  cohortVersions,
  isComparable,
  metricDelta,
  promptSeries,
  type CohortFeature,
  type CohortSample,
  type CohortStampRow,
} from "./prompt-series";

const DAY = 86_400_000;
const JUL_1 = Date.UTC(2026, 6, 1, 12);
const AUG_2 = Date.UTC(2026, 7, 2, 12);
const SEP_4 = Date.UTC(2026, 8, 4, 12);

const OLD_PROMPT = "a3f1c2d4e5f6";
const NEW_PROMPT = "9c2eddaabbcc";

// `anton` is the only dimension still episodic (P1, PR #331 review, formula/prompt follow-up) — the
// revision-splitting tests below exercise it instead of `prompt`, which now folds like `agent`/`skill`.
const OLD_VERSION = "0.5.0";
const NEW_VERSION = "0.6.0";

/**
 * `n` delivered features that all ran under one stamp value. `key` is null for the
 * pre-instrumentation case — features whose rows recorded no stamp at all.
 */
function deliveries(
  n: number,
  {
    key,
    at,
    usd = 1,
    reviewRounds = 0,
    humanTouches = 0,
    escalations = 0,
    bead = "f",
    dimension = "promptDigest",
  }: {
    key: string | null;
    at: number;
    /** Every feature's cost. Cannot express an UNPRICED feature — see the test that needs one. */
    usd?: number;
    reviewRounds?: number;
    humanTouches?: number;
    escalations?: number;
    bead?: string;
    dimension?: keyof CohortStampRow;
  },
): CohortFeature[] {
  return Array.from({ length: n }, (_unused, index) => ({
    beadId: `${bead}-${key ?? "null"}-${index}`,
    delivered: true,
    deliveredAtMs: at,
    usd,
    reviewRounds,
    humanTouches,
    escalations,
    rows: key === null ? [{}] : [{ [dimension]: key } as CohortStampRow],
  }));
}

/** A cohort of `n` delivered features, all on one anton unless the caller says otherwise. */
const sample = (n: number, over: Partial<CohortSample> = {}): CohortSample => ({
  n,
  antonVersions: Array.from({ length: n }, () => "0.4.0+abc123"),
  metrics: { usdPerFeature: 4, reviewRounds: 2, humanTouches: 1, escalations: 0.5 },
  unpricedFeatures: 0,
  ...over,
});

describe("MIN_COHORT", () => {
  it("is the design's floor of five delivered features", () => {
    expect(MIN_COHORT).toBe(5);
  });

  it("admits a cohort at the floor and refuses one below it", () => {
    expect(isComparable(MIN_COHORT)).toBe(true);
    expect(isComparable(MIN_COHORT - 1)).toBe(false);
    expect(isComparable(0)).toBe(false);
  });
});

describe("METRIC_IMPROVES", () => {
  it("declares a polarity for every comparable metric", () => {
    // The Record is what makes a new metric fail typecheck rather than inherit "lower is better";
    // this asserts the runtime table has not drifted from the union beside it.
    for (const metric of COHORT_METRICS) expect(METRIC_IMPROVES[metric]).toBeDefined();
    expect(Object.keys(METRIC_IMPROVES).sort()).toEqual([...COHORT_METRICS].sort());
  });
});

describe("cohortStanding below MIN_COHORT", () => {
  it("reports n and no verdict, delta or arrow", () => {
    const standing = cohortStanding(sample(2), sample(10));

    expect(standing.comparable).toBe(false);
    expect(standing.n).toBe(2);
    // The guardrail is structural: there is no `deltas` to read at all, so a view cannot render an
    // arrow by forgetting a condition.
    expect(standing).not.toHaveProperty("deltas");
    expect(Object.keys(standing)).not.toContain("deltas");
  });

  it("names the shortfall so the view can say what has to accrue", () => {
    const standing = cohortStanding(sample(2));
    expect(standing.comparable === false && standing.shortfall).toBe(3);
    const atOne = cohortStanding(sample(1));
    expect(atOne.comparable === false && atOne.shortfall).toBe(MIN_COHORT - 1);
  });

  it("still reports the measurements it made — they are real, only uncallable", () => {
    const standing = cohortStanding(sample(3));
    expect(standing.metrics.usdPerFeature).toBe(4);
  });

  it("suppresses the verdict for every size under the floor, not just the tiny ones", () => {
    for (let n = 0; n < MIN_COHORT; n += 1) {
      expect(cohortStanding(sample(n), sample(20)).comparable, `n=${n}`).toBe(false);
    }
  });
});

describe("cohortStanding at or above MIN_COHORT", () => {
  it("draws deltas against a baseline that also cleared the floor", () => {
    const standing = cohortStanding(
      sample(7, { metrics: { usdPerFeature: 3, reviewRounds: 1.5 } }),
      sample(11, { metrics: { usdPerFeature: 4, reviewRounds: 3 } }),
    );

    expect(standing.comparable).toBe(true);
    const deltas = standing.comparable ? standing.deltas : [];
    expect(deltas.map((d) => d.metric)).toEqual(["usdPerFeature", "reviewRounds"]);
    expect(deltas[0]).toMatchObject({ delta: -1, direction: "better", ratio: -0.25 });
  });

  it("refuses the comparison when the BASELINE is underpowered", () => {
    // A comparison is only as sound as its weaker side: an n=2 predecessor would produce a confident
    // arrow off two runs, which is the output MIN_COHORT exists to prevent.
    const standing = cohortStanding(sample(9), sample(2));
    expect(standing.comparable).toBe(true);
    expect(standing.comparable && standing.deltas).toEqual([]);
  });

  it("has no deltas for the first cohort in a series, which has nothing to move against", () => {
    const standing = cohortStanding(sample(9));
    expect(standing.comparable && standing.deltas).toEqual([]);
  });

  it("omits a metric either cohort failed to produce rather than treating it as zero", () => {
    // An unpriced cohort reports no usdPerFeature; spend-breakdown's rule says that is missing, not 0.
    const standing = cohortStanding(
      sample(6, { metrics: { reviewRounds: 2 } }),
      sample(6, { metrics: { usdPerFeature: 5, reviewRounds: 3 } }),
    );
    expect(standing.comparable && standing.deltas.map((d) => d.metric)).toEqual(["reviewRounds"]);
  });

  it("drops the usdPerFeature delta when this cohort's average is only a floor", () => {
    // A cohort with unpriced features could in truth cost more than its partial sum shows — a
    // directional arrow drawn off it can point the wrong way, so it is not drawn at all.
    const standing = cohortStanding(
      sample(6, { metrics: { usdPerFeature: 1, reviewRounds: 2 }, unpricedFeatures: 2 }),
      sample(6, { metrics: { usdPerFeature: 5, reviewRounds: 3 } }),
    );
    expect(standing.comparable && standing.deltas.map((d) => d.metric)).toEqual(["reviewRounds"]);
  });

  it("drops the usdPerFeature delta when the BASELINE's average is only a floor", () => {
    const standing = cohortStanding(
      sample(6, { metrics: { usdPerFeature: 5, reviewRounds: 3 } }),
      sample(6, { metrics: { usdPerFeature: 1, reviewRounds: 2 }, unpricedFeatures: 1 }),
    );
    expect(standing.comparable && standing.deltas.map((d) => d.metric)).toEqual(["reviewRounds"]);
  });
});

describe("mixed anton_version flagging", () => {
  it("flags a cohort spanning two antons and names both, most-seen first", () => {
    const standing = cohortStanding(
      sample(6, { antonVersions: ["0.5.0+b", "0.4.0+a", "0.4.0+a", "0.4.0+a", "0.5.0+b", "0.4.0+a"] }),
    );

    expect(standing.versions.mixed).toBe(true);
    expect(standing.versions.versions).toEqual(["0.4.0+a", "0.5.0+b"]);
    expect(standing.versions.unstamped).toBe(0);
  });

  it("does not flag a cohort that ran entirely on one anton", () => {
    const standing = cohortStanding(sample(6));
    expect(standing.versions.mixed).toBe(false);
    expect(standing.versions.versions).toEqual(["0.4.0+abc123"]);
  });

  it("carries the flag on an UNDERPOWERED cohort too — the view must render it either way", () => {
    const standing = cohortStanding(sample(2, { antonVersions: ["0.4.0+a", "0.5.0+b"] }));
    expect(standing.comparable).toBe(false);
    expect(standing.versions.mixed).toBe(true);
  });

  it("does NOT suppress the verdict — a mixed cohort measured plenty, it just cannot attribute it", () => {
    const standing = cohortStanding(
      sample(6, { antonVersions: ["0.4.0+a", "0.4.0+a", "0.4.0+a", "0.5.0+b", "0.5.0+b", "0.5.0+b"] }),
      sample(6, { metrics: { usdPerFeature: 9 } }),
    );
    expect(standing.comparable).toBe(true);
    expect(standing.comparable && standing.deltas.length).toBeGreaterThan(0);
    expect(standing.versions.mixed).toBe(true);
  });

  it("treats one known version beside pre-instrumentation features as mixed", () => {
    // Half a cohort predating the stamp is confounded by whatever that half ran — the same problem as
    // two known versions, not a lesser one.
    const versions = cohortVersions(["0.4.0+a", "0.4.0+a", null, undefined]);
    expect(versions).toEqual({ versions: ["0.4.0+a"], mixed: true, unstamped: 2 });
  });

  it("is not mixed when every feature predates the stamp — one unknown span, not two", () => {
    expect(cohortVersions([null, null, undefined])).toEqual({
      versions: [],
      mixed: false,
      unstamped: 3,
    });
  });

  it("reads a blank stamp as a failed recording, never as a distinct version", () => {
    // The ledger's never-fail-a-run rule writes null on a digest it could not compute; a blank
    // counted as a value would flag a cohort mixed on the strength of that null.
    const versions = cohortVersions(["0.4.0+a", "", "   ", "0.4.0+a"]);
    expect(versions.mixed).toBe(true);
    expect(versions.versions).toEqual(["0.4.0+a"]);
    expect(versions.unstamped).toBe(2);
  });

  it("trims a stamp so one anton recorded with stray whitespace is not two cohorts", () => {
    expect(cohortVersions(["0.4.0+a", " 0.4.0+a "]).mixed).toBe(false);
  });

  it("orders equally-seen versions lexically so the list is stable across reads", () => {
    expect(cohortVersions(["0.5.0+b", "0.4.0+a"]).versions).toEqual(["0.4.0+a", "0.5.0+b"]);
    expect(cohortVersions(["0.4.0+a", "0.5.0+b"]).versions).toEqual(["0.4.0+a", "0.5.0+b"]);
  });

  it("reports an empty cohort as spanning nothing rather than as mixed", () => {
    expect(cohortVersions([])).toEqual({ versions: [], mixed: false, unstamped: 0 });
  });
});

describe("metricDelta", () => {
  it("reads a fall in a lower-is-better metric as an improvement", () => {
    expect(metricDelta("usdPerFeature", 3, 4)).toMatchObject({ direction: "better", delta: -1 });
    expect(metricDelta("usdPerFeature", 5, 4)).toMatchObject({ direction: "worse", delta: 1 });
  });

  it("calls only an exactly equal pair flat — there is no second hidden threshold", () => {
    expect(metricDelta("reviewRounds", 2, 2)?.direction).toBe("flat");
    expect(metricDelta("reviewRounds", 2.01, 2)?.direction).toBe("worse");
  });

  it("reports no ratio against a zero baseline, keeping the absolute delta", () => {
    const delta = metricDelta("escalations", 0.5, 0);
    expect(delta?.ratio).toBeUndefined();
    expect(delta?.delta).toBe(0.5);
    expect(delta?.direction).toBe("worse");
  });

  it("is undefined when either side is missing or unreadable", () => {
    expect(metricDelta("usdPerFeature", undefined, 4)).toBeUndefined();
    expect(metricDelta("usdPerFeature", 3, undefined)).toBeUndefined();
    expect(metricDelta("usdPerFeature", Number.NaN, 4)).toBeUndefined();
    expect(metricDelta("usdPerFeature", 3, Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("promptSeries: grouping on the stamp tuple", () => {
  it("keys cohorts on the dimension's column, carrying n, window and per-feature averages", () => {
    const series = promptSeries(
      [
        ...deliveries(5, { key: OLD_PROMPT, at: AUG_2, usd: 5, reviewRounds: 3, humanTouches: 2, escalations: 1 }),
        ...deliveries(5, { key: NEW_PROMPT, at: SEP_4, usd: 3, reviewRounds: 1, humanTouches: 1, escalations: 0 }),
      ],
      "prompt",
    );

    expect(series.dimension).toBe("prompt");
    expect(series.cohorts.map((cohort) => cohort.key)).toEqual([OLD_PROMPT, NEW_PROMPT]);

    const [old, next] = series.cohorts;
    expect(old.n).toBe(5);
    expect(old.window).toEqual({ firstDeliveryMs: AUG_2, lastDeliveryMs: AUG_2 });
    // Per-DELIVERED-feature averages, not sums: five features at $5 each is $5/feature.
    expect(old.metrics).toEqual({
      usdPerFeature: 5,
      reviewRounds: 3,
      humanTouches: 2,
      escalations: 1,
    });
    expect(next.metrics.usdPerFeature).toBe(3);
  });

  it("reads each dimension off its own column, so one fixture folds five different ways", () => {
    // "The same fold, keyed differently" — agent and skill are dimensions of the tuple, not machinery
    // of their own (design §cohorts by agent and by skill).
    const rows = [
      {
        promptDigest: "p1",
        formulaDigest: "f1",
        antonVersion: "0.6.0",
        agentTag: "agent:nextjs",
        skillDigest: "s1",
      },
    ];
    const feature = [{ beadId: "anton-1", delivered: true, deliveredAtMs: AUG_2, usd: 1, rows }];

    expect(promptSeries(feature, "prompt").cohorts[0]?.key).toBe("p1");
    expect(promptSeries(feature, "formula").cohorts[0]?.key).toBe("f1");
    expect(promptSeries(feature, "anton").cohorts[0]?.key).toBe("0.6.0");
    expect(promptSeries(feature, "agent").cohorts[0]?.key).toBe("agent:nextjs");
    expect(promptSeries(feature, "skill").cohorts[0]?.key).toBe("s1");
  });

  it("declares a column for every dimension the view can select", () => {
    for (const { value } of COHORT_DIMENSIONS) expect(DIMENSION_COLUMNS[value]).toBeDefined();
  });

  it("orders cohorts by FIRST delivery so a still-accruing cohort cannot overtake its predecessor", () => {
    const series = promptSeries(
      [
        // The newer cohort delivered LAST most recently, but started later — it must still sort second.
        ...deliveries(2, { key: OLD_PROMPT, at: AUG_2 }),
        ...deliveries(2, { key: NEW_PROMPT, at: SEP_4 }),
        ...deliveries(1, { key: OLD_PROMPT, at: SEP_4 - DAY, bead: "old-late" }),
      ],
      "prompt",
    );

    expect(series.cohorts.map((cohort) => cohort.key)).toEqual([OLD_PROMPT, NEW_PROMPT]);
    expect(series.cohorts[0]?.window).toEqual({ firstDeliveryMs: AUG_2, lastDeliveryMs: SEP_4 - DAY });
  });

  it("splits a stamp used, replaced, and later restored into separate episodes (PR #331 review)", () => {
    // anton v1 ran cheap, v2 ran expensive, then v1 came BACK — a rollback, not merely a straggler
    // delivery still inside v1's own window. Pooling both v1 periods into one cohort (keyed only on
    // the value) would average $2 and $100 into $51, and v2's own delta would be drawn against that
    // blend instead of the $2 v1 actually cost when v2 ran — reversing the arrow from "v2 got
    // pricier" to "v2 got cheaper".
    const series = promptSeries(
      [
        ...deliveries(5, { key: OLD_VERSION, at: JUL_1, usd: 2, dimension: "antonVersion" }),
        ...deliveries(5, { key: NEW_VERSION, at: AUG_2, usd: 10, dimension: "antonVersion" }),
        ...deliveries(5, {
          key: OLD_VERSION,
          at: SEP_4,
          usd: 100,
          bead: "old-again",
          dimension: "antonVersion",
        }),
      ],
      "anton",
    );

    expect(series.cohorts.map((cohort) => cohort.key)).toEqual([OLD_VERSION, NEW_VERSION, OLD_VERSION]);
    const [firstOld, middle, secondOld] = series.cohorts;
    expect(firstOld.window).toEqual({ firstDeliveryMs: JUL_1, lastDeliveryMs: JUL_1 });
    expect(middle.window).toEqual({ firstDeliveryMs: AUG_2, lastDeliveryMs: AUG_2 });
    expect(secondOld.window).toEqual({ firstDeliveryMs: SEP_4, lastDeliveryMs: SEP_4 });

    // v2 is measured against the $2 v1 actually cost right before it, not a blend polluted by v1's
    // later, pricier return.
    expect(middle.comparable && middle.deltas[0]).toMatchObject({
      metric: "usdPerFeature",
      delta: 8,
      direction: "worse",
    });
    // v1's second episode is measured against v2, immediately before it — not folded back into its
    // own first episode, and not left without a predecessor either.
    expect(secondOld.comparable && secondOld.deltas[0]).toMatchObject({
      metric: "usdPerFeature",
      delta: 90,
      direction: "worse",
    });
  });

  it("keeps a whole-second delivery tie's same-key features contiguous regardless of input order (PR #331 review)", () => {
    // Five features all deliver in the same second (AUG_2) — the timestamp comparator alone cannot
    // order them, so a stable sort leaves ties exactly where `features` handed them in. Interleaving
    // OLD/NEW/OLD/NEW/OLD reproduces the bug directly: a time-only sort would leave this order
    // untouched, fragmenting OLD's three features into three separate single-feature episodes
    // (each one bracketed by a NEW delivery) instead of the one three-feature cohort they belong to.
    const series = promptSeries(
      [
        { beadId: "old-0", delivered: true, deliveredAtMs: AUG_2, usd: 1, rows: [{ promptDigest: OLD_PROMPT }] },
        { beadId: "new-0", delivered: true, deliveredAtMs: AUG_2, usd: 1, rows: [{ promptDigest: NEW_PROMPT }] },
        { beadId: "old-1", delivered: true, deliveredAtMs: AUG_2, usd: 1, rows: [{ promptDigest: OLD_PROMPT }] },
        { beadId: "new-1", delivered: true, deliveredAtMs: AUG_2, usd: 1, rows: [{ promptDigest: NEW_PROMPT }] },
        { beadId: "old-2", delivered: true, deliveredAtMs: AUG_2, usd: 1, rows: [{ promptDigest: OLD_PROMPT }] },
      ],
      "prompt",
    );

    expect(series.cohorts).toHaveLength(2);
    expect(series.cohorts.map((cohort) => cohort.basis.features).sort()).toEqual([2, 3]);
  });

  it("draws no delta between two keys tied on the same delivered second, regardless of key spelling (fresh review feedback, PR #331)", () => {
    // Both cohorts deliver entirely within the same recorded second (AUG_2) — nothing in the data
    // says which ran first. `Z_PROMPT` sorts AFTER `OLD_PROMPT` lexically; a comparator that treats
    // that tie-break as chronology would present one cohort's usd as a delta baseline for the
    // other's, purely because of how the two digests happen to compare as strings.
    const Z_PROMPT = "zzzz9999";
    const series = promptSeries(
      [
        ...deliveries(5, { key: OLD_PROMPT, at: AUG_2, usd: 1 }),
        ...deliveries(5, { key: Z_PROMPT, at: AUG_2, usd: 100 }),
      ],
      "prompt",
    );

    expect(series.cohorts).toHaveLength(2);
    for (const cohort of series.cohorts) {
      expect(cohort.comparable && cohort.deltas).toEqual([]);
    }
  });

  it("draws no delta for the cohort AFTER a tied pair either, regardless of which tied key sorts last (PR #331 review)", () => {
    // OLD_PROMPT and Z_PROMPT tie on AUG_2 — the data cannot say which actually preceded the other,
    // so neither can be "the" cohort that preceded NEW_PROMPT's later, unambiguous delivery either.
    // A comparator that only suppressed the comparison WITHIN the tied pair would still let NEW_PROMPT
    // draw its baseline from whichever tied key `byWindow`'s alphabetical tie-break happens to sort
    // last — reversible by nothing more than renaming the two tied prompts.
    const Z_PROMPT = "zzzz9999";
    const THIRD_PROMPT = "5555dddd";

    const tiedFirst = promptSeries(
      [
        ...deliveries(5, { key: OLD_PROMPT, at: AUG_2, usd: 1 }),
        ...deliveries(5, { key: Z_PROMPT, at: AUG_2, usd: 100 }),
        ...deliveries(5, { key: NEW_PROMPT, at: SEP_4, usd: 3 }),
      ],
      "prompt",
    );
    expect(tiedFirst.cohorts).toHaveLength(3);
    const lastOfTiedFirst = tiedFirst.cohorts[2];
    expect(lastOfTiedFirst?.key).toBe(NEW_PROMPT);
    expect(lastOfTiedFirst?.comparable && lastOfTiedFirst.deltas).toEqual([]);

    // Same shape, but the tied pair's alphabetical order is reversed (THIRD_PROMPT sorts before
    // OLD_PROMPT) — the outcome for the trailing cohort must not change.
    const tiedReversed = promptSeries(
      [
        ...deliveries(5, { key: OLD_PROMPT, at: AUG_2, usd: 1 }),
        ...deliveries(5, { key: THIRD_PROMPT, at: AUG_2, usd: 100 }),
        ...deliveries(5, { key: NEW_PROMPT, at: SEP_4, usd: 3 }),
      ],
      "prompt",
    );
    expect(tiedReversed.cohorts).toHaveLength(3);
    const lastOfTiedReversed = tiedReversed.cohorts[2];
    expect(lastOfTiedReversed?.key).toBe(NEW_PROMPT);
    expect(lastOfTiedReversed?.comparable && lastOfTiedReversed.deltas).toEqual([]);
  });

  it("attributes a failed feature to the episode it ran in, not always the newest sharing its key (PR #331 review)", () => {
    // Same v1 → v2 → v1 restoration, plus one v1 feature that never delivered. It ran during the
    // FIRST v1 episode (its activity sits right after JUL_1) — folding it into the second v1 episode
    // just because that is the last one on record for the key would inflate the LATER cohort's cost
    // with a failure from the earlier period, potentially reversing its delta against v2.
    const series = promptSeries(
      [
        ...deliveries(5, { key: OLD_VERSION, at: JUL_1, usd: 2, dimension: "antonVersion" }),
        ...deliveries(5, { key: NEW_VERSION, at: AUG_2, usd: 10, dimension: "antonVersion" }),
        ...deliveries(5, {
          key: OLD_VERSION,
          at: SEP_4,
          usd: 100,
          bead: "old-again",
          dimension: "antonVersion",
        }),
        {
          beadId: "failed-during-first-a",
          delivered: false,
          activityAtMs: JUL_1 + DAY,
          usd: 1000,
          rows: [{ antonVersion: OLD_VERSION }],
        },
      ],
      "anton",
    );

    const [firstOld, , secondOld] = series.cohorts;
    expect(firstOld.basis.features).toBe(6);
    expect(secondOld.basis.features).toBe(5);
  });

  it("attributes a pre-delivery failure to the RESTORED episode once the intervening one has started (PR #331 review)", () => {
    // Same v1 → v2 → v1 restoration, but the failed v1 attempt this time runs AFTER v2 has already
    // started (AUG_2) and BEFORE the restored v1 cohort delivers anything (SEP_4). v1's original
    // episode closed the moment v2 opened, so this failure is pre-delivery work for the RESTORED
    // episode, not a straggler from the first one — folding it into the first v1 cohort would inflate
    // that cohort's cost and could reverse v2's own delta against it.
    const series = promptSeries(
      [
        ...deliveries(5, { key: OLD_VERSION, at: JUL_1, usd: 2, dimension: "antonVersion" }),
        ...deliveries(5, { key: NEW_VERSION, at: AUG_2, usd: 10, dimension: "antonVersion" }),
        ...deliveries(5, {
          key: OLD_VERSION,
          at: SEP_4,
          usd: 100,
          bead: "old-again",
          dimension: "antonVersion",
        }),
        {
          beadId: "failed-after-b-started",
          delivered: false,
          activityAtMs: AUG_2 + DAY,
          usd: 1000,
          rows: [{ antonVersion: OLD_VERSION }],
        },
      ],
      "anton",
    );

    const [firstOld, , secondOld] = series.cohorts;
    expect(firstOld.basis.features).toBe(5);
    expect(secondOld.basis.features).toBe(6);
  });

  it("measures each cohort against the one immediately before it in delivery order", () => {
    const series = promptSeries(
      [
        ...deliveries(6, { key: OLD_PROMPT, at: AUG_2, usd: 6 }),
        ...deliveries(6, { key: NEW_PROMPT, at: SEP_4, usd: 3 }),
      ],
      "prompt",
    );

    const [old, next] = series.cohorts;
    // The first cohort has nothing to move against.
    expect(old.comparable && old.deltas).toEqual([]);
    expect(next.comparable && next.deltas[0]).toMatchObject({
      metric: "usdPerFeature",
      delta: -3,
      direction: "better",
    });
  });

  it("draws no delta between two identity cohorts whose delivery windows overlap (fresh review feedback, PR #331)", () => {
    // An identity dimension (agent/skill) aggregates EVERY delivery of a key across the feature's
    // whole history into one cohort — so alternating identities routinely overlap instead of
    // handing off cleanly like a prompt/formula/anton revision does. Agent A delivers at JUL_1 and
    // again at SEP_4; agent B delivers in between, at AUG_2. `byWindow` still sorts A first (its
    // FIRST delivery is earliest), but A's own average already includes the SEP_4 batch — which
    // lands strictly after every one of B's deliveries. Presenting that blended average as "the
    // cohort before B" would let A's later deliveries keep changing (or reversing) a delta already
    // shown as B's baseline, long after B's own window closed.
    const series = promptSeries(
      [
        ...deliveries(3, { key: "agent:a", at: JUL_1, usd: 2, dimension: "agentTag" }),
        ...deliveries(5, { key: "agent:b", at: AUG_2, usd: 10, dimension: "agentTag" }),
        ...deliveries(2, { key: "agent:a", at: SEP_4, usd: 100, bead: "a-again", dimension: "agentTag" }),
      ],
      "agent",
    );

    expect(series.cohorts.map((cohort) => cohort.key)).toEqual(["agent:a", "agent:b"]);
    const [a, b] = series.cohorts;
    // A is one cohort (identity dimension: no reversion split), spanning both its episodes.
    expect(a.window).toEqual({ firstDeliveryMs: JUL_1, lastDeliveryMs: SEP_4 });
    expect(b.comparable && b.deltas).toEqual([]);
  });

  it("folds a repeated bead once, so a doubled feature cannot inflate an average", () => {
    const one = { beadId: "anton-1", delivered: true, deliveredAtMs: AUG_2, usd: 4, rows: [{ promptDigest: OLD_PROMPT }] };
    const series = promptSeries([one, one], "prompt");

    expect(series.cohorts[0]?.n).toBe(1);
    expect(series.cohorts[0]?.basis.features).toBe(1);
  });

  it("returns no cohorts at all for no features — an empty comparison, not a flat one", () => {
    expect(promptSeries([], "prompt")).toEqual({
      dimension: "prompt",
      cohorts: [],
      spanning: { delivered: 0, features: 0 },
    });
  });
});

describe("promptSeries: only DELIVERED features count toward n", () => {
  it("keeps a gave-up run's spend in the numerator while it counts nothing toward n", () => {
    // The named regression for the denominator rule: this cohort burned $12 across four runs and
    // shipped one feature, so it is EXPENSIVE — the reading a dropped numerator would invert.
    const series = promptSeries(
      [
        { beadId: "shipped", delivered: true, deliveredAtMs: AUG_2, usd: 3, rows: [{ promptDigest: OLD_PROMPT }] },
        ...[1, 2, 3].map((i) => ({
          beadId: `gave-up-${i}`,
          delivered: false,
          usd: 3,
          rows: [{ promptDigest: OLD_PROMPT }],
        })),
      ],
      "prompt",
    );

    const cohort = series.cohorts[0]!;
    expect(cohort.n).toBe(1);
    // Four features' spend, one delivery — the whole $12 lands on the one thing that shipped.
    expect(cohort.basis.features).toBe(4);
    expect(cohort.metrics.usdPerFeature).toBe(12);
  });

  it("reports a cohort that mostly gave up as COSTLIER than one that delivered everything", () => {
    const spend = { usd: 3, rows: [{ promptDigest: OLD_PROMPT }] };
    const gaveUp = promptSeries(
      [
        { beadId: "a", delivered: true, deliveredAtMs: AUG_2, ...spend },
        { beadId: "b", delivered: false, ...spend },
        { beadId: "c", delivered: false, ...spend },
      ],
      "prompt",
    ).cohorts[0]!;
    const clean = promptSeries(
      [
        { beadId: "a", delivered: true, deliveredAtMs: AUG_2, ...spend },
        { beadId: "b", delivered: true, deliveredAtMs: AUG_2, ...spend },
        { beadId: "c", delivered: true, deliveredAtMs: AUG_2, ...spend },
      ],
      "prompt",
    ).cohorts[0]!;

    expect(gaveUp.metrics.usdPerFeature).toBe(9);
    expect(clean.metrics.usdPerFeature).toBe(3);
    expect(gaveUp.metrics.usdPerFeature!).toBeGreaterThan(clean.metrics.usdPerFeature!);
  });

  it("counts friction over every attributed feature too, per feature DELIVERED", () => {
    const series = promptSeries(
      [
        { beadId: "a", delivered: true, deliveredAtMs: AUG_2, usd: 1, reviewRounds: 2, humanTouches: 1, escalations: 1, rows: [{ promptDigest: OLD_PROMPT }] },
        { beadId: "b", delivered: false, usd: 1, reviewRounds: 4, humanTouches: 3, escalations: 1, rows: [{ promptDigest: OLD_PROMPT }] },
      ],
      "prompt",
    );

    const cohort = series.cohorts[0]!;
    // The abandoned run's six rounds and four touches are attention this cohort really cost.
    expect(cohort.metrics.reviewRounds).toBe(6);
    expect(cohort.metrics.humanTouches).toBe(4);
    expect(cohort.metrics.escalations).toBe(2);
  });

  it("reports NO averages for a cohort that delivered nothing rather than crediting a delivery", () => {
    const series = promptSeries(
      [{ beadId: "a", delivered: false, usd: 9, reviewRounds: 3, rows: [{ promptDigest: OLD_PROMPT }] }],
      "prompt",
    );

    const cohort = series.cohorts[0]!;
    expect(cohort.n).toBe(0);
    expect(cohort.basis.features).toBe(1);
    // $9 over zero deliveries is not $9 per feature, and not $0 either — there is no such figure.
    expect(cohort.metrics).toEqual({});
    expect(cohort.comparable).toBe(false);
  });

  it("gives an unpriced cohort no cost average and says the figure is missing", () => {
    // Built inline rather than via `deliveries`: a destructuring default fires on an explicit
    // `undefined`, so the helper cannot express an UNPRICED feature.
    const series = promptSeries(
      ["a", "b"].map((beadId) => ({
        beadId,
        delivered: true,
        deliveredAtMs: AUG_2,
        usd: undefined,
        rows: [{ promptDigest: OLD_PROMPT }],
      })),
      "prompt",
    );

    const cohort = series.cohorts[0]!;
    expect(cohort.metrics.usdPerFeature).toBeUndefined();
    expect("usdPerFeature" in cohort.metrics).toBe(false);
    expect(cohort.basis.unpricedFeatures).toBe(2);
  });

  it("reports a partly-priced cohort's average as a floor rather than dividing by the unpriced", () => {
    const series = promptSeries(
      [
        { beadId: "a", delivered: true, deliveredAtMs: AUG_2, usd: 6, rows: [{ promptDigest: OLD_PROMPT }] },
        { beadId: "b", delivered: true, deliveredAtMs: AUG_2, usd: undefined, rows: [{ promptDigest: OLD_PROMPT }] },
      ],
      "prompt",
    );

    const cohort = series.cohorts[0]!;
    // $6 across two DELIVERED features — a floor, and `unpricedFeatures` is what says so.
    expect(cohort.metrics.usdPerFeature).toBe(3);
    expect(cohort.basis.unpricedFeatures).toBe(1);
  });

  it("treats a feature with a defined but partial usd as unpriced too", () => {
    // Both features priced something (`usd` is defined on each), but "a" left rows unpriced — a gap
    // that must still count toward `unpricedFeatures`, not just a fully-unpriced `usd: undefined`.
    const series = promptSeries(
      [
        {
          beadId: "a",
          delivered: true,
          deliveredAtMs: AUG_2,
          usd: 6,
          unpricedRows: 1,
          rows: [{ promptDigest: OLD_PROMPT }],
        },
        {
          beadId: "b",
          delivered: true,
          deliveredAtMs: AUG_2,
          usd: 4,
          rows: [{ promptDigest: OLD_PROMPT }],
        },
      ],
      "prompt",
    );

    const cohort = series.cohorts[0]!;
    // The floor still sums normally ($10 across two features)...
    expect(cohort.metrics.usdPerFeature).toBe(5);
    // ...but the partial feature must still mark the average as a floor, same as a fully-unpriced one.
    expect(cohort.basis.unpricedFeatures).toBe(1);
  });

  it("carries a window spanning only the DELIVERIES, never a gave-up run", () => {
    const series = promptSeries(
      [
        { beadId: "a", delivered: true, deliveredAtMs: SEP_4, usd: 1, rows: [{ promptDigest: OLD_PROMPT }] },
        { beadId: "b", delivered: false, deliveredAtMs: AUG_2, usd: 1, rows: [{ promptDigest: OLD_PROMPT }] },
      ],
      "prompt",
    );

    expect(series.cohorts[0]?.window).toEqual({ firstDeliveryMs: SEP_4, lastDeliveryMs: SEP_4 });
  });

  it("omits the window when a delivery recorded no time, rather than dating it plausibly", () => {
    const series = promptSeries(
      [{ beadId: "a", delivered: true, usd: 1, rows: [{ promptDigest: OLD_PROMPT }] }],
      "prompt",
    );

    expect(series.cohorts[0]?.n).toBe(1);
    expect(series.cohorts[0]?.window).toBeUndefined();
  });
});

describe("promptSeries: the pre-instrumentation cohort", () => {
  it("groups NULL-stamp features under their own key rather than polluting a named cohort", () => {
    const series = promptSeries(
      [
        ...deliveries(2, { key: OLD_PROMPT, at: AUG_2, usd: 5 }),
        ...deliveries(3, { key: null, at: JUL_1, usd: 9, bead: "pre" }),
      ],
      "prompt",
    );

    expect(series.cohorts.map((cohort) => cohort.key)).toEqual([null, OLD_PROMPT]);
    const pre = series.cohorts.find((cohort) => cohort.key === null)!;
    expect(pre.n).toBe(3);
    expect(pre.metrics.usdPerFeature).toBe(9);
    // The named cohort is untouched by it — that is the whole point of the separate group.
    expect(series.cohorts.find((cohort) => cohort.key === OLD_PROMPT)?.metrics.usdPerFeature).toBe(5);
  });

  it("reads a blank or whitespace-only stamp as unstamped, never as a cohort of its own", () => {
    // The never-fail-a-run rule writes a null on a digest it could not compute; a cohort keyed on ""
    // would present that failure as a prompt.
    const series = promptSeries(
      [
        { beadId: "a", delivered: true, deliveredAtMs: AUG_2, usd: 1, rows: [{ promptDigest: "" }] },
        { beadId: "b", delivered: true, deliveredAtMs: AUG_2, usd: 1, rows: [{ promptDigest: "   " }] },
        { beadId: "c", delivered: true, deliveredAtMs: AUG_2, usd: 1, rows: [{ promptDigest: null }] },
        { beadId: "d", delivered: true, deliveredAtMs: AUG_2, usd: 1, rows: [] },
      ],
      "prompt",
    );

    expect(series.cohorts).toHaveLength(1);
    expect(series.cohorts[0]?.key).toBeNull();
    expect(series.cohorts[0]?.n).toBe(4);
  });

  it("trims a stamp so one prompt recorded with stray whitespace is not two cohorts", () => {
    const series = promptSeries(
      [
        { beadId: "a", delivered: true, deliveredAtMs: AUG_2, usd: 1, rows: [{ promptDigest: OLD_PROMPT }] },
        { beadId: "b", delivered: true, deliveredAtMs: AUG_2, usd: 1, rows: [{ promptDigest: ` ${OLD_PROMPT} ` }] },
      ],
      "prompt",
    );

    expect(series.cohorts).toHaveLength(1);
    expect(series.cohorts[0]?.key).toBe(OLD_PROMPT);
  });

  it("still measures a named cohort against the pre-instrumentation one it succeeded", () => {
    // Pre-instrumentation work is not evidence about a prompt, but it IS the period before one — so it
    // sorts first and the named cohort's move is drawn from it.
    const series = promptSeries(
      [
        ...deliveries(6, { key: null, at: JUL_1, usd: 9, bead: "pre" }),
        ...deliveries(6, { key: NEW_PROMPT, at: SEP_4, usd: 3 }),
      ],
      "prompt",
    );

    const named = series.cohorts[1]!;
    expect(named.key).toBe(NEW_PROMPT);
    expect(named.comparable && named.deltas[0]).toMatchObject({ delta: -6, direction: "better" });
  });
});

describe("promptSeries: a feature spanning several values of the dimension", () => {
  it("attributes it to NEITHER cohort and counts it as the visible remainder", () => {
    // A grouped run whose tickets used two specialists belongs to neither agent's cohort: counting it
    // in both double-counts the delivery, and awarding it to the one that ran most is a proportional
    // split of exactly the kind feature-ledger refuses.
    const series = promptSeries(
      [
        ...deliveries(2, { key: "agent:nextjs", at: AUG_2, dimension: "agentTag" }),
        {
          beadId: "mixed",
          delivered: true,
          deliveredAtMs: AUG_2,
          usd: 50,
          rows: [{ agentTag: "agent:nextjs" }, { agentTag: "agent:alembic" }],
        },
      ],
      "agent",
    );

    expect(series.cohorts).toHaveLength(1);
    expect(series.cohorts[0]?.key).toBe("agent:nextjs");
    // The $50 left the fold with the feature rather than landing on one specialist.
    expect(series.cohorts[0]?.n).toBe(2);
    expect(series.cohorts[0]?.metrics.usdPerFeature).toBe(1);
    expect(series.spanning).toEqual({ delivered: 1, features: 1 });
  });

  it("counts an undelivered spanning feature in features but not in delivered", () => {
    const series = promptSeries(
      [{ beadId: "mixed", delivered: false, usd: 5, rows: [{ agentTag: "a" }, { agentTag: "b" }] }],
      "agent",
    );

    expect(series.cohorts).toEqual([]);
    expect(series.spanning).toEqual({ delivered: 0, features: 1 });
  });

  it("does not treat a feature whose rows repeat ONE value as spanning", () => {
    const series = promptSeries(
      [
        {
          beadId: "a",
          delivered: true,
          deliveredAtMs: AUG_2,
          usd: 1,
          rows: [{ promptDigest: OLD_PROMPT }, { promptDigest: OLD_PROMPT }, { promptDigest: null }],
        },
      ],
      "prompt",
    );

    // A feature that stamped one prompt and left one row unstamped named exactly one prompt.
    expect(series.spanning.features).toBe(0);
    expect(series.cohorts[0]?.key).toBe(OLD_PROMPT);
  });
});

describe("promptSeries: the skill dimension ignores anton's own scaffolding phases", () => {
  it("does not treat a feature's describe+review defaults as spanning two skills", () => {
    // A normal run stamps step:describe's and step:review's bundled fallback skill on every feature —
    // two distinct digests that name no opinion about which skill a project is trying out. Counting
    // both would route nearly every delivered feature into `spanning` instead of a cohort.
    const feature = [
      {
        beadId: "a",
        delivered: true,
        deliveredAtMs: AUG_2,
        usd: 1,
        rows: [
          { skillId: "describe", skillDigest: "describe-digest" },
          { skillId: "review", skillDigest: "review-digest" },
        ],
      },
    ];

    const series = promptSeries(feature, "skill");
    expect(series.spanning).toEqual({ delivered: 0, features: 0 });
    // No PROJECT skill named anything, but the bundled `review` default's own digest is kept as the
    // key — it is the only signal left for "did editing the bundled skill help" (PR #331 review).
    expect(series.cohorts[0]?.key).toBe("review-digest");
  });

  it("still attributes a feature to the specialist skill it ran alongside the scaffolding phases", () => {
    const feature = [
      {
        beadId: "a",
        delivered: true,
        deliveredAtMs: AUG_2,
        usd: 1,
        rows: [
          { skillId: "describe", skillDigest: "describe-digest" },
          { skillId: "review", skillDigest: "review-digest" },
          { skillId: "nextjs", skillDigest: "nextjs-digest" },
        ],
      },
    ];

    const series = promptSeries(feature, "skill");
    expect(series.spanning).toEqual({ delivered: 0, features: 0 });
    expect(series.cohorts[0]?.key).toBe("nextjs-digest");
  });

  it("still treats two REAL specialist skills on one feature as spanning", () => {
    const feature = [
      {
        beadId: "a",
        delivered: true,
        deliveredAtMs: AUG_2,
        usd: 1,
        rows: [
          { skillId: "nextjs", skillDigest: "nextjs-digest" },
          { skillId: "supabase", skillDigest: "supabase-digest" },
        ],
      },
    ];

    const series = promptSeries(feature, "skill");
    expect(series.spanning).toEqual({ delivered: 1, features: 1 });
    expect(series.cohorts).toEqual([]);
  });

  it("keeps a project's explicitly-configured skill even when it shares a scaffolding id (PR #331 review)", () => {
    // `resolveDescribeContract` permits `skill:review`, loading the PROJECT's own `.claude/skills/
    // review` — a legitimate choice that must not be discarded just because its id collides with the
    // bundled review fallback's. `skillIsDefault: false` is what tells the two apart.
    const feature = [
      {
        beadId: "a",
        delivered: true,
        deliveredAtMs: AUG_2,
        usd: 1,
        rows: [{ skillId: "review", skillDigest: "project-review-digest", skillIsDefault: false }],
      },
    ];

    const series = promptSeries(feature, "skill");
    expect(series.spanning).toEqual({ delivered: 0, features: 0 });
    expect(series.cohorts[0]?.key).toBe("project-review-digest");
  });

  it("still recognizes the bundled fallback when a row explicitly marks it, not just by id", () => {
    const feature = [
      {
        beadId: "a",
        delivered: true,
        deliveredAtMs: AUG_2,
        usd: 1,
        rows: [
          { skillId: "describe", skillDigest: "describe-digest", skillIsDefault: true },
          { skillId: "review", skillDigest: "review-digest", skillIsDefault: true },
        ],
      },
    ];

    const series = promptSeries(feature, "skill");
    expect(series.spanning).toEqual({ delivered: 0, features: 0 });
    // Explicitly marked rather than id-inferred, but still the bundled review default — its digest
    // is kept as the key for the same reason the id-inferred case above is.
    expect(series.cohorts[0]?.key).toBe("review-digest");
  });

  it("attributes a feature to the bundled review-fix skill when that's the only fallback it ran (PR #331 review)", () => {
    // Restricting the fallback to `review` alone silently dropped any signal from editing the
    // bundled `review-fix` skill's own text — a feature that only ran review-fix read as having
    // named no skill at all instead of the bundled skill it actually ran under.
    const feature = [
      {
        beadId: "a",
        delivered: true,
        deliveredAtMs: AUG_2,
        usd: 1,
        rows: [
          { skillId: "describe", skillDigest: "describe-digest" },
          { skillId: "review-fix", skillDigest: "review-fix-digest" },
        ],
      },
    ];

    const series = promptSeries(feature, "skill");
    expect(series.spanning).toEqual({ delivered: 0, features: 0 });
    expect(series.cohorts[0]?.key).toBe("review-fix-digest");
  });

  it("attributes a review-then-fix feature to review-fix's digest, not spanning the pair (PR #331 review)", () => {
    // `review-fix` only ever runs as `review`'s own correction round on the SAME feature — this is
    // the ordinary shape of a fix round, not a feature ambiguously running under two competing
    // skills. Unioning both digests into `spanning` (the earlier fallback-skill fix's reading)
    // dropped every fix-round feature from the one cohort meant to measure editing `review-fix`
    // itself.
    const feature = [
      {
        beadId: "a",
        delivered: true,
        deliveredAtMs: AUG_2,
        usd: 1,
        rows: [
          { skillId: "review", skillDigest: "review-digest" },
          { skillId: "review-fix", skillDigest: "review-fix-digest" },
        ],
      },
    ];

    const series = promptSeries(feature, "skill");
    expect(series.spanning).toEqual({ delivered: 0, features: 0 });
    expect(series.cohorts[0]?.key).toBe("review-fix-digest");
  });

  it("still treats two DIFFERENT digests within the SAME fallback phase as spanning", () => {
    // Two `review-fix` rows disagreeing on digest means the bundled `review-fix` file itself
    // changed mid-feature — that is genuine ambiguity within one phase, unlike the review/review-fix
    // pairing above.
    const feature = [
      {
        beadId: "a",
        delivered: true,
        deliveredAtMs: AUG_2,
        usd: 1,
        rows: [
          { skillId: "review-fix", skillDigest: "review-fix-digest-1" },
          { skillId: "review-fix", skillDigest: "review-fix-digest-2" },
        ],
      },
    ];

    const series = promptSeries(feature, "skill");
    expect(series.spanning).toEqual({ delivered: 1, features: 1 });
    expect(series.cohorts).toEqual([]);
  });

  it("falls back to the pre-instrumentation cohort when even the review default named no digest", () => {
    // A row that ran under NO skill at all (no describe, no review, nothing) has nothing for
    // featureKeys' fallback to pick up either — it must still land in the null cohort rather than
    // throw or silently invent a key.
    const feature = [
      {
        beadId: "a",
        delivered: true,
        deliveredAtMs: AUG_2,
        usd: 1,
        rows: [{}],
      },
    ];

    const series = promptSeries(feature, "skill");
    expect(series.spanning).toEqual({ delivered: 0, features: 0 });
    expect(series.cohorts[0]?.key).toBeNull();
  });
});

describe("promptSeries: the prompt dimension ignores the describer's own system prompt", () => {
  it("does not treat an agent-run feature's describer digest as a second prompt", () => {
    // `step:describe` composes base+seed only (no agent layer), so an agent-run feature's describer
    // invocation records a DIFFERENT promptDigest than the implementer that actually did the work
    // (PR #331 review). Counting it would throw nearly every agent-run delivered feature into
    // `spanning` instead of the cohort its implementation ran under.
    const feature = [
      {
        beadId: "a",
        delivered: true,
        deliveredAtMs: AUG_2,
        usd: 1,
        rows: [
          { promptDigest: "base-only-digest", stepHandler: "describe" },
          { promptDigest: NEW_PROMPT, stepHandler: "implement" },
        ],
      },
    ];

    const series = promptSeries(feature, "prompt");
    expect(series.spanning).toEqual({ delivered: 0, features: 0 });
    expect(series.cohorts[0]?.key).toBe(NEW_PROMPT);
  });

  it("still treats two REAL implementation prompts on one feature as spanning", () => {
    const feature = [
      {
        beadId: "a",
        delivered: true,
        deliveredAtMs: AUG_2,
        usd: 1,
        rows: [
          { promptDigest: OLD_PROMPT, stepHandler: "implement" },
          { promptDigest: NEW_PROMPT, stepHandler: "implement" },
        ],
      },
    ];

    const series = promptSeries(feature, "prompt");
    expect(series.spanning).toEqual({ delivered: 1, features: 1 });
    expect(series.cohorts).toEqual([]);
  });

  it("still counts the describer's digest under every OTHER dimension", () => {
    const feature = [
      {
        beadId: "a",
        delivered: true,
        deliveredAtMs: AUG_2,
        usd: 1,
        rows: [{ formulaDigest: "formula-digest", stepHandler: "describe" }],
      },
    ];

    const series = promptSeries(feature, "formula");
    expect(series.spanning).toEqual({ delivered: 0, features: 0 });
    expect(series.cohorts[0]?.key).toBe("formula-digest");
  });
});

describe("promptSeries: the agent dimension ignores the reviewer's own agent tag", () => {
  it("does not treat a dedicated reviewAgent as a second agent on the feature", () => {
    // `review-gate.ts` stamps the review meter with the resolved `reviewAgent`, which a project can
    // configure as a specialist distinct from the ticket's own `agent:` tag. Counting it as a second
    // "agent" this feature ran under would throw every reviewed feature into `spanning` instead of
    // the cohort its implementation ran under (PR #331 review).
    const feature = [
      {
        beadId: "a",
        delivered: true,
        deliveredAtMs: AUG_2,
        usd: 1,
        rows: [
          { agentTag: "agent:nextjs", stepHandler: "implement" },
          { agentTag: "agent:reviewer", stepHandler: "review" },
        ],
      },
    ];

    const series = promptSeries(feature, "agent");
    expect(series.spanning).toEqual({ delivered: 0, features: 0 });
    expect(series.cohorts[0]?.key).toBe("agent:nextjs");
  });

  it("still treats two REAL implementation agent tags on one feature as spanning", () => {
    const feature = [
      {
        beadId: "a",
        delivered: true,
        deliveredAtMs: AUG_2,
        usd: 1,
        rows: [
          { agentTag: "agent:nextjs", stepHandler: "implement" },
          { agentTag: "agent:alembic", stepHandler: "implement" },
        ],
      },
    ];

    const series = promptSeries(feature, "agent");
    expect(series.spanning).toEqual({ delivered: 1, features: 1 });
    expect(series.cohorts).toEqual([]);
  });

  it("still counts the reviewer's agent tag under every OTHER dimension", () => {
    const feature = [
      {
        beadId: "a",
        delivered: true,
        deliveredAtMs: AUG_2,
        usd: 1,
        rows: [{ formulaDigest: "formula-digest", agentTag: "agent:reviewer", stepHandler: "review" }],
      },
    ];

    const series = promptSeries(feature, "formula");
    expect(series.spanning).toEqual({ delivered: 0, features: 0 });
    expect(series.cohorts[0]?.key).toBe("formula-digest");
  });

  it("does not drop a review-fix round's own agent tag just because it shares the review row's stepHandler (PR #331 review, boundary follow-up)", () => {
    // `review-gate.ts`'s `meter` stamps BOTH the review session (`step: "review"`) and the fix
    // session (`step: "review-fix"`) with the same `stepHandler: "review"` — only `step` tells them
    // apart. The fix session's `agentTag` is the TARGET's own implementer tag, not the reviewer's, so
    // excluding every `stepHandler === "review"` row indiscriminately silently dropped it too.
    const feature = [
      {
        beadId: "a",
        delivered: true,
        deliveredAtMs: AUG_2,
        usd: 1,
        rows: [
          { agentTag: "agent:nextjs", stepHandler: "implement" },
          { agentTag: "agent:reviewer", stepHandler: "review", step: "review" },
          // Escalated to a different specialist mid-flight for the fix round.
          { agentTag: "agent:alembic", stepHandler: "review", step: "review-fix" },
        ],
      },
    ];

    const series = promptSeries(feature, "agent");
    // The differing fix-round tag correctly flags this as a feature that spanned two agents — the
    // exact misattribution this dimension exists to catch — rather than silently folding into
    // "agent:nextjs" alone.
    expect(series.spanning).toEqual({ delivered: 1, features: 1 });
    expect(series.cohorts).toEqual([]);
  });

  it("still folds into one cohort when the review-fix round's agent tag matches the implementer's own", () => {
    const feature = [
      {
        beadId: "a",
        delivered: true,
        deliveredAtMs: AUG_2,
        usd: 1,
        rows: [
          { agentTag: "agent:nextjs", stepHandler: "implement" },
          { agentTag: "agent:reviewer", stepHandler: "review", step: "review" },
          { agentTag: "agent:nextjs", stepHandler: "review", step: "review-fix" },
        ],
      },
    ];

    const series = promptSeries(feature, "agent");
    expect(series.spanning).toEqual({ delivered: 0, features: 0 });
    expect(series.cohorts[0]?.key).toBe("agent:nextjs");
  });
});

describe("promptSeries: identity dimensions group across noncontiguous deliveries (P1, PR #331 review)", () => {
  it("folds an alternating agent sequence into one cohort per agent, not one per contiguous run", () => {
    // Two specialists alternate ticket-by-ticket — nextjs, supabase, nextjs, supabase — five
    // deliveries apiece. Reading this the way a revision dimension does (a fresh episode on every
    // key change) would produce four `n=1`-ish episodes, none reaching MIN_COHORT; grouping by key
    // instead should reunite each agent's five deliveries into one comparable cohort.
    const series = promptSeries(
      [
        ...deliveries(1, { key: "agent:nextjs", at: JUL_1, dimension: "agentTag", bead: "nextjs-1" }),
        ...deliveries(1, { key: "agent:supabase", at: JUL_1, dimension: "agentTag", bead: "supabase-1" }),
        ...deliveries(1, { key: "agent:nextjs", at: AUG_2, dimension: "agentTag", bead: "nextjs-2" }),
        ...deliveries(1, { key: "agent:supabase", at: AUG_2, dimension: "agentTag", bead: "supabase-2" }),
        ...deliveries(1, { key: "agent:nextjs", at: SEP_4, dimension: "agentTag", bead: "nextjs-3" }),
        ...deliveries(1, { key: "agent:supabase", at: SEP_4, dimension: "agentTag", bead: "supabase-3" }),
        ...deliveries(1, {
          key: "agent:nextjs",
          at: SEP_4 + DAY,
          dimension: "agentTag",
          bead: "nextjs-4",
        }),
        ...deliveries(1, {
          key: "agent:supabase",
          at: SEP_4 + DAY,
          dimension: "agentTag",
          bead: "supabase-4",
        }),
        ...deliveries(1, {
          key: "agent:nextjs",
          at: SEP_4 + 2 * DAY,
          dimension: "agentTag",
          bead: "nextjs-5",
        }),
        ...deliveries(1, {
          key: "agent:supabase",
          at: SEP_4 + 2 * DAY,
          dimension: "agentTag",
          bead: "supabase-5",
        }),
      ],
      "agent",
    );

    expect(series.cohorts).toHaveLength(2);
    for (const cohort of series.cohorts) {
      expect(cohort.basis.features).toBe(5);
      expect(cohort.comparable).toBe(true);
    }
    expect(series.cohorts.map((cohort) => cohort.key).sort()).toEqual(["agent:nextjs", "agent:supabase"]);
  });

  it("folds an alternating prompt sequence into one cohort per prompt, not one per contiguous run (P1, PR #331 review, formula/prompt follow-up)", () => {
    // A composed prompt's digest recurs whenever the ticket's own resolved agent layer recurs —
    // alternating specialists walks OLD_PROMPT/NEW_PROMPT back and forth without either text ever
    // having been edited. Reading that as a revision would open a fresh n=1 episode on every swap;
    // grouping by key instead reunites each prompt's five deliveries into one comparable cohort.
    const series = promptSeries(
      [
        ...deliveries(1, { key: OLD_PROMPT, at: JUL_1, bead: "old-1" }),
        ...deliveries(1, { key: NEW_PROMPT, at: JUL_1, bead: "new-1" }),
        ...deliveries(1, { key: OLD_PROMPT, at: AUG_2, bead: "old-2" }),
        ...deliveries(1, { key: NEW_PROMPT, at: AUG_2, bead: "new-2" }),
        ...deliveries(1, { key: OLD_PROMPT, at: SEP_4, bead: "old-3" }),
        ...deliveries(1, { key: NEW_PROMPT, at: SEP_4, bead: "new-3" }),
        ...deliveries(1, { key: OLD_PROMPT, at: SEP_4 + DAY, bead: "old-4" }),
        ...deliveries(1, { key: NEW_PROMPT, at: SEP_4 + DAY, bead: "new-4" }),
        ...deliveries(1, { key: OLD_PROMPT, at: SEP_4 + 2 * DAY, bead: "old-5" }),
        ...deliveries(1, { key: NEW_PROMPT, at: SEP_4 + 2 * DAY, bead: "new-5" }),
      ],
      "prompt",
    );

    expect(series.cohorts).toHaveLength(2);
    for (const cohort of series.cohorts) {
      expect(cohort.basis.features).toBe(5);
      expect(cohort.comparable).toBe(true);
    }
    expect(series.cohorts.map((cohort) => cohort.key).sort()).toEqual([NEW_PROMPT, OLD_PROMPT]);
  });

  it("folds an alternating formula sequence into one cohort per variant, not one per contiguous run (P1, PR #331 review, formula/prompt follow-up)", () => {
    // `selectRunFormula` chooses the variant from the run target's own labels, so a project
    // alternating risk:high and default tickets walks the same two variants back and forth without
    // either variant's own file ever having changed.
    const series = promptSeries(
      [
        ...deliveries(1, { key: "default", at: JUL_1, dimension: "formulaDigest", bead: "default-1" }),
        ...deliveries(1, { key: "risk-high", at: JUL_1, dimension: "formulaDigest", bead: "high-1" }),
        ...deliveries(1, { key: "default", at: AUG_2, dimension: "formulaDigest", bead: "default-2" }),
        ...deliveries(1, { key: "risk-high", at: AUG_2, dimension: "formulaDigest", bead: "high-2" }),
        ...deliveries(1, { key: "default", at: SEP_4, dimension: "formulaDigest", bead: "default-3" }),
        ...deliveries(1, { key: "risk-high", at: SEP_4, dimension: "formulaDigest", bead: "high-3" }),
        ...deliveries(1, {
          key: "default",
          at: SEP_4 + DAY,
          dimension: "formulaDigest",
          bead: "default-4",
        }),
        ...deliveries(1, { key: "risk-high", at: SEP_4 + DAY, dimension: "formulaDigest", bead: "high-4" }),
        ...deliveries(1, {
          key: "default",
          at: SEP_4 + 2 * DAY,
          dimension: "formulaDigest",
          bead: "default-5",
        }),
        ...deliveries(1, {
          key: "risk-high",
          at: SEP_4 + 2 * DAY,
          dimension: "formulaDigest",
          bead: "high-5",
        }),
      ],
      "formula",
    );

    expect(series.cohorts).toHaveLength(2);
    for (const cohort of series.cohorts) {
      expect(cohort.basis.features).toBe(5);
      expect(cohort.comparable).toBe(true);
    }
    expect(series.cohorts.map((cohort) => cohort.key).sort()).toEqual(["default", "risk-high"]);
  });

  it("still splits the anton dimension into separate episodes given the same alternating shape", () => {
    // Same alternation, but on `anton` — the one remaining genuine revision dimension — where a
    // repeated value IS two distinct episodes rather than one bucket, so this must NOT collapse the
    // way prompt/formula/agent/skill now do.
    const series = promptSeries(
      [
        ...deliveries(1, { key: OLD_VERSION, at: JUL_1, bead: "old-1", dimension: "antonVersion" }),
        ...deliveries(1, { key: NEW_VERSION, at: AUG_2, bead: "new-1", dimension: "antonVersion" }),
        ...deliveries(1, { key: OLD_VERSION, at: SEP_4, bead: "old-2", dimension: "antonVersion" }),
      ],
      "anton",
    );

    expect(series.cohorts.map((cohort) => cohort.key)).toEqual([OLD_VERSION, NEW_VERSION, OLD_VERSION]);
  });
});

describe("promptSeries: what the cohort reports about the antons it spans", () => {
  it("flags a cohort whose features ran under two antons", () => {
    const series = promptSeries(
      [
        { beadId: "a", delivered: true, deliveredAtMs: AUG_2, usd: 1, rows: [{ promptDigest: OLD_PROMPT, antonVersion: "0.5.0" }] },
        { beadId: "b", delivered: true, deliveredAtMs: AUG_2, usd: 1, rows: [{ promptDigest: OLD_PROMPT, antonVersion: "0.6.0" }] },
      ],
      "prompt",
    );

    expect(series.cohorts[0]?.versions).toEqual({
      versions: ["0.5.0", "0.6.0"],
      mixed: true,
      unstamped: 0,
    });
  });

  it("counts a feature ONCE per distinct anton it ran under, not once per row", () => {
    const series = promptSeries(
      [
        {
          beadId: "a",
          delivered: true,
          deliveredAtMs: AUG_2,
          usd: 1,
          // Four rows, one anton — a feature is not four features' worth of evidence about it.
          rows: Array.from({ length: 4 }, () => ({ promptDigest: OLD_PROMPT, antonVersion: "0.6.0" })),
        },
        { beadId: "b", delivered: true, deliveredAtMs: AUG_2, usd: 1, rows: [{ promptDigest: OLD_PROMPT, antonVersion: "0.5.0" }] },
      ],
      "prompt",
    );

    // Ordered by how many FEATURES saw each, so a one-feature version does not lose to a chatty one.
    expect(series.cohorts[0]?.versions.versions).toEqual(["0.5.0", "0.6.0"]);
  });

  it("flags a feature that itself ran under two antons — it moved for two reasons alone", () => {
    const series = promptSeries(
      [
        {
          beadId: "a",
          delivered: true,
          deliveredAtMs: AUG_2,
          usd: 1,
          rows: [{ promptDigest: OLD_PROMPT, antonVersion: "0.5.0" }, { promptDigest: OLD_PROMPT, antonVersion: "0.6.0" }],
        },
      ],
      "prompt",
    );

    expect(series.cohorts[0]?.versions.mixed).toBe(true);
  });

  it("counts a feature that recorded no anton as one unstamped feature", () => {
    const series = promptSeries(
      [
        { beadId: "a", delivered: true, deliveredAtMs: AUG_2, usd: 1, rows: [{ promptDigest: OLD_PROMPT, antonVersion: "0.6.0" }] },
        { beadId: "b", delivered: true, deliveredAtMs: AUG_2, usd: 1, rows: [{ promptDigest: OLD_PROMPT }, { promptDigest: OLD_PROMPT }] },
      ],
      "prompt",
    );

    expect(series.cohorts[0]?.versions).toEqual({
      versions: ["0.6.0"],
      mixed: true,
      unstamped: 1,
    });
  });
});
