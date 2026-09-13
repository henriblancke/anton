/**
 * The routed meter's view model for a project (anton-ds7e) — what the project view and its API
 * route need to render "this project's quota comes from its router", never the machine-wide
 * Anthropic meter the nav pill already owns.
 *
 * Three states, and no fourth: a project not pointed at a gateway is `unrouted` (nothing to show
 * here — the nav pill already covers it); a routed project whose router answered is `ok`, carrying
 * the normalized {@link RouterUsage} snapshot; a routed project whose router could not be read is
 * `unreadable` — named explicitly, never rendered as an empty or zeroed meter (anton-ds7e
 * acceptance). `getRouterUsageCached` already collapses every failure mode (no base URL, no token,
 * a non-200, a timeout, a malformed body) into `null`, so `unreadable` is simply "routed but null".
 */
import { endpointHostFromBaseUrl } from "@/lib/runs";
import type { ProjectSettings } from "@/lib/projects";
import { getRouterUsageCached, type RouterUsage } from "./router-usage";

export type RouterUsageView =
  | { state: "unrouted" }
  | {
      state: "ok";
      usage: RouterUsage;
      /** Host only — never the base URL's userinfo. */
      endpointHost: string;
      connectionId: string;
      /** The router's own dashboard — authoritative for per-provider detail (anton-ds7e). */
      dashboardUrl: string;
    }
  | {
      state: "unreadable";
      endpointHost: string;
      connectionId: string;
      dashboardUrl: string;
    };

type RouterProjectSettings = Pick<
  ProjectSettings,
  "claudeBaseUrl" | "claudeAuthTokenEnv" | "routerConnectionId"
>;

/**
 * The router's dashboard origin (anton-ds7e) — same host as the usage endpoint, no path, so it
 * points at the router's own UI rather than the usage API itself. `origin` never carries userinfo
 * (unlike the raw base URL), so this is safe to ship to the client. Falls back to the raw base URL
 * on an unparseable one — this only runs after `fetchRouterUsage` has already resolved a base URL
 * that parsed, so the fallback is defensive rather than a path expected to trigger.
 */
function dashboardUrlFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
}

/**
 * Resolve the routed-meter view for one project's settings. A project with no
 * {@link ProjectSettings.claudeBaseUrl} or no {@link ProjectSettings.routerConnectionId} is not
 * routed at all — the collapse rule (anton-m5oc) has nothing to collapse — so it is `unrouted`
 * without a request ever going out.
 */
export async function getRouterUsageView(
  settings: RouterProjectSettings,
  fetcher: typeof fetch = fetch,
): Promise<RouterUsageView> {
  const baseUrl = settings.claudeBaseUrl?.trim();
  const connectionId = settings.routerConnectionId?.trim();
  if (!baseUrl || !connectionId) return { state: "unrouted" };

  const endpointHost = endpointHostFromBaseUrl(baseUrl);
  const dashboardUrl = dashboardUrlFromBaseUrl(baseUrl);
  const usage = await getRouterUsageCached(settings, fetcher);
  if (!usage) return { state: "unreadable", endpointHost, connectionId, dashboardUrl };
  return { state: "ok", usage, endpointHost, connectionId, dashboardUrl };
}
