import { describe, expect, it } from "vitest";

import {
  COHORT_METRICS,
  MIN_COHORT,
  METRIC_IMPROVES,
  cohortStanding,
  cohortVersions,
  isComparable,
  metricDelta,
  type CohortSample,
} from "./prompt-series";

/** A cohort of `n` delivered features, all on one anton unless the caller says otherwise. */
const sample = (n: number, over: Partial<CohortSample> = {}): CohortSample => ({
  n,
  antonVersions: Array.from({ length: n }, () => "0.4.0+abc123"),
  metrics: { usdPerFeature: 4, reviewRounds: 2, humanTouches: 1, escalations: 0.5 },
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
