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
 * banner text unmodified, so matching the banners directly — rather than re-deriving driver-limits'
 * channel-aware logic — is enough for a single recorded string.
 */
const QUOTA_RE =
  /usage limit reached|5-hour limit reached|weekly limit reached|monthly spend limit|session limit\b[\s\S]{0,40}?resets?|out of usage credits|"type"\s*:\s*"rate_limit_error"|\[429\]|\[402\][\s\S]{0,200}?requires more credits/i;

/**
 * git/push/worktree/hooks failures (git/ops.ts `classifyPushFailure`, git/worktree.ts's rebase
 * recovery). `git push failed (exit N): ...` and the `[worktree] ... could not be rebased ...`
 * messages are each constructed in exactly one place, so their literal phrasing is stable.
 */
const INFRA_RE =
  /git push failed|pre-push hook declined|pre-receive hook declined|\[worktree\]|could not be rebased|could not read Username|index\.lock|gpg failed to sign|could not resolve host|remote end hung up|non-fast-forward/i;

/**
 * The claude driver's own failure shapes (driver-exit.ts `exitCodeError`/`stallError`/
 * `failureError`/`modelRefusalError`) — a deterministic non-zero exit, a stall kill, a missing
 * result event, or a refused model id. Each message is built in exactly one function, so its
 * leading phrasing is stable even though the trailing detail (the agent's own report) is not.
 */
const AGENT_RE =
  /^claude exited with code|claude produced no output for .*killed as stalled|claude exited without a result event|^claude refused to start: the model/i;

const PATTERNS: Array<{ cause: Exclude<FailureCause, "unknown">; pattern: Matcher }> = [
  // Freshness first: `isStaleCheckoutDeferral` is a prefix check on the one message
  // `staleCheckoutRefusal` builds, and that prefix ("anton is running behind ...") never overlaps
  // any of the other classes' vocabulary.
  { cause: "freshness", pattern: isStaleCheckoutDeferral },
  { cause: "quota", pattern: QUOTA_RE },
  { cause: "gate", pattern: GATE_RE },
  { cause: "infra", pattern: INFRA_RE },
  { cause: "agent", pattern: AGENT_RE },
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
