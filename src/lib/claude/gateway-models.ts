import type { ProjectSettings } from "../projects";

const MODELS_TIMEOUT_MS = 5_000;

/** Build the OpenAI-compatible model-list endpoint from either a gateway origin or its `/v1` base. */
export function gatewayModelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path.endsWith("/v1") ? path : `${path}/v1`}/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Extract the stable, selectable model ids from an OpenAI-compatible `/v1/models` response. */
export function modelIdsFromGatewayResponse(body: unknown): string[] {
  if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data)) return [];
  return [
    ...new Set(
      body.data.flatMap((item) => {
        if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string") return [];
        const id = item.id.trim();
        return id && id.length <= 200 ? [id] : [];
      }),
    ),
  ].toSorted((a, b) => a.localeCompare(b));
}

/**
 * Read the configured gateway's model catalogue without letting its credential cross into the
 * browser. This is intentionally a short, uncached operator request: a gateway's active models
 * can change while the settings page remains open.
 */
export async function fetchGatewayModelIds(
  settings: Pick<ProjectSettings, "claudeBaseUrl" | "claudeAuthTokenEnv">,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  const baseUrl = settings.claudeBaseUrl?.trim();
  const tokenEnv = settings.claudeAuthTokenEnv?.trim();
  if (!baseUrl || !tokenEnv) throw new Error("Configure a gateway base URL and token env var first");

  const token = process.env[tokenEnv];
  if (!token) throw new Error(`Gateway token env var ${tokenEnv} is not set`);

  const response = await fetcher(gatewayModelsUrl(baseUrl), {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Gateway model discovery failed (${response.status})`);
  return modelIdsFromGatewayResponse(await response.json());
}
