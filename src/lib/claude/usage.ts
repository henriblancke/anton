/**
 * Live Claude subscription usage — the data layer behind the global nav pill (anton-1nc).
 *
 * Reads the Claude Code OAuth bearer token anton already has (macOS keychain / ~/.claude) and
 * calls the undocumented `GET /api/oauth/usage` endpoint the CLI uses for its own `/usage`
 * screen. See docs/spikes/2026-07-18-claude-usage-endpoint.md (anton-j6h) for the full findings.
 *
 * ── Design constraints (from the spike) ──
 *   • Fail-soft everywhere: missing creds, a 401, a timeout, or a malformed body all return
 *     `null`. This is read straight into a nav render — it must never throw into a page.
 *   • Do NOT refresh the token. The CLI owns rotation; an independent refresh here can race the
 *     CLI's write and invalidate the user's live auth. anton drives `claude -p` frequently, so
 *     the token stays fresh — the pill just reads whatever is current and hides when it can't.
 *   • Cache server-side (short TTL) so many page loads collapse to one upstream fetch. The
 *     endpoint is cheap but undocumented; never hit it per request.
 *   • On by default — set `ANTON_USAGE_PILL` to a falsy value (`0`/`false`/`off`/`no`) to opt out.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Kill switch: usage fetching is on by default; set this env var falsy to turn the pill dark. */
export const USAGE_FLAG_ENV = "ANTON_USAGE_PILL";

/** Endpoint the Claude Code CLI's own `fetchUtilization()` calls. Undocumented; OAuth-gated. */
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** Request timeout — mirrors the CLI's 5 s budget for this fetch. */
const FETCH_TIMEOUT_MS = 5_000;

/** Short server-side cache TTL: collapse many page loads into one upstream fetch. */
export const USAGE_CACHE_TTL_MS = 60_000;

/** Normalized usage snapshot the pill consumes. `null` when a limit is absent for the tier. */
export interface ClaudeUsage {
  /** Current 5-hour session utilization, 0–100 percent. */
  sessionPct: number;
  /** Current week (all models) utilization, 0–100 percent. */
  weeklyPct: number;
  /** ISO-8601 timestamp the session limit resets, or null if unknown. */
  sessionResetAt: string | null;
  /** ISO-8601 timestamp the weekly limit resets, or null if unknown. */
  weeklyResetAt: string | null;
  /** Subscription plan (`max` / `pro` / …), or null if unknown. */
  plan: string | null;
}

/**
 * True when the usage pill is switched on for this deployment. On by default; only an explicit
 * falsy value (`0` / `false` / `off` / `no`) turns it off. Anything else — including unset —
 * leaves it enabled.
 */
export function usageEnabled(): boolean {
  const raw = process.env[USAGE_FLAG_ENV];
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

interface OAuthCreds {
  accessToken: string;
  subscriptionType?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readOAuthCreds(parsed: unknown): OAuthCreds | null {
  if (!isObject(parsed)) return null;
  const oauth = parsed.claudeAiOauth;
  if (!isObject(oauth) || typeof oauth.accessToken !== "string" || !oauth.accessToken) return null;
  return {
    accessToken: oauth.accessToken,
    subscriptionType: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : undefined,
  };
}

/**
 * Read the current OAuth token anton already holds. macOS stores it as a keychain generic
 * password (`Claude Code-credentials`); Linux writes `~/.claude/.credentials.json`. Both paths
 * fail-soft to `null` — no creds means no pill, never an error.
 */
async function readOAuth(): Promise<OAuthCreds | null> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      // Bound the call: a locked keychain (or an interactive access prompt) makes `security` block
      // indefinitely, and `execFile` has no default deadline — without a timeout the fail-soft
      // filesystem fallback below is never reached and the /api/usage fetch hangs. Short timeout so
      // a blocked keychain degrades to the fs path fast; maxBuffer mirrors the other CLI wrappers.
      { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 },
    );
    const creds = readOAuthCreds(JSON.parse(stdout));
    if (creds) return creds;
  } catch {
    // Not macOS, keychain item absent, or locked — fall through to the filesystem.
  }
  try {
    const raw = await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8");
    return readOAuthCreds(JSON.parse(raw));
  } catch {
    return null;
  }
}

function toPct(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toIso(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * Parse the `/api/oauth/usage` body into the pill's shape. Prefers the purpose-built `limits[]`
 * array (already normalized: kind/percent/resets_at) and falls back to the top-level per-limit
 * blocks (`five_hour` / `seven_day`). `utilization`/`percent` are 0–100 percents and `resets_at`
 * is an ISO string in the live API — no scaling (see the spike's "don't scale" warning).
 *
 * Returns `null` when neither a session nor a weekly figure is present, so the pill hides rather
 * than render an empty shell. Exported for unit-testing against a captured fixture.
 */
export function parseUsage(body: unknown, plan: string | null): ClaudeUsage | null {
  if (!isObject(body)) return null;

  const limits = Array.isArray(body.limits) ? body.limits : [];
  const byKind = (kind: string) =>
    limits.find((l): l is Record<string, unknown> => isObject(l) && l.kind === kind);
  const session = byKind("session");
  const weekly = byKind("weekly_all");

  const fiveHour = isObject(body.five_hour) ? body.five_hour : undefined;
  const sevenDay = isObject(body.seven_day) ? body.seven_day : undefined;

  const sessionPct = toPct(session?.percent) ?? toPct(fiveHour?.utilization);
  const weeklyPct = toPct(weekly?.percent) ?? toPct(sevenDay?.utilization);
  const sessionResetAt = toIso(session?.resets_at) ?? toIso(fiveHour?.resets_at);
  const weeklyResetAt = toIso(weekly?.resets_at) ?? toIso(sevenDay?.resets_at);

  if (sessionPct === null && weeklyPct === null) return null;

  return {
    sessionPct: sessionPct ?? 0,
    weeklyPct: weeklyPct ?? 0,
    sessionResetAt,
    weeklyResetAt,
    plan,
  };
}

/**
 * Fetch live usage once. Flag-gated and fail-soft: returns `null` when the pill is off, creds are
 * missing, the endpoint is unavailable, or the response is unusable. Never throws. Does NOT
 * refresh the token on 401 (the CLI owns rotation — see the module header).
 */
export async function fetchClaudeUsage(): Promise<ClaudeUsage | null> {
  if (!usageEnabled()) return null;

  const oauth = await readOAuth();
  if (!oauth) return null;

  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "User-Agent": "anton-usage/1.0",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null; // includes 401/expiry — fail soft, do not refresh
    return parseUsage(await res.json(), oauth.subscriptionType ?? null);
  } catch {
    return null; // network error, timeout, or malformed JSON
  }
}

interface UsageCacheEntry {
  at: number;
  value: ClaudeUsage | null;
}
let usageCache: UsageCacheEntry | null = null;
/**
 * The single upstream fetch currently in flight, shared by every concurrent caller until it
 * settles. Without this, simultaneous page loads that all miss a cold/stale cache would each run
 * their own keychain read + Anthropic request, defeating the rate-limit protection the cache
 * exists to provide.
 */
let usageInFlight: Promise<ClaudeUsage | null> | null = null;

/**
 * Server-side cached usage read for the route handler. Collapses bursts of page loads into one
 * upstream fetch within {@link USAGE_CACHE_TTL_MS}; `null` results are cached too, so a transient
 * outage doesn't hammer the endpoint. Concurrent callers that miss the cache share a single
 * in-flight fetch (single-flight), so only one upstream request runs per TTL window even under a
 * burst. `fetcher`/`now` are injectable for deterministic tests.
 */
export async function getClaudeUsageCached(
  fetcher: () => Promise<ClaudeUsage | null> = fetchClaudeUsage,
  now: () => number = Date.now,
): Promise<ClaudeUsage | null> {
  const ts = now();
  if (usageCache && ts - usageCache.at < USAGE_CACHE_TTL_MS) return usageCache.value;
  // Join the fetch already running for this TTL window rather than starting a second one.
  if (usageInFlight) return usageInFlight;
  usageInFlight = (async () => {
    try {
      const value = await fetcher();
      usageCache = { at: ts, value };
      return value;
    } finally {
      usageInFlight = null;
    }
  })();
  return usageInFlight;
}

/** Clear the module-level cache. Test-only. */
export function resetUsageCache(): void {
  usageCache = null;
  usageInFlight = null;
}
