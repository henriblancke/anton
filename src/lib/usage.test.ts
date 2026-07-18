import { describe, expect, it } from "vitest";

import {
  clampPct,
  tightestLimit,
  usageTone,
  USAGE_CRIT_AT,
  USAGE_WARN_AT,
  type UsageSnapshot,
} from "@/lib/usage";

function snapshot(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    sessionPct: 0,
    weeklyPct: 0,
    sessionResetAt: null,
    weeklyResetAt: null,
    plan: null,
    ...over,
  };
}

describe("usageTone", () => {
  it("stays ok below the warn threshold", () => {
    expect(usageTone(0)).toBe("ok");
    expect(usageTone(USAGE_WARN_AT - 1)).toBe("ok");
  });

  it("steps to warn at the warn threshold and holds until crit", () => {
    expect(usageTone(USAGE_WARN_AT)).toBe("warn");
    expect(usageTone(USAGE_CRIT_AT - 1)).toBe("warn");
  });

  it("steps to crit at the crit threshold and above", () => {
    expect(usageTone(USAGE_CRIT_AT)).toBe("crit");
    expect(usageTone(100)).toBe("crit");
  });
});

describe("clampPct", () => {
  it("clamps out-of-range values into 0–100", () => {
    expect(clampPct(-10)).toBe(0);
    expect(clampPct(140)).toBe(100);
    expect(clampPct(42)).toBe(42);
  });

  it("maps non-finite input to 0 so a meter never renders NaN", () => {
    expect(clampPct(Number.NaN)).toBe(0);
    expect(clampPct(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("tightestLimit", () => {
  it("summarizes whichever limit is more used", () => {
    const weeklyTight = tightestLimit(snapshot({ sessionPct: 20, weeklyPct: 88 }));
    expect(weeklyTight.kind).toBe("weekly");
    expect(weeklyTight.pct).toBe(88);
  });

  it("resolves a tie to the session limit — the one that frees up sooner", () => {
    const tie = tightestLimit(snapshot({ sessionPct: 50, weeklyPct: 50 }));
    expect(tie.kind).toBe("session");
  });

  it("carries the winning limit's reset timestamp", () => {
    const t = tightestLimit(
      snapshot({ sessionPct: 10, weeklyPct: 70, weeklyResetAt: "2026-07-25T00:00:00Z" }),
    );
    expect(t.resetAt).toBe("2026-07-25T00:00:00Z");
  });
});
