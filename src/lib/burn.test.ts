/**
 * Per-job burn sampler (anton-w8ny): the pure delta, the rolling per-type average with its
 * seed-blended ramp-up, and the fail-soft sampler, all against a real in-memory anton.db.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "./db/testing";
import type { Clock } from "./jobs/queue";
import type { ClaudeUsage } from "./claude/usage";
import {
  BURN_SAMPLE_WINDOW,
  burnDelta,
  getBurnAverage,
  JOB_TYPE_TIER,
  recordBurnSample,
  sampleJobBurn,
  TIER_SEEDS,
} from "./burn";

class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

function usage(sessionPct: number, weeklyPct: number): ClaudeUsage {
  return { sessionPct, weeklyPct, sessionResetAt: null, weeklyResetAt: null, plan: "max" };
}

describe("burnDelta", () => {
  it("computes the before/after delta", () => {
    expect(burnDelta(usage(10, 5), usage(28, 8))).toEqual({ sessionDelta: 18, weeklyDelta: 3 });
  });

  it("returns null when either read is missing", () => {
    expect(burnDelta(null, usage(10, 5))).toBeNull();
    expect(burnDelta(usage(10, 5), null)).toBeNull();
    expect(burnDelta(null, null)).toBeNull();
  });

  it("returns null when a meter reset mid-job (negative delta)", () => {
    // Session limit rolled over: after < before, so the window spans a reset and can't attribute.
    expect(burnDelta(usage(90, 40), usage(3, 41))).toBeNull();
    // Weekly rollover is skipped too.
    expect(burnDelta(usage(10, 90), usage(12, 1))).toBeNull();
  });
});

describe("getBurnAverage", () => {
  let t: TestDb;
  let clock: FakeClock;
  beforeEach(() => {
    t = makeTestDb();
    clock = new FakeClock(1_700_000_000_000);
  });
  afterEach(() => t.close());

  it("returns the pure tier seed when no real samples exist", async () => {
    const seed = TIER_SEEDS[JOB_TYPE_TIER["execute-epic"]]; // L
    const avg = await getBurnAverage(t.db, "execute-epic");
    expect(avg.seeded).toBe(true);
    expect(avg.sampleCount).toBe(0);
    expect(avg.sessionAvg).toBe(seed.sessionPct);
    expect(avg.weeklyAvg).toBe(seed.weeklyPct);
    expect(avg.tier).toBe("L");
  });

  it("blends real samples with the seed during ramp-up, staying seeded", async () => {
    // L seed is 20/3; each real sample burns 30/4. The average should move off the seed toward the
    // real data by rows.length/window — not stay pinned to the seed until the window fills.
    const seed = TIER_SEEDS[JOB_TYPE_TIER["execute-epic"]]; // { sessionPct: 20, weeklyPct: 3 }
    for (let i = 1; i < BURN_SAMPLE_WINDOW; i++) {
      await recordBurnSample(t.db, clock, "execute-epic", { sessionDelta: 30, weeklyDelta: 4 });
      clock.advance(1_000);
      const avg = await getBurnAverage(t.db, "execute-epic");
      const pad = BURN_SAMPLE_WINDOW - i;
      expect(avg.seeded).toBe(true);
      expect(avg.sampleCount).toBe(i);
      expect(avg.sessionAvg).toBeCloseTo((i * 30 + pad * seed.sessionPct) / BURN_SAMPLE_WINDOW, 5);
      expect(avg.weeklyAvg).toBeCloseTo((i * 4 + pad * seed.weeklyPct) / BURN_SAMPLE_WINDOW, 5);
      expect(avg.sessionAvg).toBeGreaterThan(seed.sessionPct); // real burn pulls it up
    }
  });

  it("returns the rolling average once N samples exist", async () => {
    for (const d of [10, 20, 30, 40, 50]) {
      await recordBurnSample(t.db, clock, "review-fix", { sessionDelta: d, weeklyDelta: d / 10 });
      clock.advance(1_000);
    }
    const avg = await getBurnAverage(t.db, "review-fix");
    expect(avg.seeded).toBe(false);
    expect(avg.sampleCount).toBe(BURN_SAMPLE_WINDOW);
    expect(avg.sessionAvg).toBe(30); // mean(10,20,30,40,50)
    expect(avg.weeklyAvg).toBeCloseTo(3, 5);
  });

  it("averages only the most recent window, ignoring older samples", async () => {
    // Five cheap samples, then five expensive ones — the rolling average should track the recent set.
    for (const d of [1, 1, 1, 1, 1]) {
      await recordBurnSample(t.db, clock, "execute-epic", { sessionDelta: d, weeklyDelta: 0 });
      clock.advance(1_000);
    }
    for (const d of [40, 40, 40, 40, 40]) {
      await recordBurnSample(t.db, clock, "execute-epic", { sessionDelta: d, weeklyDelta: 0 });
      clock.advance(1_000);
    }
    const avg = await getBurnAverage(t.db, "execute-epic");
    expect(avg.sessionAvg).toBe(40);
  });

  it("keeps averages separate per job type", async () => {
    for (let i = 0; i < BURN_SAMPLE_WINDOW; i++) {
      await recordBurnSample(t.db, clock, "execute-epic", { sessionDelta: 25, weeklyDelta: 0 });
      clock.advance(1_000);
    }
    const epic = await getBurnAverage(t.db, "execute-epic");
    const stringer = await getBurnAverage(t.db, "nightly-stringer");
    expect(epic.seeded).toBe(false);
    expect(epic.sessionAvg).toBe(25);
    // nightly-stringer has no samples of its own — still on its S seed.
    expect(stringer.seeded).toBe(true);
    expect(stringer.sessionAvg).toBe(TIER_SEEDS.S.sessionPct);
  });
});

describe("sampleJobBurn", () => {
  let t: TestDb;
  let clock: FakeClock;
  beforeEach(() => {
    t = makeTestDb();
    clock = new FakeClock(1_700_000_000_000);
  });
  afterEach(() => t.close());

  it("records the delta from a before snapshot and a fresh read", async () => {
    const before = usage(10, 5);
    const sample = await sampleJobBurn(t.db, clock, "execute-epic", before, async () => usage(35, 9));
    expect(sample).toEqual({ sessionDelta: 25, weeklyDelta: 4 });
    const avg = await getBurnAverage(t.db, "execute-epic", 1);
    expect(avg.seeded).toBe(false);
    expect(avg.sessionAvg).toBe(25);
  });

  it("records NO sample on a null usage read and never throws", async () => {
    const nullBefore = await sampleJobBurn(t.db, clock, "review-fix", null, async () => usage(35, 9));
    expect(nullBefore).toBeNull();
    const nullAfter = await sampleJobBurn(t.db, clock, "review-fix", usage(10, 5), async () => null);
    expect(nullAfter).toBeNull();
    const rows = await t.db.select().from((await import("./db")).schema.burnSamples);
    expect(rows).toHaveLength(0);
  });

  it("swallows a read that throws (fail-soft) and records nothing", async () => {
    const sample = await sampleJobBurn(t.db, clock, "review-fix", usage(10, 5), async () => {
      throw new Error("usage endpoint down");
    });
    expect(sample).toBeNull();
    const rows = await t.db.select().from((await import("./db")).schema.burnSamples);
    expect(rows).toHaveLength(0);
  });
});
