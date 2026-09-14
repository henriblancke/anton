import { afterEach, describe, expect, it } from "vitest";

import {
  armRouterBackoffForTest,
  fetchRouterUsage,
  getRouterUsageCached,
  getRouterUsageFresh,
  parseRouterUsage,
  resetRouterUsageCache,
  routerUsageUrl,
  type RouterUsage,
} from "./router-usage";

/**
 * Captured from a live 9Router instance's `GET /api/usage/<connectionId>` response (anton-m5oc).
 * `used` is a 0–100 "percent used" figure (9Router's own `createQuotaObject`, matching the
 * Anthropic convention `usage.ts` already consumes) — no scaling; `resetAt` is an ISO-8601 string.
 */
const ROUTER_FIXTURE = {
  plan: "Claude Code",
  extraUsage: null,
  quotas: {
    "session (5h)": {
      used: 64,
      total: 100,
      remaining: 36,
      remainingPercentage: 36,
      resetAt: "2026-09-13T20:40:00.000Z",
      unlimited: false,
    },
    "weekly (7d)": {
      used: 37,
      total: 100,
      remaining: 63,
      remainingPercentage: 63,
      resetAt: "2026-09-14T00:00:00.000Z",
      unlimited: false,
    },
  },
} as const;

const SETTINGS = {
  claudeBaseUrl: "http://localhost:20128",
  claudeAuthTokenEnv: "ROUTER_TOKEN_TEST",
  routerConnectionId: "conn_ab12cd34",
};

function withResponse(status: number, ok: boolean, body: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    ok,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  } as unknown as Response;
}

describe("routerUsageUrl", () => {
  it("builds the per-connection endpoint from the router's base URL", () => {
    expect(routerUsageUrl("http://localhost:20128", "conn_ab12cd34")).toBe(
      "http://localhost:20128/api/usage/conn_ab12cd34",
    );
  });

  it("strips a trailing slash and encodes the connection id", () => {
    expect(routerUsageUrl("https://gateway.example/", "conn ab/cd")).toBe(
      "https://gateway.example/api/usage/conn%20ab%2Fcd",
    );
  });

  it("uses the router origin when the Claude-compatible base URL includes /v1", () => {
    expect(routerUsageUrl("https://api.9router.dev/v1", "conn_ab12cd34")).toBe(
      "https://api.9router.dev/api/usage/conn_ab12cd34",
    );
  });
});

describe("parseRouterUsage", () => {
  it("reads session + weekly from the quotas map (percents, ISO resets, no scaling)", () => {
    expect(parseRouterUsage(ROUTER_FIXTURE)).toEqual<RouterUsage>({
      sessionPct: 64,
      weeklyPct: 37,
      sessionResetAt: "2026-09-13T20:40:00.000Z",
      weeklyResetAt: "2026-09-14T00:00:00.000Z",
      plan: "Claude Code",
    });
  });

  it("falls back to the caller-supplied plan when the router doesn't report one", () => {
    const noPlan = { quotas: ROUTER_FIXTURE.quotas };
    expect(parseRouterUsage(noPlan, "fallback-plan")?.plan).toBe("fallback-plan");
  });

  it.each([
    ["a missing weekly window", { quotas: { "session (5h)": ROUTER_FIXTURE.quotas["session (5h)"] } }],
    ["a missing session window", { quotas: { "weekly (7d)": ROUTER_FIXTURE.quotas["weekly (7d)"] } }],
    ["no quotas object at all", { plan: "Claude Code" }],
    ["a not-found error body", { error: "Connection not found" }],
    ["a not-yet-authorized message body", { message: "Usage not available for this connection" }],
    ["a non-object body", "nope"],
    ["a null body", null],
    [
      "a negative session percentage",
      {
        quotas: {
          "session (5h)": { ...ROUTER_FIXTURE.quotas["session (5h)"], used: -1 },
          "weekly (7d)": ROUTER_FIXTURE.quotas["weekly (7d)"],
        },
      },
    ],
    [
      "a weekly percentage above the router's 0–100 contract",
      {
        quotas: {
          "session (5h)": ROUTER_FIXTURE.quotas["session (5h)"],
          "weekly (7d)": { ...ROUTER_FIXTURE.quotas["weekly (7d)"], used: 999 },
        },
      },
    ],
    [
      "an invalid reset timestamp",
      {
        quotas: {
          "session (5h)": { ...ROUTER_FIXTURE.quotas["session (5h)"], resetAt: "not-a-date" },
          "weekly (7d)": ROUTER_FIXTURE.quotas["weekly (7d)"],
        },
      },
    ],
  ])("returns null for %s — never a fabricated percentage", (_label, body) => {
    expect(parseRouterUsage(body)).toBeNull();
  });

  it("does not invent a percentage when one window is reported unlimited", () => {
    // The router reports no meaningful window here (unlimited has no percent that means anything);
    // this must stay null rather than render as 0% used.
    const body = {
      quotas: {
        "session (5h)": ROUTER_FIXTURE.quotas["session (5h)"],
        "weekly (7d)": { used: 0, total: 100, remaining: 100, remainingPercentage: 100, resetAt: null, unlimited: true },
      },
    };
    expect(parseRouterUsage(body)).toBeNull();
  });
});

describe("fetchRouterUsage", () => {
  const prior = process.env.ROUTER_TOKEN_TEST;
  afterEach(() => {
    if (prior === undefined) delete process.env.ROUTER_TOKEN_TEST;
    else process.env.ROUTER_TOKEN_TEST = prior;
  });

  it("returns a normalized snapshot on a healthy 200", async () => {
    process.env.ROUTER_TOKEN_TEST = "secret";
    const result = await fetchRouterUsage(SETTINGS, async () => withResponse(200, true, ROUTER_FIXTURE));
    expect(result).toEqual<RouterUsage>({
      sessionPct: 64,
      weeklyPct: 37,
      sessionResetAt: "2026-09-13T20:40:00.000Z",
      weeklyResetAt: "2026-09-14T00:00:00.000Z",
      plan: "Claude Code",
    });
  });

  it("sends the configured token without ever returning it", async () => {
    process.env.ROUTER_TOKEN_TEST = "super-secret";
    const requests: RequestInit[] = [];
    const result = await fetchRouterUsage(SETTINGS, async (_url, init) => {
      requests.push(init ?? {});
      return withResponse(200, true, ROUTER_FIXTURE);
    });
    expect(requests[0]?.headers).toMatchObject({ Authorization: "Bearer super-secret" });
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  it("returns null on a 404", async () => {
    process.env.ROUTER_TOKEN_TEST = "secret";
    const result = await fetchRouterUsage(SETTINGS, async () =>
      withResponse(404, false, { error: "Connection not found" }),
    );
    expect(result).toBeNull();
  });

  it("returns null on a 500", async () => {
    process.env.ROUTER_TOKEN_TEST = "secret";
    const result = await fetchRouterUsage(SETTINGS, async () => withResponse(500, false, { error: "boom" }));
    expect(result).toBeNull();
  });

  it("returns null on a timeout (fetch rejects) — never throws", async () => {
    process.env.ROUTER_TOKEN_TEST = "secret";
    await expect(
      fetchRouterUsage(SETTINGS, async () => {
        throw new DOMException("The operation was aborted", "AbortError");
      }),
    ).resolves.toBeNull();
  });

  it("returns null on non-JSON garbage in the body — never throws", async () => {
    process.env.ROUTER_TOKEN_TEST = "secret";
    const result = await fetchRouterUsage(SETTINGS, async () =>
      withResponse(200, true, new SyntaxError("Unexpected token")),
    );
    expect(result).toBeNull();
  });

  it("returns null when the connection has no router configured at all", async () => {
    process.env.ROUTER_TOKEN_TEST = "secret";
    const result = await fetchRouterUsage({}, async () => withResponse(200, true, ROUTER_FIXTURE));
    expect(result).toBeNull();
  });

  it("returns null when the base URL is set but no connection id is configured", async () => {
    process.env.ROUTER_TOKEN_TEST = "secret";
    const result = await fetchRouterUsage(
      { claudeBaseUrl: SETTINGS.claudeBaseUrl, claudeAuthTokenEnv: SETTINGS.claudeAuthTokenEnv },
      async () => withResponse(200, true, ROUTER_FIXTURE),
    );
    expect(result).toBeNull();
  });

  it("returns null when the token env var is unset — no request is made", async () => {
    delete process.env.ROUTER_TOKEN_TEST;
    let called = false;
    const result = await fetchRouterUsage(SETTINGS, async () => {
      called = true;
      return withResponse(200, true, ROUTER_FIXTURE);
    });
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it("arms the shared 429 backoff and returns null", async () => {
    process.env.ROUTER_TOKEN_TEST = "secret";
    resetRouterUsageCache();
    const result = await fetchRouterUsage(SETTINGS, async () =>
      withResponse(429, false, { error: "rate limited" }, { "retry-after": "30" }),
    );
    expect(result).toBeNull();

    // A second read this soon must not hit upstream: getRouterUsageCached honors the armed backoff.
    let calls = 0;
    await getRouterUsageCached(
      SETTINGS,
      async () => {
        calls += 1;
        return withResponse(200, true, ROUTER_FIXTURE);
      },
      () => Date.now(),
    );
    expect(calls).toBe(0);
    resetRouterUsageCache();
  });
});

describe("getRouterUsageFresh", () => {
  afterEach(() => resetRouterUsageCache());

  it("bypasses a warm TTL cache and refreshes it with the burn-window endpoint read", async () => {
    process.env.ROUTER_TOKEN_TEST = "secret";
    let clock = 1_000;
    const now = () => clock;
    const first = {
      ...ROUTER_FIXTURE,
      quotas: {
        ...ROUTER_FIXTURE.quotas,
        "session (5h)": { ...ROUTER_FIXTURE.quotas["session (5h)"], used: 10 },
      },
    };
    const second = {
      ...ROUTER_FIXTURE,
      quotas: {
        ...ROUTER_FIXTURE.quotas,
        "session (5h)": { ...ROUTER_FIXTURE.quotas["session (5h)"], used: 20 },
      },
    };
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return withResponse(200, true, calls === 1 ? first : second);
    };

    await getRouterUsageCached(SETTINGS, fetcher, now);
    clock += 1;
    expect((await getRouterUsageFresh(SETTINGS, fetcher, now))?.sessionPct).toBe(20);
    expect(calls).toBe(2);
    expect((await getRouterUsageCached(SETTINGS, fetcher, now))?.sessionPct).toBe(20);
    expect(calls).toBe(2);
  });

  it("returns null during shared 429 backoff so a burn window cannot sample stale usage", async () => {
    process.env.ROUTER_TOKEN_TEST = "secret";
    const clock = 1_000;
    const now = () => clock;
    const cached = async () => withResponse(200, true, ROUTER_FIXTURE);
    await getRouterUsageCached(SETTINGS, cached, now);
    armRouterBackoffForTest(
      SETTINGS.claudeBaseUrl,
      SETTINGS.routerConnectionId,
      SETTINGS.claudeAuthTokenEnv,
      clock + 5 * 60_000,
    );

    let calls = 0;
    const result = await getRouterUsageFresh(
      SETTINGS,
      async () => {
        calls += 1;
        return withResponse(200, true, ROUTER_FIXTURE);
      },
      now,
    );

    expect(result).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("getRouterUsageCached (mirrors usage.ts's TTL, single-flight, and 429 backoff)", () => {
  afterEach(() => resetRouterUsageCache());

  it("serves the cached value within the TTL, fetching only once", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return withResponse(200, true, ROUTER_FIXTURE);
    };
    let clock = 1_000;
    const now = () => clock;
    process.env.ROUTER_TOKEN_TEST = "secret";

    const first = await getRouterUsageCached(SETTINGS, fetcher, now);
    clock += 59_000;
    const second = await getRouterUsageCached(SETTINGS, fetcher, now);
    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it("re-fetches once the TTL elapses", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return withResponse(200, true, ROUTER_FIXTURE);
    };
    let clock = 1_000;
    const now = () => clock;
    process.env.ROUTER_TOKEN_TEST = "secret";

    await getRouterUsageCached(SETTINGS, fetcher, now);
    clock += 60_000;
    await getRouterUsageCached(SETTINGS, fetcher, now);
    expect(calls).toBe(2);
  });

  it("caches a null result so a transient outage does not hammer the endpoint", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return withResponse(500, false, { error: "boom" });
    };
    process.env.ROUTER_TOKEN_TEST = "secret";
    const now = () => 1_000;

    expect(await getRouterUsageCached(SETTINGS, fetcher, now)).toBeNull();
    expect(await getRouterUsageCached(SETTINGS, fetcher, now)).toBeNull();
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
      await gate;
      return withResponse(200, true, ROUTER_FIXTURE);
    };
    process.env.ROUTER_TOKEN_TEST = "secret";
    const now = () => 1_000;

    const first = getRouterUsageCached(SETTINGS, fetcher, now);
    const second = getRouterUsageCached(SETTINGS, fetcher, now);
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
  });

  it("honors the shared 429 backoff, serving the last cached value instead of hitting upstream", async () => {
    let clock = 1_000;
    const now = () => clock;
    let calls = 0;
    process.env.ROUTER_TOKEN_TEST = "secret";
    const live = async () => {
      calls += 1;
      return withResponse(200, true, ROUTER_FIXTURE);
    };

    await getRouterUsageCached(SETTINGS, live, now); // warm the cache
    armRouterBackoffForTest(
      SETTINGS.claudeBaseUrl,
      SETTINGS.routerConnectionId,
      SETTINGS.claudeAuthTokenEnv,
      clock + 5 * 60_000,
    );
    clock += 60_001; // TTL elapsed, but backoff still active
    const result = await getRouterUsageCached(SETTINGS, live, now);
    expect(result).not.toBeNull();
    expect(calls).toBe(1); // no new fetch — served from cache during backoff
  });

  it("keys the cache per management endpoint and connection so distinct routed projects don't collide", async () => {
    let calls = 0;
    process.env.ROUTER_TOKEN_TEST = "secret";
    const now = () => 1_000;
    const fetcher = async () => {
      calls += 1;
      return withResponse(200, true, ROUTER_FIXTURE);
    };

    await getRouterUsageCached(SETTINGS, fetcher, now);
    await getRouterUsageCached(
      { ...SETTINGS, routerConnectionId: "conn_other" },
      fetcher,
      now,
    );
    expect(calls).toBe(2); // two distinct connections, each fetched once
  });

  it("dedupes equivalent base-URL spellings across projects", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    process.env.ROUTER_TOKEN_TEST = "secret";
    const fetcher = async () => {
      calls += 1;
      await gate;
      return withResponse(200, true, ROUTER_FIXTURE);
    };
    const now = () => 1_000;

    const first = getRouterUsageCached(
      { ...SETTINGS, claudeBaseUrl: "http://router:20128" },
      fetcher,
      now,
    );
    const second = getRouterUsageCached(
      { ...SETTINGS, claudeBaseUrl: "http://router:20128/" },
      fetcher,
      now,
    );
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ sessionPct: 64, weeklyPct: 37 }),
      expect.objectContaining({ sessionPct: 64, weeklyPct: 37 }),
    ]);
    expect(calls).toBe(1);
  });

  it("shares 429 backoff between equivalent base-URL spellings", async () => {
    process.env.ROUTER_TOKEN_TEST = "secret";
    await fetchRouterUsage(
      { ...SETTINGS, claudeBaseUrl: "http://router:20128" },
      async () => withResponse(429, false, { error: "rate limited" }, { "retry-after": "30" }),
    );

    let calls = 0;
    const result = await getRouterUsageCached(
      { ...SETTINGS, claudeBaseUrl: "http://router:20128/" },
      async () => {
        calls += 1;
        return withResponse(200, true, ROUTER_FIXTURE);
      },
      Date.now,
    );

    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  it("isolates cached failures between distinct credential environment variables", async () => {
    const valid = { ...SETTINGS, claudeAuthTokenEnv: "ROUTER_TOKEN_VALID" };
    const missing = { ...SETTINGS, claudeAuthTokenEnv: "ROUTER_TOKEN_MISSING" };
    process.env.ROUTER_TOKEN_VALID = "secret";
    delete process.env.ROUTER_TOKEN_MISSING;
    let calls = 0;

    expect(await getRouterUsageCached(missing, async () => {
      calls += 1;
      return withResponse(200, true, ROUTER_FIXTURE);
    }, () => 1_000)).toBeNull();
    expect(await getRouterUsageCached(valid, async () => {
      calls += 1;
      return withResponse(200, true, ROUTER_FIXTURE);
    }, () => 1_000)).toEqual(expect.objectContaining({ weeklyPct: 37 }));
    expect(calls).toBe(1);
  });

  it("returns null without a fetch when the project isn't routed at all", async () => {
    let called = false;
    const result = await getRouterUsageCached({}, async () => {
      called = true;
      return withResponse(200, true, ROUTER_FIXTURE);
    });
    expect(result).toBeNull();
    expect(called).toBe(false);
  });
});
