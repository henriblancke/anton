/**
 * Per-job burn sampler (anton-w8ny): the pure delta, the rolling per-type average with its
 * seed-blended ramp-up, and the fail-soft sampler, all against a real in-memory anton.db.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "./db/testing";
import * as dbSchema from "./db/schema";
import type { Clock } from "./jobs/queue";
import type { ClaudeUsage } from "./claude/usage";
import {
  BURN_SAMPLE_WINDOW,
  burnDelta,
  burnsClaudeQuota,
  getBurnAverage,
  getProjectBurnAverage,
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

/** A project row for the sample's foreign key — attribution points at a real project or at nothing. */
async function seedProject(t: TestDb, id: string): Promise<void> {
  await t.db
    .insert(dbSchema.projects)
    .values({ id, slug: id, name: id, repoPath: `/tmp/${id}` });
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

describe("burnsClaudeQuota", () => {
  it("excludes handlers that never invoke Claude", () => {
    // sync-push is a deterministic `git push` of dolt refs — no Claude, so nothing to sample.
    expect(burnsClaudeQuota("sync-push")).toBe(false);
    expect(JOB_TYPE_TIER["sync-push"]).toBe("none");
  });

  it("includes every Claude-driven type", () => {
    for (const t of ["execute-epic", "review-fix", "nightly-stringer", "orphan-grooming"] as const) {
      expect(burnsClaudeQuota(t)).toBe(true);
    }
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

  it("costs the pacer nothing for a type that never invokes Claude", async () => {
    const avg = await getBurnAverage(t.db, "sync-push");
    expect(avg.tier).toBe("none");
    expect(avg.sessionAvg).toBe(0);
    expect(avg.weeklyAvg).toBe(0);
  });

  it("blends real samples with the seed during ramp-up, staying seeded", async () => {
    // L seed is 20/3; each real sample burns 30/4. The average should move off the seed toward the
    // real data by rows.length/window — not stay pinned to the seed until the window fills.
    const seed = TIER_SEEDS[JOB_TYPE_TIER["execute-epic"]]; // { sessionPct: 20, weeklyPct: 3 }
    for (let i = 1; i < BURN_SAMPLE_WINDOW; i++) {
      await recordBurnSample(t.db, clock, "execute-epic", null, { sessionDelta: 30, weeklyDelta: 4 });
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
      await recordBurnSample(t.db, clock, "review-fix", null, { sessionDelta: d, weeklyDelta: d / 10 });
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
      await recordBurnSample(t.db, clock, "execute-epic", null, { sessionDelta: d, weeklyDelta: 0 });
      clock.advance(1_000);
    }
    for (const d of [40, 40, 40, 40, 40]) {
      await recordBurnSample(t.db, clock, "execute-epic", null, { sessionDelta: d, weeklyDelta: 0 });
      clock.advance(1_000);
    }
    const avg = await getBurnAverage(t.db, "execute-epic");
    expect(avg.sessionAvg).toBe(40);
  });

  it("keeps averages separate per job type", async () => {
    for (let i = 0; i < BURN_SAMPLE_WINDOW; i++) {
      await recordBurnSample(t.db, clock, "execute-epic", null, { sessionDelta: 25, weeklyDelta: 0 });
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
    const sample = await sampleJobBurn(t.db, clock, "execute-epic", null, before, async () =>
      usage(35, 9),
    );
    expect(sample).toEqual({ sessionDelta: 25, weeklyDelta: 4 });
    const avg = await getBurnAverage(t.db, "execute-epic", 1);
    expect(avg.seeded).toBe(false);
    expect(avg.sessionAvg).toBe(25);
  });

  it("stamps every new sample with the project that spent it (anton-wj3d)", async () => {
    await seedProject(t, "proj-a");
    await sampleJobBurn(t.db, clock, "execute-epic", "proj-a", usage(10, 5), async () =>
      usage(35, 9),
    );
    const rows = await t.db.select().from(dbSchema.burnSamples);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.projectId).toBe("proj-a");
  });

  it("leaves the project null for anton's own plumbing, which belongs to no share", async () => {
    await sampleJobBurn(t.db, clock, "orphan-grooming", null, usage(10, 5), async () =>
      usage(12, 6),
    );
    const rows = await t.db.select().from(dbSchema.burnSamples);
    expect(rows[0]!.projectId).toBeNull();
  });

  it("records NO sample on a null usage read and never throws", async () => {
    const nullBefore = await sampleJobBurn(t.db, clock, "review-fix", null, null, async () =>
      usage(35, 9),
    );
    expect(nullBefore).toBeNull();
    const nullAfter = await sampleJobBurn(
      t.db,
      clock,
      "review-fix",
      null,
      usage(10, 5),
      async () => null,
    );
    expect(nullAfter).toBeNull();
    const rows = await t.db.select().from((await import("./db")).schema.burnSamples);
    expect(rows).toHaveLength(0);
  });

  it("swallows a read that throws (fail-soft) and records nothing", async () => {
    const sample = await sampleJobBurn(t.db, clock, "review-fix", null, usage(10, 5), async () => {
      throw new Error("usage endpoint down");
    });
    expect(sample).toBeNull();
    const rows = await t.db.select().from((await import("./db")).schema.burnSamples);
    expect(rows).toHaveLength(0);
  });
});

describe("getProjectBurnAverage", () => {
  let t: TestDb;
  let clock: FakeClock;
  beforeEach(async () => {
    t = makeTestDb();
    clock = new FakeClock(1_700_000_000_000);
    await seedProject(t, "proj-a");
    await seedProject(t, "proj-b");
  });
  afterEach(() => t.close());

  it("keeps one project's burn out of another's average", async () => {
    for (let i = 0; i < BURN_SAMPLE_WINDOW; i++) {
      await recordBurnSample(t.db, clock, "execute-epic", "proj-a", {
        sessionDelta: 40,
        weeklyDelta: 5,
      });
      clock.advance(1_000);
      await recordBurnSample(t.db, clock, "execute-epic", "proj-b", {
        sessionDelta: 10,
        weeklyDelta: 1,
      });
      clock.advance(1_000);
    }

    const a = await getProjectBurnAverage(t.db, "proj-a", "execute-epic");
    const b = await getProjectBurnAverage(t.db, "proj-b", "execute-epic");
    expect(a.sessionAvg).toBe(40);
    expect(b.sessionAvg).toBe(10);
    // The global per-type average still spans both — it is what cost estimates read. Its window is
    // the most recent five rows overall (b,a,b,a,b here), so it lands between the two projects.
    expect((await getBurnAverage(t.db, "execute-epic")).sessionAvg).toBe(22);
  });

  it("excludes unattributed samples rather than charging them to a project", async () => {
    for (let i = 0; i < BURN_SAMPLE_WINDOW; i++) {
      await recordBurnSample(t.db, clock, "execute-epic", null, { sessionDelta: 40, weeklyDelta: 5 });
      clock.advance(1_000);
    }
    await recordBurnSample(t.db, clock, "execute-epic", "proj-a", {
      sessionDelta: 10,
      weeklyDelta: 1,
    });

    const a = await getProjectBurnAverage(t.db, "proj-a", "execute-epic");
    expect(a.sampleCount).toBe(1); // the five unattributed rows are not this project's
    const seed = TIER_SEEDS.L;
    const pad = BURN_SAMPLE_WINDOW - 1;
    expect(a.sessionAvg).toBeCloseTo((10 + pad * seed.sessionPct) / BURN_SAMPLE_WINDOW, 5);
  });

  it("reads a project with no samples of its own as seeded, never borrowed", async () => {
    for (let i = 0; i < BURN_SAMPLE_WINDOW; i++) {
      await recordBurnSample(t.db, clock, "execute-epic", "proj-b", {
        sessionDelta: 40,
        weeklyDelta: 5,
      });
      clock.advance(1_000);
    }
    const a = await getProjectBurnAverage(t.db, "proj-a", "execute-epic");
    expect(a.sampleCount).toBe(0);
    expect(a.seeded).toBe(true);
    expect(a.sessionAvg).toBe(TIER_SEEDS.L.sessionPct);
  });
});
