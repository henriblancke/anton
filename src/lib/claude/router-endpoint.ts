/**
 * Canonical 9Router management endpoint construction shared by reads and quota-pool identity.
 * Claude-compatible gateway URLs may include a provider path such as `/v1`; the router management
 * API always lives at the origin, so the path must be replaced rather than appended.
 */
export function routerUsageUrl(baseUrl: string, connectionId: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/api/usage/${encodeURIComponent(connectionId)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
