/**
 * The routed meter's view model (anton-ds7e): unrouted / ok / unreadable, and never a fourth state
 * that lets an unreadable router render as an empty or zeroed meter.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getRouterUsageView } from "./router-usage-view";
import { resetRouterUsageCache, type RouterUsage } from "./router-usage";

const SETTINGS = {
  claudeBaseUrl: "http://localhost:20128",
  claudeAuthTokenEnv: "ROUTER_VIEW_TOKEN_TEST",
  routerConnectionId: "conn_ab12cd34",
};

const USAGE: RouterUsage = {
  sessionPct: 64,
  weeklyPct: 37,
  sessionResetAt: "2026-09-13T20:40:00.000Z",
  weeklyResetAt: "2026-09-14T00:00:00.000Z",
  plan: "Claude Code",
};

function withResponse(status: number, ok: boolean, body: unknown) {
  return {
    status,
    ok,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

describe("getRouterUsageView", () => {
  const prior = process.env.ROUTER_VIEW_TOKEN_TEST;
  afterEach(() => {
    resetRouterUsageCache();
    if (prior === undefined) delete process.env.ROUTER_VIEW_TOKEN_TEST;
    else process.env.ROUTER_VIEW_TOKEN_TEST = prior;
  });

  it("is unrouted when no base URL is configured — no request goes out", async () => {
    let called = false;
    const view = await getRouterUsageView({}, async () => {
      called = true;
      return withResponse(200, true, {});
    });
    expect(view).toEqual({ state: "unrouted" });
    expect(called).toBe(false);
  });

  it("is unrouted when no connection id is configured", async () => {
    const view = await getRouterUsageView(
      { claudeBaseUrl: SETTINGS.claudeBaseUrl, claudeAuthTokenEnv: SETTINGS.claudeAuthTokenEnv },
      async () => withResponse(200, true, {}),
    );
    expect(view).toEqual({ state: "unrouted" });
  });

  it("is ok with a normalized snapshot, endpoint host, connection id, and dashboard url on a healthy read", async () => {
    process.env.ROUTER_VIEW_TOKEN_TEST = "secret";
    const view = await getRouterUsageView(SETTINGS, async () =>
      withResponse(200, true, {
        plan: "Claude Code",
        quotas: {
          "session (5h)": { used: 64, resetAt: "2026-09-13T20:40:00.000Z", unlimited: false },
          "weekly (7d)": { used: 37, resetAt: "2026-09-14T00:00:00.000Z", unlimited: false },
        },
      }),
    );
    expect(view).toEqual({
      state: "ok",
      usage: USAGE,
      endpointHost: "localhost:20128",
      connectionId: "conn_ab12cd34",
      dashboardUrl: "http://localhost:20128",
    });
  });

  it("is unreadable — never a zeroed or empty meter — when the router fails, naming what to check", async () => {
    process.env.ROUTER_VIEW_TOKEN_TEST = "secret";
    const view = await getRouterUsageView(SETTINGS, async () =>
      withResponse(500, false, { error: "boom" }),
    );
    expect(view).toEqual({
      state: "unreadable",
      endpointHost: "localhost:20128",
      connectionId: "conn_ab12cd34",
      dashboardUrl: "http://localhost:20128",
    });
  });

  it("is unreadable when the token env var isn't set — a routed project whose credential is missing is not silently unrouted", async () => {
    delete process.env.ROUTER_VIEW_TOKEN_TEST;
    const view = await getRouterUsageView(SETTINGS, async () => withResponse(200, true, {}));
    expect(view.state).toBe("unreadable");
  });
});
