/**
 * Resolve a project's gateway settings into the environment a headless claude spawn is handed
 * (anton-72hj). A ROUTED project points the child at a Claude-compatible gateway; an UNROUTED one
 * clears anton's own gateway env so nothing ambient leaks into a project that never opted in.
 *
 * The TOKEN is never carried here. Routing names the env VAR to read it from, and the read happens at
 * spawn time (see {@link routingEnvDelta}) — so no token value ever reaches this object, and from it
 * nothing can reach argv, a log line, a session event, or an error message.
 */
import type { ProjectSettings } from "../projects";

/** The three env vars a gateway route controls; the delta always names all three (set or cleared). */
export const ANTHROPIC_BASE_URL_ENV = "ANTHROPIC_BASE_URL";
export const ANTHROPIC_AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";
export const GATEWAY_MODEL_DISCOVERY_ENV = "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY";

/**
 * Where a run's Claude traffic goes. `routed: false` is the Claude API — the explicit unrouted value
 * every non-gateway call site passes ({@link UNROUTED}), which clears any ambient gateway env. When
 * routed, the child is pointed at `baseUrl` and its token is read from the env var NAMED by
 * `authTokenEnv` at spawn time — the token value itself never rides on this object.
 */
export type ClaudeRouting =
  | { routed: false }
  | {
      routed: true;
      /** The gateway base URL, set as ANTHROPIC_BASE_URL for the child. */
      baseUrl: string;
      /** The NAME of the env var anton reads the gateway token from at spawn time. */
      authTokenEnv: string;
      /** Whether to enable the gateway's model discovery for the child. */
      gatewayModelDiscovery: boolean;
    };

/** The explicit unrouted value — the Claude API, with anton's ambient gateway env cleared. */
export const UNROUTED: ClaudeRouting = { routed: false };

/**
 * A project's settings → the routing a run drives with (anton-72hj). Routed iff a base URL is
 * configured; the API boundary guarantees a base URL never persists without its token env var
 * (`settings-patch.ts`), so a routed result always carries the name to read the token from. A base
 * URL that somehow arrives without one is treated as unrouted rather than routed-without-credential.
 */
export function claudeRouting(settings: ProjectSettings): ClaudeRouting {
  const baseUrl = settings.claudeBaseUrl?.trim();
  const authTokenEnv = settings.claudeAuthTokenEnv?.trim();
  if (!baseUrl || !authTokenEnv) return UNROUTED;
  return {
    routed: true,
    baseUrl,
    authTokenEnv,
    gatewayModelDiscovery: settings.claudeGatewayModelDiscovery ?? false,
  };
}

/** An env delta: a string SETS the var, `undefined` DELETES it (dropped from the child by Node). */
export type RoutingEnvDelta = Record<string, string | undefined>;

/**
 * The env DELTA a routing applies over anton's own environment (anton-72hj): all three gateway vars
 * SET when routed, all three DELETED (`undefined` ⇒ the child never sees anton's ambient copy) when
 * not. `spawnClaude` spreads this over `process.env`, and Node drops undefined-valued keys from the
 * child — so an unrouted run cannot inherit a stray ANTHROPIC_BASE_URL from anton's own shell.
 *
 * The token is read from `env` HERE, at spawn time — a routed project whose named var is unset fails
 * the run LOUD, naming both the variable and the setting, rather than silently spawning against the
 * Claude API with no credential. The token VALUE lands only in the returned map; it never appears in
 * the thrown message.
 */
export function routingEnvDelta(
  routing: ClaudeRouting,
  env: Record<string, string | undefined> = process.env,
): RoutingEnvDelta {
  if (!routing.routed) {
    return {
      [ANTHROPIC_BASE_URL_ENV]: undefined,
      [ANTHROPIC_AUTH_TOKEN_ENV]: undefined,
      [GATEWAY_MODEL_DISCOVERY_ENV]: undefined,
    };
  }
  const token = env[routing.authTokenEnv];
  if (!token) {
    throw new Error(
      `Claude gateway routing is configured but its token is missing: the env var ` +
        `${routing.authTokenEnv} (named by the project's "Auth token env var" setting) is unset in ` +
        `anton's environment. Export it to the gateway token, or clear the gateway Base URL to run ` +
        `against the Claude API.`,
    );
  }
  return {
    [ANTHROPIC_BASE_URL_ENV]: routing.baseUrl,
    [ANTHROPIC_AUTH_TOKEN_ENV]: token,
    // Only meaningful when enabled; cleared otherwise so no ambient value survives an unrouted->routed
    // project that left discovery off.
    [GATEWAY_MODEL_DISCOVERY_ENV]: routing.gatewayModelDiscovery ? "1" : undefined,
  };
}
