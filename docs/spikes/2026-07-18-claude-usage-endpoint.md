# Spike: fetch Claude subscription usage headlessly (anton-j6h)

**Date:** 2026-07-18 · **Epic:** anton-xn2 (global usage pill) · **Result:** ✅ REACHABLE

## Question

Can anton read live session/weekly usage + reset times headlessly, using the
subscription OAuth credentials it already has (no API key)? This de-risks the whole
usage-pill epic before any production code.

## Answer: yes

`GET https://api.anthropic.com/api/oauth/usage` returns HTTP 200 with live usage when
called with the Claude Code OAuth bearer token. Verified against a `max` subscription
(`default_claude_max_5x` tier); numbers match the interactive `/usage` screen
(session 64%, week 37% at time of test).

## Endpoint

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <claudeAiOauth.accessToken>   # sk-ant-oat01-...
Content-Type: application/json
anthropic-beta: oauth-2025-04-20
anthropic-version: 2023-06-01
```

Undocumented. This is exactly what the CLI's `fetchUtilization()` calls (found in the
Claude Code 2.1.214 bundle: `fetchUtilization: GET /api/oauth/usage`, 5 s timeout,
`refreshOAuth: true`).

## Auth mechanism (the credentials anton already has)

- **macOS:** keychain generic password, service `Claude Code-credentials`. Read with:
  `security find-generic-password -s "Claude Code-credentials" -w`
- **Linux:** `~/.claude/.credentials.json`
- JSON shape: `{ "claudeAiOauth": { accessToken, refreshToken, expiresAt,
  refreshTokenExpiresAt, scopes, subscriptionType, rateLimitTier } }`
- `accessToken` is an OAuth token (`sk-ant-oat01-…`), **not** an API key. Scopes include
  `user:profile` and `user:inference`. `subscriptionType` = `max`/`pro`/…,
  `rateLimitTier` = e.g. `default_claude_max_5x`.

## Response shape (live, 2026-07-18)

Two representations in the body:

**1. Top-level per-limit blocks** — `utilization` is a **0–100 percent** (NOT a 0–1
fraction), `resets_at` is an **ISO-8601 string** (NOT epoch seconds):

```jsonc
{
  "five_hour":  { "utilization": 64, "resets_at": "2026-07-18T20:40:00.48+00:00", "limit_dollars": null, ... },
  "seven_day":  { "utilization": 37, "resets_at": "2026-07-19T00:00:00.48+00:00", ... },
  "seven_day_opus": null, "seven_day_sonnet": null, "seven_day_oauth_apps": null, ...  // null when N/A for tier
  "extra_usage": { "is_enabled": false, "monthly_limit": 5000, "used_credits": 0, ... },
  "spend": { "used": {...}, "limit": {...}, "percent": 0, "enabled": false, ... }
}
```

> ⚠️ An older code path in the CLI bundle multiplies `utilization * 100` and
> `resets_at * 1000` (fraction + epoch). The **live** API has moved to percent + ISO
> string. Trust the live shape; don't scale.

**2. Purpose-built `limits[]` array** — the shape the pill should consume. Already
normalized with severity and an active flag:

```jsonc
"limits": [
  { "kind": "session",       "group": "session", "percent": 64, "severity": "normal", "resets_at": "2026-07-18T20:40:00+00:00", "scope": null, "is_active": true },
  { "kind": "weekly_all",    "group": "weekly",  "percent": 37, "severity": "normal", "resets_at": "2026-07-19T00:00:00+00:00", "scope": null, "is_active": false },
  { "kind": "weekly_scoped", "group": "weekly",  "percent": 0,  "severity": "normal", "resets_at": null, "scope": { "model": { "display_name": "Fable" } }, "is_active": false }
]
```

Map for the pill: `kind: "session"` → "Current session", `kind: "weekly_all"` →
"Current week (all models)", `kind: "weekly_scoped"` (with `scope.model.display_name`) →
per-model weekly. `severity` (`normal` / warn / crit) and `is_active` drive the
pill's ok/warn/crit state and "tightest active limit" selection directly.

## Refresh & rate-limit constraints

- **Token lifetime:** `accessToken` is short-lived (`expiresAt`, ~hours). On 401 the CLI
  refreshes via `POST https://console.anthropic.com/v1/oauth/token` with
  `grant_type=refresh_token`, `refresh_token`, `client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e`
  (public Claude Code OAuth client id), then writes the new token back to the keychain.
- **⚠️ Refresh-token rotation race (design guidance for anton-1nc):** the CLI owns token
  rotation. If anton refreshes independently and the provider rotates the refresh_token,
  anton's write and the CLI's write can invalidate each other's copy — breaking the
  user's live CLI auth. **Recommended: anton's fetch module should NOT refresh.** Read
  the current `accessToken` from the keychain and fail-soft on 401/expiry. anton already
  runs `claude -p` frequently (`src/lib/claude/driver.ts`), so the CLI keeps the token
  fresh; the pill just reads whatever is current and hides itself when it can't fetch.
- **Rate limits:** the CLI throttles its own usage fetches (`api_usage_fetch` cache,
  `fetchedAtMs`) and uses a 5 s request timeout. The endpoint is cheap but undocumented —
  anton-1nc should cache server-side (e.g. ≥30–60 s TTL) and never fetch per page load.
  This is a plain read; it does **not** consume the interactive `/usage` command or count
  against the inference quota.

## Reproduce

`node scripts/spike-claude-usage.mjs` (throwaway; see file). Prints HTTP status + parsed
session/week percentages and reset times.
