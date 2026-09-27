// @vitest-environment jsdom
/**
 * The cohort trend view (anton-yp9tl), tested at its own boundary.
 *
 * The claim under test is that a reader cannot mistake one kind of answer for another. Three of the
 * four states below are ways this page could mislead rather than ways its layout could shift:
 *
 *  - an UNDERPOWERED cohort that quietly omitted its arrow would read as "did not move" — a verdict,
 *    and the wrong one;
 *  - a MIXED-VERSION cohort that dropped its flag would credit a runtime upgrade to a prompt edit;
 *  - an EMPTY page that rendered blank would read as a broken feature rather than as work that has
 *    not accrued yet — and at anton's real volume, empty is the common case, not the edge case.
 *
 * Every fixture goes through `cohortStanding` rather than hand-building a standing, so a test can
 * never assert on a shape the guardrails would not actually produce.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { CohortView } from "@/components/cohorts/cohort-view";
import {
  MIN_COHORT,
  cohortStanding,
  type Cohort,
  type CohortBasis,
  type CohortDimension,
  type CohortMetrics,
  type CohortSample,
  type CohortSeries,
} from "@/lib/prompt-series";

afterEach(cleanup);

const AUG_2 = Date.UTC(2026, 7, 2, 12);
const SEP_4 = Date.UTC(2026, 8, 4, 12);

const HEALTHY_METRICS: CohortMetrics = {
  usdPerFeature: 4.12,
  reviewRounds: 2.4,
  humanTouches: 1.8,
  escalations: 0.4,
};

/** A sample of `n` features all stamped with the same anton version, unless told otherwise. */
function sample(n: number, metrics: CohortMetrics, versions?: (string | null)[]): CohortSample {
  return {
    n,
    antonVersions: versions ?? Array.from({ length: n }, () => "0.6.0"),
    metrics,
    unpricedFeatures: 0,
  };
}

/** A cohort as the page receives it: a real standing plus what identifies it. */
function cohort(
  key: string | null,
  current: CohortSample,
  baseline?: CohortSample,
  window: { firstDeliveryMs: number; lastDeliveryMs: number } | undefined = {
    firstDeliveryMs: AUG_2,
    lastDeliveryMs: SEP_4,
  },
): Cohort {
  return { ...cohortStanding(current, baseline), key, window, basis: basisOf(current) };
}

/** A basis for a cohort that delivered everything it ran and priced all of it — the plain case. */
function basisOf(current: CohortSample): CohortBasis {
  return { features: current.n, unpricedFeatures: 0 };
}

function series(cohorts: Cohort[], dimension: CohortDimension = "prompt"): CohortSeries {
  return { dimension, cohorts, spanning: { delivered: 0, features: 0 } };
}

const rowFor = (key: string) => screen.getByText(key).closest("tr")!;

describe("a healthy cohort", () => {
  const OLD = sample(11, HEALTHY_METRICS);
  const NEW = sample(7, {
    usdPerFeature: 3.06,
    reviewRounds: 1.6,
    humanTouches: 0.9,
    escalations: 0.1,
  });

  const SERIES = series([cohort("a3f1c2", OLD), cohort("9c2edd", NEW, OLD)]);

  it("renders each cohort's n, window and four averages", () => {
    render(<CohortView window="all" series={SERIES} />);

    const row = within(rowFor("a3f1c2"));
    // The n is a column of its own, because below the floor it IS the answer.
    expect(row.getByText("11")).toBeTruthy();
    // The span the averages are averages OVER — a figure with no window is undated.
    expect(row.getByText("Aug 2 – Sep 4")).toBeTruthy();
    expect(row.getByText("$4.12")).toBeTruthy();
    expect(row.getByText("2.4")).toBeTruthy();
    expect(row.getByText("1.8")).toBeTruthy();
    expect(row.getByText("0.4")).toBeTruthy();
  });

  it("draws the move on the cohort that cleared the floor against a baseline that did too", () => {
    render(<CohortView window="all" series={SERIES} />);

    const row = within(rowFor("9c2edd"));
    expect(row.getByText("$3.06")).toBeTruthy();
    // Every metric here improves downward, so all four moves read as better — arrow AND magnitude,
    // since an arrow alone invites the reader to supply their own.
    expect(row.getAllByText("↓")).toHaveLength(4);
    expect(row.getByText(/\$1\.06 · 26%/)).toBeTruthy();
    expect(row.getByText(/^0\.8 · 33%$/)).toBeTruthy();
  });

  it("names the direction for a screen reader, not only with an arrow glyph", () => {
    render(<CohortView window="all" series={SERIES} />);

    // The arrow is aria-hidden, so the direction has to reach a reader some other way.
    expect(within(rowFor("9c2edd")).getAllByText(/better by/).length).toBeGreaterThan(0);
  });

  it("counts how many cohorts may be read as a verdict at all", () => {
    render(<CohortView window="all" series={SERIES} />);

    // The FIRST cohort clears the floor too, but it has no baseline to move against — its row draws
    // no arrow, so it does not count as comparable even though it is not underpowered.
    expect(screen.getByText("1 of 2")).toBeTruthy();
    // 11 + 7 delivered features across the series.
    expect(screen.getByText("18")).toBeTruthy();
  });

  it("marks a worse move as worse rather than just as a change", () => {
    const regressed = sample(9, { ...HEALTHY_METRICS, usdPerFeature: 6.5 });
    render(
      <CohortView window="all" series={series([cohort("a3f1c2", OLD), cohort("bad999", regressed, OLD)])} />,
    );

    const row = within(rowFor("bad999"));
    expect(row.getByText("↑")).toBeTruthy();
    expect(row.getByText(/\$2\.38 · 58%/)).toBeTruthy();
  });

  it("says 'no change' rather than drawing a zero-magnitude arrow", () => {
    render(
      <CohortView
        window="all"
        series={series([cohort("a3f1c2", OLD), cohort("same11", sample(9, HEALTHY_METRICS), OLD)])}
      />,
    );

    expect(within(rowFor("same11")).getAllByText("no change")).toHaveLength(4);
  });
});

describe("an underpowered cohort", () => {
  const SMALL = sample(2, HEALTHY_METRICS);

  it("renders its n and no arrow", () => {
    render(<CohortView window="all" series={series([cohort("tiny22", SMALL)])} />);

    const row = within(rowFor("tiny22"));
    expect(row.getByText("2")).toBeTruthy();
    // The whole point of the floor: no verdict of any kind on a cohort this size.
    expect(row.queryByText("↓")).toBeNull();
    expect(row.queryByText("↑")).toBeNull();
    expect(row.queryByText("→")).toBeNull();
  });

  it("states how many more deliveries it needs, so the gap does not read as 'did not move'", () => {
    render(<CohortView window="all" series={series([cohort("tiny22", SMALL)])} />);

    expect(within(rowFor("tiny22")).getByText(`+${MIN_COHORT - 2} to compare`)).toBeTruthy();
  });

  it("keeps showing its real measurements — underpowered is not unmeasured", () => {
    render(<CohortView window="all" series={series([cohort("tiny22", SMALL)])} />);

    const row = within(rowFor("tiny22"));
    expect(row.getByText("$4.12")).toBeTruthy();
    expect(row.getByText("2.4")).toBeTruthy();
  });

  it("draws no arrow on a big cohort whose only baseline is underpowered", () => {
    const big = sample(9, { ...HEALTHY_METRICS, usdPerFeature: 2.0 });
    render(
      <CohortView window="all" series={series([cohort("tiny22", SMALL), cohort("big999", big, SMALL)])} />,
    );

    // A comparison is only as sound as its weaker side; measuring against n=2 is the same noise.
    expect(within(rowFor("big999")).queryByText("↓")).toBeNull();
    expect(screen.getByText(/a move needs two/)).toBeTruthy();
  });

  it("says outright that nothing carries a verdict when no cohort cleared the floor", () => {
    render(
      <CohortView
        window="all"
        series={series([cohort("tiny22", SMALL), cohort("tiny33", sample(3, HEALTHY_METRICS))])}
      />,
    );

    expect(screen.getByText("0 of 2")).toBeTruthy();
    expect(screen.getByText(/none of them may be read as a move/)).toBeTruthy();
  });
});

describe("a mixed-version cohort", () => {
  const MIXED = sample(8, HEALTHY_METRICS, [
    "0.6.0",
    "0.6.0",
    "0.6.0",
    "0.6.0",
    "0.6.0",
    "0.7.0",
    "0.7.0",
    "0.7.0",
  ]);

  it("renders its flag, naming the versions it spans", () => {
    render(<CohortView window="all" series={series([cohort("mix001", MIXED)])} />);

    const row = within(rowFor("mix001"));
    expect(row.getByText(/mixed anton versions/)).toBeTruthy();
    expect(row.getByText(/0\.6\.0 · 0\.7\.0/)).toBeTruthy();
  });

  it("flags a cohort half of which predates the stamp, which is the same confound", () => {
    const halfUnstamped = sample(6, HEALTHY_METRICS, ["0.6.0", "0.6.0", "0.6.0", null, null, null]);
    render(<CohortView window="all" series={series([cohort("half01", halfUnstamped)])} />);

    const row = within(rowFor("half01"));
    expect(row.getByText(/mixed anton versions/)).toBeTruthy();
    expect(row.getByText(/3 unstamped/)).toBeTruthy();
  });

  it("keeps the figures and the verdict — a mixed cohort measured plenty, it just cannot attribute it", () => {
    const baseline = sample(7, HEALTHY_METRICS);
    render(
      <CohortView
        window="all"
        series={series([
          cohort("base01", baseline),
          cohort("mix001", sample(8, { ...HEALTHY_METRICS, usdPerFeature: 3.0 }, MIXED.antonVersions as string[]), baseline),
        ])}
      />,
    );

    const row = within(rowFor("mix001"));
    expect(row.getByText(/mixed anton versions/)).toBeTruthy();
    // Suppressing this would throw away a real finding; flagging hands the reader the ambiguity.
    expect(row.getByText("↓")).toBeTruthy();
  });

  it("says how many cohorts are affected above the table, so the caveat is not only per-row", () => {
    render(<CohortView window="all" series={series([cohort("mix001", MIXED)])} />);

    expect(screen.getByText(/span more than one anton\s+version/)).toBeTruthy();
    expect(screen.getByText(/attribution does not/)).toBeTruthy();
  });

  it("stays silent on a cohort that ran under one anton throughout", () => {
    render(<CohortView window="all" series={series([cohort("clean1", sample(8, HEALTHY_METRICS))])} />);

    expect(screen.queryByText(/mixed anton versions/)).toBeNull();
  });
});

describe("no cohorts yet", () => {
  it("explains what has to accrue rather than rendering empty", () => {
    render(<CohortView window="all" series={series([])} />);

    expect(screen.getByText(/No cohorts to compare yet/)).toBeTruthy();
    // The two thresholds an operator can actually count toward.
    expect(screen.getByText(`${MIN_COHORT} delivered features`)).toBeTruthy();
    expect(screen.getByText("Two such cohorts")).toBeTruthy();
    expect(screen.getByText(/draws no arrow/)).toBeTruthy();
    // And the unit, since a run in flight looks like progress but contributes nothing.
    expect(screen.getByText(/a run in flight, parked or abandoned contributes nothing/)).toBeTruthy();
  });

  it("renders no table and no zeroed figures at all", () => {
    render(<CohortView window="all" series={series([])} />);

    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByText("0 of 0")).toBeNull();
  });

  it("points a narrow empty window at a wider one rather than at the floor", () => {
    render(<CohortView window="7d" series={series([])} />);

    expect(screen.getByText(/No cohorts to compare last 7 days/)).toBeTruthy();
    expect(screen.getByText(/empty comparison, not a flat one/)).toBeTruthy();
  });
});

describe("what a cohort could not measure", () => {
  it("renders an unpriced cohort's cost as a dash, never as $0.00", () => {
    const unpriced = sample(7, { reviewRounds: 2.0, humanTouches: 1.0, escalations: 0 });
    render(<CohortView window="all" series={series([cohort("nop001", unpriced)])} />);

    const row = within(rowFor("nop001"));
    expect(row.getByText("—")).toBeTruthy();
    expect(row.queryByText("$0.00")).toBeNull();
    // A genuinely-zero average still renders as a number — absent and zero are opposite facts.
    expect(row.getByText("0.0")).toBeTruthy();
  });

  it("marks a partially-priced cohort's $/feature as a floor rather than a complete figure", () => {
    // 4 of 7 delivered features were priced — the fold still reports an average, but it must not
    // read as a total the way a fully-priced cohort's does.
    const partiallyPriced = {
      ...cohort("partial1", sample(7, HEALTHY_METRICS)),
      basis: { features: 7, unpricedFeatures: 3 },
    };
    render(<CohortView window="all" series={series([partiallyPriced])} />);

    const row = within(rowFor("partial1"));
    expect(row.getByText("$4.12")).toBeTruthy();
    // The floor marker `spend-table.tsx` uses for the same situation.
    expect(row.getByText("+")).toBeTruthy();
  });

  it("labels the pre-instrumentation cohort rather than leaving its key blank", () => {
    const unstamped = sample(6, HEALTHY_METRICS, Array.from({ length: 6 }, () => null));
    render(
      <CohortView
        window="all"
        series={series([
          { ...cohortStanding(unstamped), key: null, window: undefined, basis: basisOf(unstamped) },
        ])}
      />,
    );

    expect(screen.getByText("Unstamped")).toBeTruthy();
    // No window recorded is stated, not defaulted to a plausible wrong span.
    expect(screen.getByText("no delivery time recorded")).toBeTruthy();
  });
});

describe("a dimension whose cohorts are confounded by the work they were given", () => {
  it("says so for an agent series, above the numbers rather than below them", () => {
    render(
      <CohortView
        window="all"
        series={series([cohort("agent:alembic", sample(7, HEALTHY_METRICS))], "agent")}
      />,
    );

    expect(screen.getByText(/confounded by the work it was given/)).toBeTruthy();
    expect(screen.getByText(/never as a claim the agent caused it/)).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Agent tag" })).toBeTruthy();
  });

  it("carries no such caution on a prompt series, where the key is what changed", () => {
    render(<CohortView window="all" series={series([cohort("a3f1c2", sample(7, HEALTHY_METRICS))])} />);

    expect(screen.queryByText(/confounded by the work/)).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Prompt digest" })).toBeTruthy();
  });
});
