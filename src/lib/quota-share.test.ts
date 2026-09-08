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
  resolveGovernedShare,
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

  it("totals how much of the split is in use elsewhere, so the panel can name it", () => {
    const split = resolveQuotaSplit([
      project({ id: "a", sharePct: 40 }),
      project({ id: "idle", sharePct: 35, eligible: false }),
      project({ id: "quiet", sharePct: 25, eligible: false, reserved: true }),
    ]);

    // Only the unreserved idle share moved — a reserved one was never up for reallocation.
    expect(split.reallocatedPct).toBe(35);
    expect(resolveQuotaSplit([project({ id: "a" })]).reallocatedPct).toBe(0);
  });

  it("reports the reallocated share in the same normalized terms as the split it came out of", () => {
    // 30/30/30 with one idle: the split in force is 50/50, and the idle project's cut of the
    // normalized split was 33.3 — the panel must not say 30 while the rows say otherwise.
    const split = resolveQuotaSplit([
      project({ id: "a", sharePct: 30 }),
      project({ id: "b", sharePct: 30 }),
      project({ id: "idle", sharePct: 30, eligible: false }),
    ]);

    expect(split.reallocatedPct).toBeCloseTo(33.33, 1);
    expect(split.reallocatedPct).toBeCloseTo(row(split, "idle").normalizedPct, 5);
  });
});

describe("resolveGovernedShare", () => {
  it("defaults an undeclared project to an equal split across the armed projects", () => {
    const board = [{ projectId: "a" }, { projectId: "b" }, { projectId: "c" }];

    expect(resolveGovernedShare("b", board)).toMatchObject({
      sharePct: 100 / 3,
      declaredPct: 100 / 3,
      declared: false,
      imbalanced: false,
    });
  });

  it("holds a declared share that already sums to 100", () => {
    const board = [
      { projectId: "a", declaredPct: 70 },
      { projectId: "b", declaredPct: 30 },
    ];

    expect(resolveGovernedShare("a", board).sharePct).toBe(70);
    expect(resolveGovernedShare("b", board).sharePct).toBe(30);
    expect(resolveGovernedShare("a", board).imbalanced).toBe(false);
  });

  it("surfaces a non-100 sum rather than renormalizing it away silently", () => {
    const board = [
      { projectId: "a", declaredPct: 30 },
      { projectId: "b", declaredPct: 30 },
      { projectId: "c", declaredPct: 30 },
    ];
    const share = resolveGovernedShare("a", board);

    // Proportioned — an under-declared board must not leave weekly quota unspendable…
    expect(share.sharePct).toBeCloseTo(33.33, 1);
    // …but the operator declared 30, and the gap between the two is reported, not smoothed over.
    expect(share.declaredPct).toBe(30);
    expect(share.declaredTotalPct).toBe(90);
    expect(share.imbalanced).toBe(true);
  });

  it("mixes a declaration with the equal-split default, and says the total is off", () => {
    // The default is measured against the armed count (2 → 50), so declaring 80 over-commits.
    const board = [{ projectId: "a", declaredPct: 80 }, { projectId: "b" }];
    const declared = resolveGovernedShare("a", board);

    expect(declared.declaredTotalPct).toBe(130);
    expect(declared.imbalanced).toBe(true);
    expect(declared.sharePct).toBeCloseTo((80 / 130) * 100, 6);
    expect(resolveGovernedShare("b", board).sharePct).toBeCloseTo((50 / 130) * 100, 6);
  });

  it("parks a project that declared 0 without dragging the others down", () => {
    const board = [
      { projectId: "a", declaredPct: 0 },
      { projectId: "b", declaredPct: 100 },
    ];

    expect(resolveGovernedShare("a", board).sharePct).toBe(0);
    expect(resolveGovernedShare("b", board).sharePct).toBe(100);
  });

  it("renormalizes an idle project out of the denominator (R6.4)", () => {
    const board = [
      { projectId: "busy", declaredPct: 50 },
      { projectId: "idle", declaredPct: 50, eligible: false },
    ];
    const busy = resolveGovernedShare("busy", board);

    // The idle 50 is not lent, it is simply absent from the divisor — quota that resets unused is
    // wasted, so an idle share must not hold capacity hostage.
    expect(busy.sharePct).toBe(100);
    expect(busy.declaredPct).toBe(50);
    expect(busy.participantTotalPct).toBe(50);
    expect(busy.renormalized).toBe(true);
  });

  it("keeps a reserved project in the denominator while it is idle (R6.5)", () => {
    const board = [
      { projectId: "busy", declaredPct: 50 },
      { projectId: "quiet", declaredPct: 50, eligible: false, reserved: true },
    ];

    // The repo touched irregularly keeps its allocation; the busy neighbour gains nothing.
    expect(resolveGovernedShare("busy", board).sharePct).toBe(50);
    expect(resolveGovernedShare("busy", board).renormalized).toBe(false);
    expect(resolveGovernedShare("quiet", board).sharePct).toBe(50);
  });

  it("hands the share straight back on the pass after a project wakes up", () => {
    const declared = [{ projectId: "busy", declaredPct: 50 }, { projectId: "waking" }];
    const asleep = declared.map((p) =>
      p.projectId === "waking" ? { ...p, declaredPct: 50, eligible: false } : p,
    );
    const awake = asleep.map((p) => ({ ...p, eligible: true }));

    // No ledger to unwind: the next pass simply recomputes the divisor, with no operator action.
    expect(resolveGovernedShare("busy", asleep).sharePct).toBe(100);
    expect(resolveGovernedShare("busy", awake).sharePct).toBe(50);
    expect(resolveGovernedShare("waking", awake).sharePct).toBe(50);
  });

  it("always counts the project it is resolving for", () => {
    // Resolving a ceiling means this project is asking to spend, so it is not idle whatever the last
    // picker pass recorded. Renormalizing it out would hand it 0% and defer its work forever.
    const board = [
      { projectId: "busy", declaredPct: 50 },
      { projectId: "asking", declaredPct: 50, eligible: false },
    ];

    expect(resolveGovernedShare("asking", board).sharePct).toBe(50);
    expect(resolveGovernedShare("asking", board).renormalized).toBe(false);
  });

  it("never renormalizes a share away on an eligibility it could not read", () => {
    // Unset is UNKNOWN, not idle: mistaking a busy repo for an idle one hands its quota away.
    const board = [{ projectId: "a", declaredPct: 50 }, { projectId: "b", declaredPct: 50 }];

    expect(resolveGovernedShare("a", board).sharePct).toBe(50);
    expect(resolveGovernedShare("a", board).renormalized).toBe(false);
  });

  it("leaves a parked project parked when everyone else goes idle", () => {
    const board = [
      { projectId: "parked", declaredPct: 0 },
      { projectId: "idle", declaredPct: 100, eligible: false },
    ];

    // 0 is a declaration, not an absence — renormalization must not resurrect a repo the operator
    // deliberately parked.
    expect(resolveGovernedShare("parked", board).sharePct).toBe(0);
  });

  it("leaves a project that is not on the governed board holding the whole quota", () => {
    // Budget-aware execution is off for it: no share binds it, so nothing may scale its ceiling.
    expect(resolveGovernedShare("off", [{ projectId: "a", declaredPct: 100 }]).sharePct).toBe(100);
    expect(resolveGovernedShare("alone", []).sharePct).toBe(100);
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
