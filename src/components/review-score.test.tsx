/**
 * The score vocabulary itself (anton-tprv): the bands, the chip that names one, and the bar that
 * draws one. Everything downstream — board cards, the epic panel, the project trend pill — colours
 * a score through these three, so a band boundary that slips by one repaints "acceptable work" as
 * "substantial rework" everywhere at once.
 *
 * The boundaries are pinned as the review contract states them (skills/review/SKILL.md §5), not as
 * an even split of 0–10, and each band is asserted through BOTH surfaces: a chip tone that agreed
 * with a bar colour is the only thing that makes one score read the same in two places.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ReviewScoreChip,
  ScoreSparkline,
  scoreBand,
  type ScoreBand,
  type SparklinePoint,
} from "@/components/review-score";

const chip = (score?: number) => renderToStaticMarkup(<ReviewScoreChip score={score} />);

const sparkline = (points: SparklinePoint[]) =>
  renderToStaticMarkup(<ScoreSparkline points={points} />);

const bar = (score: number) => sparkline([{ key: "r1", score, label: "round 1" }]);

/** The tone each band paints with, in both surfaces — the chip's text colour and the bar's fill. */
const BAND_PAINT: Record<ScoreBand, { chip: string; bar: string }> = {
  ships: { chip: "text-stage-done", bar: "bg-stage-done" },
  gaps: { chip: "text-risk-med", bar: "bg-risk-med" },
  rework: { chip: "text-risk-high", bar: "bg-risk-high" },
};

describe("scoreBand", () => {
  // The exact boundaries, stated one score either side: 8 ships, 7 does not; 5 is still acceptable,
  // 4 is the rework end the score-regression alarm counts.
  it.each<[number, ScoreBand]>([
    [10, "ships"],
    [8, "ships"],
    [7, "gaps"],
    [5, "gaps"],
    [4, "rework"],
    [0, "rework"],
  ])("puts %i in the %s band", (score, band) => {
    expect(scoreBand(score)).toBe(band);
  });
});

describe("ReviewScoreChip", () => {
  it.each<[ScoreBand, number]>([
    ["ships", 8],
    ["gaps", 7],
    ["gaps", 5],
    ["rework", 4],
  ])("paints a %s score (%i) with its band's tone, and says what the band means", (band, score) => {
    const html = chip(score);

    expect(html).toContain(`review ${score}/10`);
    expect(html).toContain(BAND_PAINT[band].chip);
    // The hover explanation is the band in the reviewer's own words — a bare number is not arguable.
    expect(html).toContain(`Latest anton self-review: ${score}/10`);
    for (const other of Object.keys(BAND_PAINT) as ScoreBand[]) {
      if (other !== band) expect(html).not.toContain(BAND_PAINT[other].chip);
    }
  });

  // "Not scored" is not a zero: a chip here would accuse anton of judging work it never looked at.
  it("renders nothing for a target that was never scored", () => {
    expect(chip(undefined)).toBe("");
  });

  it("still renders a 0 — the one score that is not an absence", () => {
    expect(chip(0)).toContain("review 0/10");
  });

  it("keeps the caller's className alongside its own tone", () => {
    expect(chip(9)).not.toContain("shrink-0");
    expect(renderToStaticMarkup(<ReviewScoreChip score={9} className="shrink-0" />)).toContain(
      "shrink-0",
    );
  });
});

describe("ScoreSparkline", () => {
  it.each<[ScoreBand, number]>([
    ["ships", 8],
    ["gaps", 7],
    ["gaps", 5],
    ["rework", 4],
  ])("fills a %s score (%i)'s bar with the same band colour the chip uses", (band, score) => {
    const html = bar(score);

    expect(html).toContain(BAND_PAINT[band].bar);
    for (const other of Object.keys(BAND_PAINT) as ScoreBand[]) {
      if (other !== band) expect(html).not.toContain(BAND_PAINT[other].bar);
    }
  });

  it("sizes each bar by its score, flooring a 0 so it still draws", () => {
    const html = sparkline([
      { key: "r1", score: 0, label: "round 1" },
      { key: "r2", score: 6, label: "round 2" },
    ]);

    // An invisible bar would read as "no round", which is the one thing a 0 is not.
    expect(html).toContain("height:8%");
    expect(html).toContain("height:60%");
  });

  it("announces the whole series in order, as one image label", () => {
    const html = sparkline([
      { key: "r1", score: 3, label: "round 1" },
      { key: "r2", score: undefined, label: "round 2" },
      { key: "r3", score: 9, label: "round 3" },
    ]);

    expect(html).toContain('role="img"');
    expect(html).toContain(
      'aria-label="round 1: 3 out of 10, round 2: no score, round 3: 9 out of 10"',
    );
  });

  it("draws a round that reported no score as an empty slot, never as a low one", () => {
    const html = sparkline([{ key: "r1", score: undefined, label: "round 1" }]);

    expect(html).toContain("border-dashed");
    expect(html).toContain("no score reported");
    for (const { bar: fill } of Object.values(BAND_PAINT)) expect(html).not.toContain(fill);
  });

  it("renders nothing for an empty series", () => {
    expect(sparkline([])).toBe("");
  });

  // A caller's width is a FLOOR: the columns keep their minimum width and grow past it rather than
  // spilling over the container's border (anton-dek6).
  it("keeps its columns' minimum width under a caller's width", () => {
    const html = renderToStaticMarkup(
      <ScoreSparkline points={[{ key: "r1", score: 7, label: "round 1" }]} className="w-12" />,
    );

    expect(html).toContain("min-w-min");
    expect(html).toContain("w-12");
  });
});
