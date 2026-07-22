import { afterEach, describe, expect, it } from "vitest";

import {
  getClaudeUsageCached,
  getClaudeUsageFresh,
  getDisplayUsage,
  LAST_GOOD_TTL_MS,
  parseUsage,
  resetUsageCache,
  usageEnabled,
  USAGE_CACHE_TTL_MS,
  USAGE_FLAG_ENV,
  type ClaudeUsage,
} from "./usage";

/**
 * Captured from the live `/api/oauth/usage` response documented in the anton-j6h spike
 * (docs/spikes/2026-07-18-claude-usage-endpoint.md). `utilization`/`percent` are 0–100 percents;
 * `resets_at` is an ISO-8601 string — the shape the parser must consume without scaling.
 */
const USAGE_FIXTURE = {
  five_hour: { utilization: 64, resets_at: "2026-07-18T20:40:00.48+00:00", limit_dollars: null },
  seven_day: { utilization: 37, resets_at: "2026-07-19T00:00:00.48+00:00" },
  seven_day_opus: null,
  extra_usage: { is_enabled: false, monthly_limit: 5000, used_credits: 0 },
  limits: [
    { kind: "session", group: "session", percent: 64, severity: "normal", resets_at: "2026-07-18T20:40:00+00:00", scope: null, is_active: true },
    { kind: "weekly_all", group: "weekly", percent: 37, severity: "normal", resets_at: "2026-07-19T00:00:00+00:00", scope: null, is_active: false },
    { kind: "weekly_scoped", group: "weekly", percent: 0, severity: "normal", resets_at: null, scope: { model: { display_name: "Fable" } }, is_active: false },
  ],
} as const;

describe("usageEnabled", () => {
  afterEach(() => {
    delete process.env[USAGE_FLAG_ENV];
  });

  it("is on by default (flag unset) so the pill ships live", () => {
    delete process.env[USAGE_FLAG_ENV];
    expect(usageEnabled()).toBe(true);
  });

  it.each(["1", "true", "TRUE", "on", "yes", " true ", "", "anything"])(
    "treats %o as enabled",
    (value) => {
      process.env[USAGE_FLAG_ENV] = value;
      expect(usageEnabled()).toBe(true);
    },
  );

  it.each(["0", "false", "FALSE", "off", "no", " off "])("treats %o as disabled", (value) => {
    process.env[USAGE_FLAG_ENV] = value;
    expect(usageEnabled()).toBe(false);
  });
});

describe("parseUsage", () => {
  it("reads session + weekly from the limits[] array (percents, ISO resets, no scaling)", () => {
    expect(parseUsage(USAGE_FIXTURE, "max")).toEqual<ClaudeUsage>({
      sessionPct: 64,
      weeklyPct: 37,
      sessionResetAt: "2026-07-18T20:40:00+00:00",
      weeklyResetAt: "2026-07-19T00:00:00+00:00",
      plan: "max",
    });
  });

  it("falls back to the top-level five_hour / seven_day blocks when limits[] is absent", () => {
    const noLimits = { five_hour: USAGE_FIXTURE.five_hour, seven_day: USAGE_FIXTURE.seven_day };
    expect(parseUsage(noLimits, "pro")).toEqual<ClaudeUsage>({
      sessionPct: 64,
      weeklyPct: 37,
      sessionResetAt: "2026-07-18T20:40:00.48+00:00",
      weeklyResetAt: "2026-07-19T00:00:00.48+00:00",
      plan: "pro",
    });
  });

  it("defaults a missing percent to 0 while keeping the other limit", () => {
    const body = { limits: [{ kind: "session", percent: 12, resets_at: "2026-07-18T20:40:00+00:00" }] };
    expect(parseUsage(body, null)).toEqual<ClaudeUsage>({
      sessionPct: 12,
      weeklyPct: 0,
      sessionResetAt: "2026-07-18T20:40:00+00:00",
      weeklyResetAt: null,
      plan: null,
    });
  });

  it("returns null when neither a session nor weekly figure is present", () => {
    expect(parseUsage({ limits: [], spend: { enabled: false } }, "max")).toBeNull();
  });

  it("returns null for a non-object body", () => {
    expect(parseUsage(null, "max")).toBeNull();
    expect(parseUsage("nope", "max")).toBeNull();
  });
});

describe("getClaudeUsageCached", () => {
  afterEach(() => {
    resetUsageCache();
  });

  const snapshot: ClaudeUsage = {
    sessionPct: 10,
    weeklyPct: 5,
    sessionResetAt: null,
    weeklyResetAt: null,
    plan: "max",
  };

  it("serves the cached value within the TTL, fetching only once", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return snapshot;
    };
    let clock = 1_000;
    const now = () => clock;

    expect(await getClaudeUsageCached(fetcher, now)).toEqual(snapshot);
    clock += USAGE_CACHE_TTL_MS - 1;
    expect(await getClaudeUsageCached(fetcher, now)).toEqual(snapshot);
    expect(calls).toBe(1);
  });

  it("re-fetches once the TTL elapses", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return snapshot;
    };
    let clock = 1_000;
    const now = () => clock;

    await getClaudeUsageCached(fetcher, now);
    clock += USAGE_CACHE_TTL_MS;
    await getClaudeUsageCached(fetcher, now);
    expect(calls).toBe(2);
  });

  it("caches a null result so a transient outage does not hammer the endpoint", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return null;
    };
    const now = () => 1_000;

    expect(await getClaudeUsageCached(fetcher, now)).toBeNull();
    expect(await getClaudeUsageCached(fetcher, now)).toBeNull();
    expect(calls).toBe(1);
  });

  it("dedupes concurrent cold-cache callers into a single upstream fetch", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = async () => {
      calls += 1;
      await gate; // hold the fetch open so both callers race the empty cache
      return snapshot;
    };
    const now = () => 1_000;

    const first = getClaudeUsageCached(fetcher, now);
    const second = getClaudeUsageCached(fetcher, now);
    release();

    expect(await first).toEqual(snapshot);
    expect(await second).toEqual(snapshot);
    expect(calls).toBe(1);
  });
});

describe("getClaudeUsageFresh (TTL-bypassing read for the burn sampler)", () => {
  afterEach(() => {
    resetUsageCache();
  });

  const snapshot = (sessionPct: number): ClaudeUsage => ({
    sessionPct,
    weeklyPct: 5,
    sessionResetAt: null,
    weeklyResetAt: null,
    plan: "max",
  });

  it("goes upstream even when a cache entry is still inside the TTL", async () => {
    const now = () => 1_000;
    // Warm the cache, then verify a fresh read does NOT serve the entry back (the zero-delta trap).
    expect(await getClaudeUsageCached(async () => snapshot(10), now)).toEqual(snapshot(10));
    expect(await getClaudeUsageFresh(async () => snapshot(30), now)).toEqual(snapshot(30));
  });

  it("refreshes the shared cache so subsequent cached readers see the fresh value", async () => {
    let clock = 1_000;
    const now = () => clock;
    await getClaudeUsageCached(async () => snapshot(10), now);
    clock += 1;
    await getClaudeUsageFresh(async () => snapshot(30), now);
    // Still inside the TTL — the cached read now serves the sampler's fresher value.
    expect(await getClaudeUsageCached(async () => snapshot(99), now)).toEqual(snapshot(30));
  });

  it("never serves a fetch that was already in flight when called (stale pre-job read)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The pill's cached read starts mid-job and is still in flight when the job closes…
    const preJob = getClaudeUsageCached(async () => {
      await gate;
      return snapshot(10);
    }, () => 1_000);
    // …so the sampler's post-job read must NOT join it: that snapshot predates the job's burn and
    // would record a zero/undercounted delta.
    const postJob = getClaudeUsageFresh(async () => snapshot(50), () => 1_001);
    release();

    expect(await preJob).toEqual(snapshot(10));
    expect(await postJob).toEqual(snapshot(50)); // its own upstream read, not the stale join
  });

  it("waits out an in-flight fetch (no parallel upstream request) before taking its own read", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = async () => {
      calls += 1;
      if (calls === 1) await gate; // hold only the first fetch open
      return snapshot(calls * 20);
    };
    const now = () => 1_000;

    const first = getClaudeUsageFresh(fetcher, now);
    const second = getClaudeUsageFresh(fetcher, now);
    expect(calls).toBe(1); // the second caller is waiting on the first, not racing it upstream
    release();

    expect(await first).toEqual(snapshot(20));
    expect(await second).toEqual(snapshot(40)); // re-fetched after the first settled
    expect(calls).toBe(2);
  });
});

describe("getDisplayUsage (last-good fallback, anton-7mpv.1)", () => {
  afterEach(() => {
    resetUsageCache();
  });

  const snapshot: ClaudeUsage = {
    sessionPct: 42,
    weeklyPct: 12,
    sessionResetAt: null,
    weeklyResetAt: null,
    plan: "max",
  };

  it("returns the fresh read when the fetch succeeds", async () => {
    const now = () => 1_000;
    expect(await getDisplayUsage(async () => snapshot, now)).toEqual(snapshot);
  });

  it("falls back to the last-good value when a later read fails (pill stays lit)", async () => {
    let clock = 1_000;
    const now = () => clock;
    // Prime a good value, then let the live read start failing (null).
    expect(await getDisplayUsage(async () => snapshot, now)).toEqual(snapshot);
    clock += USAGE_CACHE_TTL_MS; // force a re-fetch that now returns null
    expect(await getDisplayUsage(async () => null, now)).toEqual(snapshot); // still lit via last-good
  });

  it("stops backing the display once the last-good value ages past its window", async () => {
    let clock = 1_000;
    const now = () => clock;
    expect(await getDisplayUsage(async () => snapshot, now)).toEqual(snapshot);
    clock += LAST_GOOD_TTL_MS; // last-good is now too stale to trust
    expect(await getDisplayUsage(async () => null, now)).toBeNull(); // → route answers 204, pill hides
  });

  it("returns null when there was never a successful read", async () => {
    const now = () => 1_000;
    expect(await getDisplayUsage(async () => null, now)).toBeNull();
  });
});
