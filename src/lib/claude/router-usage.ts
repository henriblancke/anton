/**
 * A routed project's quota, read from its router instead of the Anthropic subscription endpoint
 * (anton-m5oc). When a project points at a Claude-compatible gateway (`claudeBaseUrl`), the
 * Anthropic meter `usage.ts` reads no longer describes what the project can spend — the router owns
 * that. This module reads the router's OWN usage endpoint and normalizes it into the same
 * {@link UsageSnapshot} shape `usage.ts` produces, so everything downstream (the tone ramp,
 * `tightestLimit`, a project view, a governor) works in a shape it already knows.
 *
 * ── The collapse rule (load-bearing, not implicit) ──
 * A router fronts N provider connections (OpenAI, Claude, Gemini, …), each with its own quota. A
 * project meters on exactly ONE of them — the connection named by `routerConnectionId` in its
 * settings — never a sum or an average across connections. The router's `/api/usage/<connectionId>`
 * endpoint already answers for one connection, so there is nothing to aggregate here; the collapse
 * happens at configuration time (the operator picks the one connection this project spends against),
 * and the UI copy in the gateway settings section states this rule so it is never inferred.
 *
 * ── Design constraints, mirrored from `usage.ts` rather than reinvented ──
 *   • Fail-soft everywhere: an absent endpoint (no base URL, no connection id, no token env var), a
 *     non-200, a timeout, or a malformed/unrecognized body all return `null`. Never throws.
 *   • Windows the router does not report are never fabricated. `UsageSnapshot`'s percentages are
 *     non-nullable numbers, so there is no honest way to report "unknown" for a single window
 *     without inventing a number — the snapshot itself is `null` unless BOTH the session and weekly
 *     windows are present. A partial answer with a guessed 0% would read as "plenty of quota left",
 *     which is the one wrong answer worse than no answer.
 *   • Short-TTL cache + single-flight + shared 429 backoff, using `usage.ts`'s own backoff math
 *     ({@link backoffMsFor}) and cache TTL ({@link USAGE_CACHE_TTL_MS}) — keyed per router endpoint +
 *     connection, since (unlike the one machine-wide Anthropic meter) many routed projects can point
 *     at different routers or different connections on the same router.
 *
 * The router's management API is undocumented and fork-varying (anton-dgtz's context); the shape
 * below is pinned from a live 9Router instance's `/api/usage/<connectionId>` response and treated as
 * the only shape this module understands — anything else is the fail-soft path, by design.
 */
import type { UsageSnapshot } from "@/lib/usage";
import type { ProjectSettings } from "../projects";
import { routerUsageUrl } from "./router-endpoint";
import { backoffMsFor, USAGE_CACHE_TTL_MS } from "./usage";

/** Request timeout — mirrors `usage.ts`'s 5 s budget for its own upstream fetch. */
const FETCH_TIMEOUT_MS = 5_000;

/** Normalized router usage — {@link UsageSnapshot} under this module's name, like `ClaudeUsage`. */
export type RouterUsage = UsageSnapshot;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toPct(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function toIso(value: unknown): string | null {
  return typeof value === "string" && value && Number.isFinite(Date.parse(value)) ? value : null;
}

/** One quota window (`session (5h)` / `weekly (7d)`) as 9Router's `createQuotaObject` shapes it. */
interface RouterWindow {
  pct: number;
  resetAt: string | null;
}

/**
 * Read one window out of the router's `quotas` map. `used` is already a 0–100 "percent used" figure
 * (9Router's own convention, matching Anthropic's `utilization`) — no scaling. An `unlimited` window
 * has no percentage that means anything, so it is treated as not reported rather than 0% used.
 */
function readWindow(win: unknown): RouterWindow | null {
  if (!isObject(win) || win.unlimited === true) return null;
  const pct = toPct(win.used);
  const resetAt = toIso(win.resetAt);
  if (pct === null || (win.resetAt !== null && win.resetAt !== undefined && resetAt === null)) return null;
  return { pct, resetAt };
}

/**
 * Parse the router's `/api/usage/<connectionId>` body into {@link RouterUsage}. Recorded fixtures:
 * healthy, missing fields, and the failure shapes (`{ message }` / `{ error }`) a disabled or
 * not-yet-authorized connection returns — all fall through to `null` because none carries a
 * `quotas` object.
 *
 * Returns `null` unless BOTH the session and weekly windows are present — see the module header for
 * why a partial read is not a partial snapshot. Exported for unit-testing against fixtures.
 */
export function parseRouterUsage(body: unknown, plan: string | null = null): RouterUsage | null {
  if (!isObject(body)) return null;
  const quotas = isObject(body.quotas) ? body.quotas : null;
  if (!quotas) return null;

  const session = readWindow(quotas["session (5h)"]);
  const weekly = readWindow(quotas["weekly (7d)"]);
  if (!session || !weekly) return null;

  const reportedPlan = typeof body.plan === "string" && body.plan ? body.plan : plan;
  return {
    sessionPct: session.pct,
    weeklyPct: weekly.pct,
    sessionResetAt: session.resetAt,
    weeklyResetAt: weekly.resetAt,
    plan: reportedPlan,
  };
}

export { routerUsageUrl } from "./router-endpoint";

/** The canonical endpoint and configured credential source identify one router meter read. */
const key = (url: string, connectionId: string, tokenEnv: string): string =>
  `${url}::${connectionId}::${tokenEnv}`;

type RouterSettings = Pick<ProjectSettings, "claudeBaseUrl" | "claudeAuthTokenEnv" | "routerConnectionId">;

/**
 * Fetch one router's usage for one connection, once. Fail-soft: an absent base URL, connection id,
 * or token env var, a non-200, a timeout, or an unparseable body all return `null`. Never throws.
 * Arms the shared 429 backoff for this (baseUrl, connectionId) pair on a rate limit, same as
 * `fetchClaudeUsage` does for the single Anthropic endpoint.
 */
export async function fetchRouterUsage(
  settings: RouterSettings,
  fetcher: typeof fetch = fetch,
): Promise<RouterUsage | null> {
  const baseUrl = settings.claudeBaseUrl?.trim();
  const connectionId = settings.routerConnectionId?.trim();
  const tokenEnv = settings.claudeAuthTokenEnv?.trim();
  if (!baseUrl || !connectionId || !tokenEnv) return null;

  const token = process.env[tokenEnv];
  if (!token) return null;

  let url: string;
  try {
    url = routerUsageUrl(baseUrl, connectionId);
  } catch {
    return null;
  }

  try {
    const res = await fetcher(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 429) {
      const waitMs = backoffMsFor(res.headers.get("retry-after"));
      state().backoffUntil.set(key(url, connectionId, tokenEnv), Date.now() + waitMs);
      console.warn(`[router-usage] ${baseUrl} 429 — backing off ${Math.round(waitMs / 1000)}s`);
      return null;
    }
    if (!res.ok) {
      console.warn(`[router-usage] ${baseUrl} responded ${res.status} — treating as unmetered`);
      return null;
    }
    return parseRouterUsage(await res.json());
  } catch (e) {
    console.warn(`[router-usage] ${baseUrl} fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

interface RouterCacheEntry {
  at: number;
  value: RouterUsage | null;
}

interface RouterUsageState {
  cache: Map<string, RouterCacheEntry>;
  inFlight: Map<string, Promise<RouterUsage | null>>;
  backoffUntil: Map<string, number>;
}

/**
 * Cache, single-flight, and 429 backoff live on `globalThis`, not module scope, for the same reason
 * as the job runner's singletons (`service-runner.ts:33-41`): Next compiles `instrumentation.ts` and
 * the app layer (RSC pages, route handlers) into SEPARATE module registries, so a module-level `Map`
 * yields one cache PER registry. Without this, the runner's governor/burn reads and a
 * `/router-usage` or Settings read never share a TTL, single-flight, or 429 backoff — concurrent
 * reads can duplicate router requests, and a 429 seen by one registry doesn't quiet the other.
 * Symbol.for keyed, matching the convention for process-wide state here.
 */
const STATE_KEY = Symbol.for("anton.claude.routerUsageState");

function state(): RouterUsageState {
  const global = globalThis as unknown as Record<symbol, RouterUsageState | undefined>;
  return (global[STATE_KEY] ??= {
    cache: new Map(),
    inFlight: new Map(),
    backoffUntil: new Map(),
  });
}

/**
 * TTL-bypassing read for a routed burn-sampling window. It honors a router's shared 429 backoff and
 * refreshes the short-TTL cache for ordinary readers, but returns `null` during backoff rather than
 * reusing a pre-job value for either side of the delta.
 */
export async function getRouterUsageFresh(
  settings: RouterSettings,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<RouterUsage | null> {
  const baseUrl = settings.claudeBaseUrl?.trim();
  const connectionId = settings.routerConnectionId?.trim();
  const tokenEnv = settings.claudeAuthTokenEnv?.trim();
  if (!baseUrl || !connectionId || !tokenEnv) return null;

  let url: string;
  try {
    url = routerUsageUrl(baseUrl, connectionId);
  } catch {
    return null;
  }

  const s = state();
  const k = key(url, connectionId, tokenEnv);
  if (now() < (s.backoffUntil.get(k) ?? 0)) return null;

  // A sampling edge cannot reuse a pre-existing flight: it may have begun before the job and
  // therefore cannot be the post-job side of the burn window. Wait for it to settle, then start
  // fresh evidence (or join a post-wait caller that already did), preserving single-flight.
  const stale = s.inFlight.get(k);
  if (stale) {
    await stale.catch(() => null);
    if (now() < (s.backoffUntil.get(k) ?? 0)) return null;
    const current = s.inFlight.get(k);
    if (current) return current;
  }

  const ts = now();
  const promise = (async () => {
    try {
      const value = await fetchRouterUsage(settings, fetcher);
      s.cache.set(k, { at: ts, value });
      return value;
    } finally {
      s.inFlight.delete(k);
    }
  })();
  s.inFlight.set(k, promise);
  return promise;
}

/**
 * Cached, single-flight, backoff-honoring read for one project's routed meter — the same TTL and
 * 429 discipline as `getClaudeUsageCached`, keyed per (baseUrl, connectionId) rather than global,
 * since distinct routed projects can point at distinct routers or distinct connections on the same
 * router. Returns `null` (never throws) when the project isn't routed at all — no base URL or no
 * connection id configured — without making a request.
 */
export async function getRouterUsageCached(
  settings: RouterSettings,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<RouterUsage | null> {
  const baseUrl = settings.claudeBaseUrl?.trim();
  const connectionId = settings.routerConnectionId?.trim();
  const tokenEnv = settings.claudeAuthTokenEnv?.trim();
  if (!baseUrl || !connectionId || !tokenEnv) return null;

  let url: string;
  try {
    url = routerUsageUrl(baseUrl, connectionId);
  } catch {
    return null;
  }

  const s = state();
  const k = key(url, connectionId, tokenEnv);
  const ts = now();

  const until = s.backoffUntil.get(k) ?? 0;
  if (ts < until) return s.cache.get(k)?.value ?? null;

  const entry = s.cache.get(k);
  if (entry && ts - entry.at < USAGE_CACHE_TTL_MS) return entry.value;

  const pending = s.inFlight.get(k);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const value = await fetchRouterUsage(settings, fetcher);
      s.cache.set(k, { at: ts, value });
      return value;
    } finally {
      s.inFlight.delete(k);
    }
  })();
  s.inFlight.set(k, promise);
  return promise;
}

/** Clear every keyed cache/backoff/in-flight entry. Test-only. */
export function resetRouterUsageCache(): void {
  const s = state();
  s.cache.clear();
  s.inFlight.clear();
  s.backoffUntil.clear();
}

/** Arm the 429 backoff for one canonical management endpoint, connection, and credential source. Test-only. */
export function armRouterBackoffForTest(
  baseUrl: string,
  connectionId: string,
  tokenEnv: string,
  until: number,
): void {
  state().backoffUntil.set(key(routerUsageUrl(baseUrl, connectionId), connectionId, tokenEnv), until);
}
