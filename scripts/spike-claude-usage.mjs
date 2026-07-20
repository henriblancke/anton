#!/usr/bin/env node
// Throwaway spike (anton-j6h): can anton read live Claude subscription usage headlessly?
//
// Answer (verified 2026-07-18, HTTP 200): yes.
//   GET https://api.anthropic.com/api/oauth/usage
//   with the Claude Code OAuth bearer token anton already has (keychain / ~/.claude).
//
// `utilization` is a 0-100 percent; `resets_at` is an ISO-8601 string. The purpose-built
// `limits[]` array (kind/percent/severity/resets_at/is_active) is what the pill should
// consume. Full findings: docs/spikes/2026-07-18-claude-usage-endpoint.md
//
// Run: node scripts/spike-claude-usage.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// OAuth creds: macOS keychain item "Claude Code-credentials"; Linux ~/.claude/.credentials.json.
function readOAuth() {
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8" },
    );
    return JSON.parse(raw).claudeAiOauth;
  } catch {
    return JSON.parse(
      readFileSync(`${process.env.HOME}/.claude/.credentials.json`, "utf8"),
    ).claudeAiOauth;
  }
}

const oauth = readOAuth();
const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
  headers: {
    Authorization: `Bearer ${oauth.accessToken}`,
    "Content-Type": "application/json",
    "anthropic-beta": "oauth-2025-04-20",
    "anthropic-version": "2023-06-01",
    "User-Agent": "anton-usage-spike/0.0",
  },
});
console.log(
  `HTTP ${res.status} ${res.statusText} | subscription=${oauth.subscriptionType} tier=${oauth.rateLimitTier}`,
);
if (!res.ok) process.exit(1);

const body = await res.json();
const line = (b) => (b ? `${b.utilization}%   resets ${b.resets_at}` : "(absent)");

console.log("\n=== top-level blocks ===");
console.log("Current session (five_hour):        ", line(body.five_hour));
console.log("Current week, all models (seven_day):", line(body.seven_day));

console.log("\n=== limits[] (what the pill should consume) ===");
for (const l of body.limits ?? []) {
  const scope = l.scope?.model?.display_name ? ` [${l.scope.model.display_name}]` : "";
  console.log(
    `${l.kind.padEnd(14)} ${String(l.percent).padStart(3)}%  sev=${l.severity} active=${l.is_active} resets=${l.resets_at ?? "-"}${scope}`,
  );
}
