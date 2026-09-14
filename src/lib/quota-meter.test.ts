import { describe, expect, it } from "vitest";

import { routerUsageUrl } from "./claude/router-endpoint";
import { quotaMeterKey } from "./quota-meter";

describe("quotaMeterKey", () => {
  it("uses the same canonical management endpoint as router usage reads", () => {
    const settings = {
      claudeBaseUrl: "https://router.example/v1?ignored=true",
      routerConnectionId: "conn a/b",
    };

    expect(quotaMeterKey(settings)).toBe(`router:${routerUsageUrl(settings.claudeBaseUrl, settings.routerConnectionId)}`);
  });

  it("falls back to the shared Anthropic pool for an incomplete or invalid route", () => {
    expect(quotaMeterKey({ claudeBaseUrl: "https://router.example" })).toBe("anthropic");
    expect(quotaMeterKey({ claudeBaseUrl: "not-a-url", routerConnectionId: "conn_1" })).toBe("anthropic");
  });
});
