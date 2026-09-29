/**
 * A stable cause label for a settled run's `runs.error` text (anton-nwnm8), derived from the error
 * string alone — never from a model call. Lets a failure spike point at what to fix (infrastructure,
 * a gate, staleness, quota, or the model) instead of reading as the model getting worse.
 *
 * Follows the pattern in {@link classifyFindingClass} (finding-class.ts): an ordered list of
 * matchers over recorded text, first match wins, with a single catch-all for anything unmatched —
 * here `"unknown"` rather than `"other"`, so a genuinely unrecognized failure is never folded into
 * `"agent"` and mistaken for a model regression.
 */
import { isStaleCheckoutDeferral } from "./jobs/errors";

export type FailureCause = "infra" | "gate" | "freshness" | "quota" | "agent" | "unknown";

type Matcher = RegExp | ((error: string) => boolean);

/**
 * `${gate.label} gate failed for ${subject} (exit ${code})` — the one phrase every verify-gate
 * failure site shares (steps/gates.ts, execute-epic-ticket-preserve.ts, review-gate.ts,
 * review-fix.ts), regardless of which gate (lint/test/typecheck/verify/build) or which caller.
 */
const GATE_RE = /\bgate failed\b/i;

/**
 * The quota banners Claude Code itself emits verbatim on an exhausted usage/spend/session limit or
 * rate-limited/billing-stopped API call (see driver-limits.ts, where each of these is documented as
 * "observed verbatim in anton.db"). `runs.error` stores `UsageLimitError.message`, which is that
 * banner text unmodified and always leading — driver-limits.ts's own channel scan trusts each banner
 * only as the leading content of the channel it came from — so every alternative below is anchored to
 * the start of the recorded string. That anchor is load-bearing: `exitCodeError` (driver-exit.ts)
 * prefixes a deterministic failure with `claude exited with code N: ` followed by the agent's own
 * freeform report, and that report can itself quote one of these phrases (e.g. narrating a fix to the
 * spend-limit matcher) without the run having hit quota. An unanchored match would misfile that
 * deterministic exit as `quota`; anchoring means only a genuine banner — which is never preceded by
 * that exit-code prefix — matches at all.
 */
const QUOTA_RE =
  /^\s*(?:(?:claude ai\s+)?usage limit reached|5-hour limit reached|weekly limit reached|(?:you['’]ve\s+)?(?:hit|reached) your monthly spend limit\b[\s\S]{0,80}?(?:claude\.ai\/settings\/usage|\/usage-credits\b)|you['’]ve hit your session limit\b[\s\S]{0,40}?resets?|you['’]re out of usage credits\b|API Error:[\s\S]{0,120}?(?:"type"\s*:\s*"rate_limit_error"|\[429\])|API Error:[\s\S]{0,120}?\[402\][\s\S]{0,200}?requires more credits)/i;

/**
 * git/push/worktree/hooks failures (git/ops.ts `classifyPushFailure`, git/worktree.ts's rebase
 * recovery). `git push failed (exit N): ...` and the `[worktree] ... could not be rebased ...`
 * messages are each constructed in exactly one place, so their literal phrasing is stable.
 */
const INFRA_RE =
  /git push failed|pre-push hook declined|pre-receive hook declined|\[worktree\]|could not be rebased|could not read Username|index\.lock|gpg failed to sign|could not resolve host|remote end hung up|non-fast-forward/i;

/**
 * The claude driver's own failure shapes (driver-exit.ts `exitCodeError`/`stallError`/
 * `failureError`/`modelRefusalError`), plus `execute-epic-ticket.ts`'s `BlockedByAgentError` —
 * a deterministic non-zero exit, a stall kill, a missing result event, a refused model id, or an
 * explicit self-reported block. Each message is built in exactly one function, so its leading
 * phrasing (or, for the self-report, its one fixed phrase) is stable even though the trailing
 * detail — the agent's own freeform report, for the exit-code case — is not.
 */
const AGENT_RE =
  /^claude exited with code|claude produced no output for .*killed as stalled|claude exited without a result event|^claude refused to start: the model|\bwas self-reported blocked by the agent\b/i;

const PATTERNS: Array<{ cause: Exclude<FailureCause, "unknown">; pattern: Matcher }> = [
  // Freshness first: `isStaleCheckoutDeferral` is a prefix check on the one message
  // `staleCheckoutRefusal` builds, and that prefix ("anton is running behind ...") never overlaps
  // any of the other classes' vocabulary.
  { cause: "freshness", pattern: isStaleCheckoutDeferral },
  { cause: "quota", pattern: QUOTA_RE },
  // Agent before gate/infra: `exitCodeError` wraps the agent's own freeform report as
  // `claude exited with code N: <report>`, and that report can narrate a gate or git failure in
  // prose ("the pre-push hook declined while I was working") without the run having hit either —
  // GATE_RE/INFRA_RE are unanchored and would otherwise match that embedded phrase first. Checking
  // the driver's own envelope (always anchored, built in exactly one place) before the unanchored
  // matchers means a real gate/infra failure — which never starts with this envelope — still
  // reaches its own matcher untouched.
  { cause: "agent", pattern: AGENT_RE },
  { cause: "gate", pattern: GATE_RE },
  { cause: "infra", pattern: INFRA_RE },
];

/**
 * Maps a run's recorded `runs.error` text to its cause by matching against the patterns above — no
 * model call, no network, and no way to throw. A missing error, or one that matches nothing, is
 * `"unknown"` — the single catch-all, kept apart from `"agent"` so a failure this classifier does
 * not recognize is never mistaken for the model itself regressing.
 */
export function classifyFailureCause(error: string | null | undefined): FailureCause {
  if (!error) return "unknown";
  for (const { cause, pattern } of PATTERNS) {
    const matched = typeof pattern === "function" ? pattern(error) : pattern.test(error);
    if (matched) return cause;
  }
  return "unknown";
}
