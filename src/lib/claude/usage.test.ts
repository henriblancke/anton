import { afterEach, describe, expect, it } from "vitest";

import {
  armBackoffForTest,
  backoffMsFor,
  DEFAULT_BACKOFF_MS,
  getClaudeUsageCached,
  getClaudeUsageFresh,
  getDisplayUsage,
  LAST_GOOD_TTL_MS,
  MIN_BACKOFF_MS,
  parseRetryAfterMs,
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

describe("parseRetryAfterMs", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfterMs("30")).toBe(30_000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("reads an HTTP-date relative to now", () => {
    const now = () => Date.parse("2026-07-22T00:00:00Z");
    expect(parseRetryAfterMs("Wed, 22 Jul 2026 00:00:45 GMT", now)).toBe(45_000);
  });

  it("returns null for a missing or unparseable header (caller uses its default)", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("not-a-date")).toBeNull();
  });
});

describe("backoffMsFor", () => {
  it("floors a Retry-After: 0 to the minimum (the no-op storm bug)", () => {
    expect(backoffMsFor("0")).toBe(DEFAULT_BACKOFF_MS); // 0 is non-positive → default, then floored
    expect(backoffMsFor("")).toBe(DEFAULT_BACKOFF_MS); // Number("") === 0 too
  });

  it("uses the default for a missing header", () => {
    expect(backoffMsFor(null)).toBe(DEFAULT_BACKOFF_MS);
  });

  it("honors a positive Retry-After but never below the floor", () => {
    expect(backoffMsFor("120")).toBe(120_000); // above the floor → honored
    expect(backoffMsFor("3")).toBe(MIN_BACKOFF_MS); // below the floor → clamped up
  });
});

describe("429 backoff (shared across all readers)", () => {
  afterEach(() => {
    resetUsageCache();
  });

  const snapshot: ClaudeUsage = {
    sessionPct: 20,
    weeklyPct: 8,
    sessionResetAt: null,
    weeklyResetAt: null,
    plan: "max",
  };

  it("pauses the fresh (sampler) path after a 429 until the window elapses", async () => {
    let clock = 1_000;
    const now = () => clock;
    let calls = 0;
    const live = async () => {
      calls += 1;
      return snapshot;
    };

    // Prime a good value, then simulate a 429 arming a 60s backoff (as fetchClaudeUsage does).
    await getClaudeUsageFresh(live, now);
    expect(calls).toBe(1);
    armBackoffForTest(clock + 60_000);

    // A solo job completing 5s later must NOT go upstream — and must NOT get the cached value
    // either: that cache entry may be the sampler's own pre-job reading, and a non-null pair would
    // record a bogus 0% burn sample. Null makes the sampler skip the sample instead.
    clock += 5_000;
    expect(await getClaudeUsageFresh(live, now)).toBeNull();
    expect(calls).toBe(1); // no new upstream request during backoff

    // Once the window passes, the sampler reads live again.
    clock += 60_000;
    await getClaudeUsageFresh(live, now);
    expect(calls).toBe(2);
  });

  it("re-checks the backoff after waiting out a stale in-flight that earned the 429", async () => {
    // The sampler passes its entry backoff check while another read is still in flight; that stale
    // read then hits a 429 and arms the backoff as it settles. The fresh path must re-check after
    // the drain — not fall through and re-hammer the endpoint that just said stop.
    const now = () => 1_000;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preJob = getClaudeUsageCached(async () => {
      await gate;
      armBackoffForTest(61_000); // what fetchClaudeUsage does on a 429
      return null;
    }, now);
    let freshCalls = 0;
    const postJob = getClaudeUsageFresh(async () => {
      freshCalls += 1;
      return snapshot;
    }, now);
    release();

    expect(await preJob).toBeNull();
    expect(await postJob).toBeNull(); // backoff honored — skip the sample
    expect(freshCalls).toBe(0); // no second upstream request
  });

  it("pauses the cached (pill/governor) path too, serving the last cached value", async () => {
    let clock = 1_000;
    const now = () => clock;
    let calls = 0;
    const live = async () => {
      calls += 1;
      return snapshot;
    };

    await getClaudeUsageCached(live, now); // warm the cache
    armBackoffForTest(clock + 5 * USAGE_CACHE_TTL_MS);
    clock += USAGE_CACHE_TTL_MS + 1; // TTL elapsed, but backoff still active
    expect(await getClaudeUsageCached(live, now)).toEqual(snapshot); // cached value, no new fetch
    expect(calls).toBe(1);
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
