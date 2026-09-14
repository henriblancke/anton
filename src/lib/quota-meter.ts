import { routerUsageUrl } from "./claude/router-endpoint";

/** The quota pool a project paces against: one router connection, or the shared Anthropic meter. */
export function quotaMeterKey(settings: {
  claudeBaseUrl?: string;
  routerConnectionId?: string;
}): string {
  const baseUrl = settings.claudeBaseUrl?.trim();
  const connectionId = settings.routerConnectionId?.trim();
  if (!baseUrl || !connectionId) return "anthropic";
  try {
    return `router:${routerUsageUrl(baseUrl, connectionId)}`;
  } catch {
    return "anthropic";
  }
}
