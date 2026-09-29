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
import { isRecoverableClaudeText } from "./claude/driver-exit";
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
 * `failureError`/`modelRefusalError`), plus `execute-epic-ticket.ts`'s `BlockedByAgentError` and
 * `NoDeliveryError`, plus every `dispatchClaude` call site's own `failure()` callback
 * (steps/agent.ts, steps/describe.ts, review-gate.ts, review-fix.ts, product-master-steps.ts,
 * nightly-stringer-triage.ts) for a session that exited cleanly but self-reported `is_error` — a
 * deterministic non-zero exit, a stall kill, a missing result event, a refused model id, an
 * explicit self-reported block, a clean exit that left zero diff to deliver, or a clean exit the
 * model itself flagged as failed. Each message is built in exactly one function as the ENTIRE error
 * string (never appended to other text), so its full phrasing is stable and every alternative below
 * is anchored to the start — including the ticket-id ones: `BlockedByAgentError`'s message always
 * opens with `${ticket.id} was self-reported blocked by the agent`, and `NoDeliveryError`'s
 * zero-diff/preserved-adoption messages (execute-epic-ticket.ts) always open with
 * `${ticket.id} produced no delivery:`, so anchoring on that ticket-id prefix (the same shape
 * `bd`-produced ids take elsewhere, e.g. gardener/relink.ts's `ID_PATTERN`) still matches the real
 * producer while refusing a bare, unanchored occurrence of the phrase quoted inside nested
 * diagnostic output — e.g. a failing assertion's captured output, or a top-level gate failure whose
 * own `BlockedByAgentError`-related test fixture happens to echo it — which would otherwise outrank
 * the gate/infra matcher that should actually own that failure.
 */
const AGENT_RE =
  /^claude exited with code|^claude produced no output for .*killed as stalled|^claude exited without a result event|^claude refused to start: the model|^(?:claude|the product-master session|scan-triage|describer) reported an error\b|^[a-z][a-z0-9]*-[a-z0-9]{2,12}(?:\.[a-z0-9]+)* (?:was self-reported blocked by the agent\b|produced no delivery:)/i;

/**
 * The authoritative leading envelope every gate-failure site builds as the WHOLE message's start:
 * `${label} gate failed for ...` (steps/gates.ts, execute-epic-ticket-preserve.ts), `... gate failed
 * after review round N for ...` (review-gate.ts), or `... gate failed after review-fix for PR #N
 * ...` (review-fix.ts — which appends the failed gate's own captured output tail after this
 * envelope). Anchored, and checked before the unanchored `INFRA_RE` below, because that appended
 * tail is arbitrary test/build output that can itself contain an `INFRA_RE` phrase (e.g. a failing
 * test in git/worktree.ts whose assertion output quotes `[worktree] ... could not be rebased`) —
 * without this anchored check running first, that nested phrase would let `INFRA_RE` misfile the
 * real top-level gate failure as infra.
 */
const GATE_ENVELOPE_RE = /^\S+ gate failed\b/i;

const PATTERNS: Array<{ cause: Exclude<FailureCause, "unknown">; pattern: Matcher }> = [
  // Freshness first: `isStaleCheckoutDeferral` is a prefix check on the one message
  // `staleCheckoutRefusal` builds, and that prefix ("anton is running behind ...") never overlaps
  // any of the other classes' vocabulary.
  { cause: "freshness", pattern: isStaleCheckoutDeferral },
  { cause: "quota", pattern: QUOTA_RE },
  // Recoverable driver shapes before the agent envelope below: `exitCodeError`/`failureError`
  // (driver-exit.ts) build a `RecoverableClaudeError` for a transient network/upstream drop, a
  // truncated stream, or a stalled session — none of which is the agent's own doing — but once an
  // in-session resume exhausts, `settleRunRow` stores that error's `.message` as plain text, sharing
  // the exact same `claude exited with code N: ...` envelope as a deterministic agent failure.
  // `isRecoverableClaudeText` is the one place (driver-exit.ts) that knows which shapes are actually
  // transient; checking it here means a real outage no longer inflates the `agent` bucket.
  { cause: "infra", pattern: isRecoverableClaudeText },
  // Agent before gate/infra: `exitCodeError` wraps the agent's own freeform report as
  // `claude exited with code N: <report>`, and that report can narrate a gate or git failure in
  // prose ("the pre-push hook declined while I was working") without the run having hit either —
  // GATE_RE/INFRA_RE are unanchored and would otherwise match that embedded phrase first. Checking
  // the driver's own envelope (always anchored, built in exactly one place) before the unanchored
  // matchers means a real gate/infra failure — which never starts with this envelope — still
  // reaches its own matcher untouched.
  { cause: "agent", pattern: AGENT_RE },
  // Gate envelope before infra: a gate failure's own appended output tail (review-fix.ts) can
  // contain an INFRA_RE phrase (see GATE_ENVELOPE_RE's own doc comment). Checking the anchored
  // envelope here means a real top-level gate failure claims its cause before that unanchored,
  // nested phrase reaches INFRA_RE below.
  { cause: "gate", pattern: GATE_ENVELOPE_RE },
  // Infra before the broad gate fallback: `classifyPushFailure` records `git push failed ...`/
  // `pre-push hook declined ...` as the authoritative top-level envelope, but a pre-push hook that
  // runs this project's own gate check echoes that gate's "<label> gate failed for ..." phrase into
  // the captured stderr the envelope wraps. That message never matches GATE_ENVELOPE_RE above (it
  // doesn't open with the gate envelope), so it falls through to here: GATE_RE is a broad, unanchored
  // substring, so checking it before INFRA_RE would misfile that push failure as "gate" whenever the
  // hook's nested output happens to mention one. INFRA_RE's phrases are just as unanchored but far
  // more specific (git/worktree plumbing text a gate failure's own message never contains), so
  // checking it first lets the real push/worktree failure claim its envelope before the nested
  // "gate failed" substring can.
  { cause: "infra", pattern: INFRA_RE },
  // Final broad fallback: any other "gate failed" occurrence not already resolved by the anchored
  // envelope or claimed by infra above.
  { cause: "gate", pattern: GATE_RE },
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
