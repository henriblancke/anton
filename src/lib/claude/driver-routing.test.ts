/**
 * The routing resolver (anton-72hj): a project's gateway settings → the routing a run drives with,
 * and that routing → the env delta a spawn applies over anton's own environment. These pin the
 * SET-when-routed / DELETE-when-not contract and the fail-loud on a named-but-unset token var, with
 * no process spawned. driver.test.ts proves the delta actually reaches a child.
 */
import { describe, expect, it } from "vitest";
import type { ProjectSettings } from "../projects";
import {
  ANTHROPIC_AUTH_TOKEN_ENV,
  ANTHROPIC_BASE_URL_ENV,
  claudeRouting,
  GATEWAY_MODEL_DISCOVERY_ENV,
  routingEnvDelta,
  UNROUTED,
} from "./driver-routing";

describe("claudeRouting", () => {
  it("resolves a fully configured project to a routed value carrying the token VAR NAME, not the token", () => {
    const settings: ProjectSettings = {
      claudeBaseUrl: "http://localhost:20128",
      claudeAuthTokenEnv: "GATEWAY_TOKEN",
      claudeGatewayModelDiscovery: true,
    };
    expect(claudeRouting(settings)).toEqual({
      routed: true,
      baseUrl: "http://localhost:20128",
      authTokenEnv: "GATEWAY_TOKEN",
      gatewayModelDiscovery: true,
    });
  });

  it("resolves an unconfigured project to the explicit unrouted value", () => {
    expect(claudeRouting({})).toBe(UNROUTED);
  });

  it("treats a base URL without a token env var as unrouted, never routed-without-credential", () => {
    // The API boundary forbids this pairing; the resolver is defensive rather than trusting.
    expect(claudeRouting({ claudeBaseUrl: "http://localhost:20128" })).toBe(UNROUTED);
  });

  it("defaults model discovery to off when routed without the flag", () => {
    const routing = claudeRouting({ claudeBaseUrl: "http://gw", claudeAuthTokenEnv: "TOK" });
    expect(routing).toMatchObject({ routed: true, gatewayModelDiscovery: false });
  });
});

describe("routingEnvDelta", () => {
  it("DELETES all three gateway vars for an unrouted run so nothing ambient leaks in", () => {
    expect(routingEnvDelta(UNROUTED)).toEqual({
      [ANTHROPIC_BASE_URL_ENV]: undefined,
      [ANTHROPIC_AUTH_TOKEN_ENV]: undefined,
      [GATEWAY_MODEL_DISCOVERY_ENV]: undefined,
    });
  });

  it("SETS all three vars for a routed run, reading the token from the named env var at call time", () => {
    const routing = claudeRouting({
      claudeBaseUrl: "http://gw",
      claudeAuthTokenEnv: "GATEWAY_TOKEN",
      claudeGatewayModelDiscovery: true,
    });
    const delta = routingEnvDelta(routing, { GATEWAY_TOKEN: "sekret-value" });
    expect(delta).toEqual({
      [ANTHROPIC_BASE_URL_ENV]: "http://gw",
      [ANTHROPIC_AUTH_TOKEN_ENV]: "sekret-value",
      [GATEWAY_MODEL_DISCOVERY_ENV]: "1",
    });
  });

  it("clears the discovery var for a routed run with discovery off (partially configured)", () => {
    const routing = claudeRouting({ claudeBaseUrl: "http://gw", claudeAuthTokenEnv: "TOK" });
    const delta = routingEnvDelta(routing, { TOK: "value" });
    expect(delta[ANTHROPIC_BASE_URL_ENV]).toBe("http://gw");
    expect(delta[ANTHROPIC_AUTH_TOKEN_ENV]).toBe("value");
    expect(delta[GATEWAY_MODEL_DISCOVERY_ENV]).toBeUndefined();
  });

  it("fails LOUD when the named token var is unset, naming the variable and the setting", () => {
    const routing = claudeRouting({ claudeBaseUrl: "http://gw", claudeAuthTokenEnv: "MISSING_TOKEN" });
    expect(() => routingEnvDelta(routing, {})).toThrow(/MISSING_TOKEN/);
    expect(() => routingEnvDelta(routing, {})).toThrow(/Auth token env var/);
  });

  it("never places a token value in the fail-loud message", () => {
    const routing = claudeRouting({ claudeBaseUrl: "http://gw", claudeAuthTokenEnv: "MISSING_TOKEN" });
    // The var is unset, so there is no value to leak — but the guard must key on the NAME, never
    // echo whatever the env holds under it. An empty string is unset, so this also proves the empty
    // case fails loud rather than spawning credential-less.
    let message = "";
    try {
      routingEnvDelta(routing, { MISSING_TOKEN: "" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("MISSING_TOKEN");
  });
});
