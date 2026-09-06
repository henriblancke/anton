/**
 * The quota split (R6.1 / R6.3 / R6.4), tested at its own boundary.
 *
 * The claim under test is that the denominator is the projects that can actually spend, and that
 * nothing this module reports is presented as more certain than it is: an unattributed figure never
 * reads as zero, and declared shares that don't sum to 100 are surfaced rather than smoothed away.
 */
import { describe, expect, it } from "vitest";

import {
  defaultQuotaSharePct,
  formatApproxPct,
  resolveQuotaSplit,
  type QuotaShareProject,
} from "@/lib/quota-share";

function project(overrides: Partial<QuotaShareProject> & { id: string }): QuotaShareProject {
  return {
    slug: overrides.id,
    name: overrides.id,
    sharePct: 50,
    declared: true,
    governed: true,
    reserved: false,
    eligible: true,
    spentWeeklyPct: null,
    seeded: false,
    ...overrides,
  };
}

const row = (split: ReturnType<typeof resolveQuotaSplit>, id: string) =>
  split.rows.find((r) => r.id === id)!;

describe("resolveQuotaSplit", () => {
  it("leaves declared shares alone while every project has work", () => {
    const split = resolveQuotaSplit([
      project({ id: "a", sharePct: 70 }),
      project({ id: "b", sharePct: 30 }),
    ]);

    expect(row(split, "a").effectivePct).toBe(70);
    expect(row(split, "b").effectivePct).toBe(30);
    expect(split.rows.some((r) => r.reallocated)).toBe(false);
    expect(split.imbalanced).toBe(false);
  });

  it("drops an idle project out of the denominator and says whose share moved", () => {
    // R6.4: no lending ledger — the idle share is simply absent from the divisor.
    const split = resolveQuotaSplit([
      project({ id: "a", sharePct: 50 }),
      project({ id: "idle", sharePct: 50, eligible: false }),
    ]);

    expect(row(split, "a").effectivePct).toBe(100);
    expect(row(split, "a").gainedPct).toBe(50);
    expect(row(split, "idle").effectivePct).toBe(0);
    expect(row(split, "idle").reallocated).toBe(true);
  });

  it("keeps a reserved project's share even while it is idle", () => {
    // R6.5: the repo touched irregularly should not lose its allocation to a busy neighbour.
    const split = resolveQuotaSplit([
      project({ id: "a", sharePct: 50 }),
      project({ id: "quiet", sharePct: 50, eligible: false, reserved: true }),
    ]);

    expect(row(split, "quiet").effectivePct).toBe(50);
    expect(row(split, "quiet").reallocated).toBe(false);
    expect(row(split, "a").effectivePct).toBe(50);
  });

  it("leaves an ungoverned project out of the split entirely", () => {
    // Budget-aware execution off means no share binds it; counting it would shrink everyone else's
    // cut to fund a project that spends unpaced anyway.
    const split = resolveQuotaSplit([
      project({ id: "a", sharePct: 50 }),
      project({ id: "unpaced", sharePct: 50, governed: false }),
    ]);

    expect(row(split, "a").effectivePct).toBe(100);
    expect(row(split, "unpaced").effectivePct).toBe(0);
    expect(row(split, "unpaced").reallocated).toBe(false);
    expect(split.declaredTotalPct).toBe(50);
  });

  it("reallocates nothing when no project can spend", () => {
    // An idle machine lends nobody anything; saying otherwise would name a beneficiary that does
    // not exist.
    const split = resolveQuotaSplit([
      project({ id: "a", sharePct: 50, eligible: false }),
      project({ id: "b", sharePct: 50, eligible: false }),
    ]);

    expect(split.rows.every((r) => r.effectivePct === 0)).toBe(true);
    expect(split.rows.some((r) => r.reallocated)).toBe(false);
  });

  it("flags declared shares that do not sum to 100 rather than smoothing them away", () => {
    const split = resolveQuotaSplit([
      project({ id: "a", sharePct: 30 }),
      project({ id: "b", sharePct: 30 }),
      project({ id: "c", sharePct: 30 }),
    ]);

    expect(split.imbalanced).toBe(true);
    // The split IS normalized — which is exactly why the imbalance has to be visible.
    expect(row(split, "a").effectivePct).toBeCloseTo(33.33, 1);
  });

  it("totals only the spend it can attribute, and reports none as null", () => {
    const unattributed = resolveQuotaSplit([project({ id: "a" }), project({ id: "b" })]);
    expect(unattributed.spentTotalPct).toBeNull();

    const partial = resolveQuotaSplit([
      project({ id: "a", spentWeeklyPct: 4 }),
      project({ id: "b" }),
    ]);
    expect(partial.spentTotalPct).toBe(4);
  });
});

describe("defaultQuotaSharePct", () => {
  it("is an equal cut of the paced projects", () => {
    expect(defaultQuotaSharePct(4)).toBe(25);
    // Nothing to divide against — the lone project holds the whole quota.
    expect(defaultQuotaSharePct(0)).toBe(100);
  });
});

describe("formatApproxPct", () => {
  it("marks every figure approximate (R6.3)", () => {
    expect(formatApproxPct(12)).toBe("≈ 12%");
    expect(formatApproxPct(3.46, 1)).toBe("≈ 3.5%");
  });

  it("never reads an unsampled figure as zero spend", () => {
    // "no sample" and "spent nothing" are opposite facts about the same project.
    expect(formatApproxPct(null)).toBe("not sampled yet");
    expect(formatApproxPct(0.2)).toBe("< 1%");
    expect(formatApproxPct(0)).toBe("≈ 0%");
  });
});
