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
    // them would route nearly every delivered feature into `spanning` instead of a cohort.
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
    // Nothing named a real skill, so the feature lands in the pre-instrumentation cohort.
    expect(series.cohorts[0]?.key).toBeNull();
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
