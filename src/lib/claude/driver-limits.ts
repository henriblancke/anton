/**
 * Quota detection for the headless claude driver (anton-kvag): deciding whether a failed run hit a
 * usage/spend limit — which the runner parks and reschedules past — and when it resets. Split out
 * because the decision is a judgement about WHICH channel said what, and each regex below is
 * deliberately scoped to the authorship of the channel it is trusted against.
 */
import { UsageLimitError } from "../jobs/errors";

/**
 * The three channels a finished run leaves behind, kept apart because they have different authors:
 * `transcript` and `resultText` are model-authored, `stderr` is Claude Code's own.
 */
export interface ClaudeChannels {
  /** Every human-readable line claude streamed (assistant text + result text). */
  transcript: string;
  /** The final `result` field, or "" when the run emitted none. */
  resultText: string;
  /** Everything claude wrote to stderr. */
  stderr: string;
}

/**
 * Case-insensitive usage-limit phrasing Claude Code emits on an exhausted quota, anchored to the
 * start of a line (`^\s*…`, multiline `m`): the notice lands as the *leading* content of an
 * assistant block / the result field, whereas a quotation buried mid-sentence never starts a line.
 *
 * This RE covers the terse machine banners only — the 5-hour/weekly "usage limit reached" wording
 * (and the bare "Claude AI usage limit reached|<epoch>" variant). Those read unmistakably as
 * machine output, so they are trusted wherever they surface: the scan runs over the *combined*
 * transcript (assistant text + result + stderr), because Claude Code has emitted them in the result
 * field, in an assistant text block, or on stderr depending on how the run exited (anton-ner.2).
 *
 * The monthly spend-limit wording is deliberately NOT in this RE — see `SPEND_LIMIT_RE`.
 */
const USAGE_LIMIT_RE = /^\s*(?:(?:claude ai\s+)?usage limit reached|(?:5-hour|weekly) limit reached)/im;

/**
 * The monthly spend-limit banner Claude Code surfaces separately — observed as `You've hit your
 * monthly spend limit · raise it at claude.ai/settings/usage` (anton-b9l), or the no-link variant
 * `You've hit your monthly spend limit.` then `/usage-credits …` (Claude Code 2.1.172,
 * anthropics/claude-code#67579). A spend limit is a periodic quota that lifts on its own (a raised
 * cap or the next billing cycle), so it belongs with the usage limits: the runner reschedules past
 * a cool-off instead of burning attempts and parking.
 *
 * Unlike the terse banners above, this is an ordinary English sentence a model can reproduce
 * verbatim — an agent working this very ticket might quote it in its prose or a test fixture and
 * then fail for an unrelated reason (red tests, a rejected push). Matching that quote would refund
 * the attempt and reschedule the real failure forever. Three structural guards keep that out:
 *   1. The phrase must be followed by Claude Code's trailing remediation pointer — the
 *      `claude.ai/settings/usage` link or the `/usage-credits` slash-command pointer — within a
 *      bounded window (the banner renders across two lines), so a bare mention of the words
 *      "monthly spend limit" never matches.
 *   2. The model-authored assistant transcript is NEVER scanned for this wording (only the terse
 *      banners are — those can't be confused for prose). A model quoting the banner while it works
 *      lands in an assistant text block, which neither spend-limit RE ever sees.
 *   3. The remaining two channels are scanned with strictness matched to their authorship:
 *        • stderr is Claude Code's OWN diagnostic channel — the model streams to stdout, never the
 *          process stderr — so `SPEND_LIMIT_RE` (loose, line-anchored) is trusted there.
 *        • the result field IS the model's final text on an ordinary failed run, so it is trusted
 *          only via `SPEND_LIMIT_RESULT_RE`, which additionally end-anchors the match so the banner
 *          must constitute the WHOLE result. The genuine CLI abort emits the banner as the entire
 *          result with nothing appended; a failure that merely quotes the banner and then reports
 *          its own outcome ("…but three tests still fail") has trailing prose and no longer matches.
 *
 * Together these keep the genuine standalone notice matching in both wordings while letting a
 * failure that merely mentions the phrase — and ordinary payment failures (declined card, no
 * payment method) — fall through to a plain error for a human. The trade-off: a genuine spend-limit
 * banner surfaced *only* in an assistant block, or buried mid-result among other prose, is missed
 * and falls back to a plain error (park + burn an attempt) — the safe direction, far better than
 * infinite-rescheduling a real failure that happened to quote the banner.
 */
const SPEND_LIMIT_RE =
  /^\s*(?:you['’]ve\s+)?(?:hit|reached) your monthly spend limit\b[\s\S]{0,80}?(?:claude\.ai\/settings\/usage|\/usage-credits\b)/im;

/**
 * Result-field variant of `SPEND_LIMIT_RE`: the same banner + remediation pointer, but end-anchored
 * so the banner must be the ENTIRE result — only its own trailing line and whitespace may follow.
 * The result field is model-authored on ordinary failed runs, so a leading quote of the banner
 * followed by a failure report must NOT match (guard 3 above). Deliberately single-line (`i`, no
 * `m`): `$` anchors to the end of the whole result string, not each line.
 */
const SPEND_LIMIT_RESULT_RE =
  /^\s*(?:you['’]ve\s+)?(?:hit|reached) your monthly spend limit\b[\s\S]{0,80}?(?:claude\.ai\/settings\/usage|\/usage-credits\b)[^\n]*\s*$/i;

/**
 * OpenRouter's billing stop, wrapped inside a 503 envelope — observed verbatim as `API Error: 503
 * [openrouter/…] [402]: {"error":{"message":"This request requires more credits…` (anton-x96g, PR
 * #238/#252). The bare `503` in that string otherwise matches `TRANSIENT_STDERR_RE`
 * (driver-exit.ts) and gets resumed as a transient network blip against a wall that never moves —
 * quota classification must catch the buried `[402]` first. It is trusted in stderr, Claude Code's
 * own diagnostic channel; a result field must be the complete API-error envelope because the model
 * can quote the same machine error while reporting an unrelated failure.
 */
const GATEWAY_BILLING_RE = /\[402\][\s\S]{0,200}?requires more credits/i;
const GATEWAY_BILLING_RESULT_RE =
  /^[ \t]*API Error:\s*\d{3}\s+\[[^\]]+\]\s+\[402\]:\s*\{[^\n]{0,200}?requires more credits[^\n]*\}[ \t]*\n?$/i;

/**
 * A rate-limit stop trusted in stderr, and in a result only when the result is a complete API-error
 * envelope, the same way `GATEWAY_BILLING_RE` is: observed verbatim as
 * `API Error: 503 [claude/claude-opus-5] [429]: {"type":"error","error":{"type":"rate_limit_error",
 * "message":"This request would exceed your (reset after 2m 41s)…` (anton-fmlb — three consecutive
 * RESUMEs in ~60s against a wall that never moved). The bare `429` in that envelope otherwise
 * matches `TRANSIENT_STDERR_RE` (driver-exit.ts) and gets treated as a passing network blip instead
 * of a quota that needs a real cooloff — quota classification must catch it first.
 *
 * Two machine-only shapes, neither one a model would casually reproduce in prose: the JSON
 * `"type":"rate_limit_error"` field a provider's error body carries, and a bracketed `[429]` status
 * code the way Claude Code's own API-error wrapper and gateways render it — as opposed to a bare
 * "429" typed inline, which stays ambiguous enough to leave alone. They still use the same result
 * whole-envelope guard as the billing error because model prose can quote either shape verbatim.
 */
const RATE_LIMIT_RE = /"type"\s*:\s*"rate_limit_error"|\[429\]/i;
const RATE_LIMIT_RESULT_RE =
  /^[ \t]*API Error:\s*\d{3}\s+\[[^\]]+\]\s+\[429\]:\s*[^\n]*\S[ \t]*\n?$/i;

/**
 * The session-limit banner — observed verbatim as `You've hit your session limit · resets 9pm
 * (America/New_York)` (anton-2gsj, from three consecutive parked runs in anton.db). Like the
 * monthly spend-limit sentence above, this is ordinary English a model could reproduce while
 * describing its own failure, so it gets the same authorship-scoped treatment rather than the
 * terse banners' free rein: loosely on stderr (Claude Code's own channel), and on the result field
 * only end-anchored via `SESSION_LIMIT_RESULT_RE` so the banner must be the WHOLE result. Never
 * scanned in the model-authored transcript.
 */
const SESSION_LIMIT_RE = /^\s*you['’]ve hit your session limit\b[\s\S]{0,40}?resets?\s+[^\n]*?\([^)]+\)/im;

/** Result-field variant limited to Claude Code's standalone session-limit banner. */
const SESSION_LIMIT_RESULT_RE =
  /^\s*you['’]ve hit your session limit\s*·\s*resets?\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*\([^)]+\)\s*$/i;

/**
 * The out-of-usage-credits banner — observed verbatim as `You're out of usage credits. Switch to
 * another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to
 * continue.` (anton-2gsj, from parked review-fix jobs in anton.db). Same reasoning and same
 * authorship-scoped guard as `SESSION_LIMIT_RE`.
 */
const USAGE_CREDITS_RE = /^\s*you['’]re out of usage credits\b[\s\S]{0,120}?claude\.ai\/settings\/usage/im;

/** Result-field variant limited to Claude Code's standalone usage-credits banner. */
const USAGE_CREDITS_RESULT_RE =
  /^\s*you['’]re out of usage credits\.\s*Switch to another model, or manage usage credits at claude\.ai\/settings\/usage\?from=cc_cli_limit_message, to continue\.\s*$/i;

/** Claude's machine-readable reset stamp, trailing a banner: `…usage limit reached|1700000000`. */
const RESET_EPOCH_RE = /\|\s*(\d{10,13})\s*$/m;
/** Prose form: "resets at <when>" — anything up to the next line break or clause separator. */
const RESET_AT_RE = /reset(?:s)?\s+at\s+([^\n,;]+)/i;
/**
 * Clock-time prose with an explicit zone: "resets 9pm (America/New_York)" — no "at", the hour is
 * 12-hour with am/pm, and the IANA zone trails in parens (anton-fjw3). Distinct from `RESET_AT_RE`,
 * which requires the literal "at" and an already-absolute (ISO) value.
 */
const RESET_TZ_RE = /reset(?:s)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;
/**
 * Relative-duration prose: "(reset after 2m 41s)" — any subset of h/m/s components, all optional
 * individually but at least one must be present (anton-fjw3). The trailing `(?!\s*[a-zA-Z0-9])`
 * end-bounds the duration: without it the pattern matches its own valid prefix inside malformed
 * text — "2minutes" (digit run followed by more letters), "2m junk" (a trailing word), "2m 41sx"
 * (a stray suffix on the last unit) — and hands back a resetAt for text that never was one. The
 * lookahead forces whatever follows the matched units (after any whitespace) to be a non-word
 * character or the end of string, so those malformed cases fail to match at all and
 * `relativeResetSeconds` falls through to `undefined` for the runner's own cooloff.
 */
const RESET_RELATIVE_RE =
  /reset(?:s)?\s+after\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?(?!\s*[a-zA-Z0-9])/i;
/** Last resort: any ISO-8601 timestamp anywhere in the notice. */
const RESET_ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/;

function epochSeconds(text: string): number | undefined {
  const match = text.match(RESET_EPOCH_RE);
  if (!match) return undefined;
  const n = Number(match[1]);
  // Normalize millisecond epochs down to seconds.
  return n > 1e12 ? Math.floor(n / 1000) : n;
}

/** A parseable date string as unix seconds; undefined for an absent or unparseable one. */
function dateSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value.trim());
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

/** now + "Xh Ym Zs" (any subset), or undefined when none of the three units matched. */
function relativeResetSeconds(text: string, nowMs: number): number | undefined {
  const match = text.match(RESET_RELATIVE_RE);
  if (!match) return undefined;
  const [, h, m, s] = match;
  if (!h && !m && !s) return undefined;
  const totalSeconds = Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
  if (totalSeconds <= 0) return undefined;
  return Math.floor(nowMs / 1000) + totalSeconds;
}

/**
 * A wall-clock time in `timeZone` as a UTC epoch (ms). Recalculate the offset from the candidate
 * instant until formatting it produces the requested wall time: a naive UTC guess can land before
 * a DST transition even when the requested wall time is after it.
 */
function zonedWallTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const wallTimeUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  let candidateUtc = wallTimeUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = formatter.formatToParts(new Date(candidateUtc));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const formattedWallTimeUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    const adjustedUtc = wallTimeUtc - (formattedWallTimeUtc - candidateUtc);
    if (adjustedUtc === candidateUtc) return adjustedUtc;
    candidateUtc = adjustedUtc;
  }
  return candidateUtc;
}

/**
 * The next occurrence (from `nowMs`) of a bare clock time in an explicit zone — "resets 9pm
 * (America/New_York)" — rolled to tomorrow when that time has already passed today in that zone.
 * Undefined on no match or an invalid IANA zone (`Intl` throws `RangeError`).
 */
function tzResetSeconds(text: string, nowMs: number): number | undefined {
  const match = text.match(RESET_TZ_RE);
  if (!match) return undefined;
  const [, hourStr, minuteStr, ampm, timeZone] = match;
  const clockHour = Number(hourStr);
  const minute = minuteStr ? Number(minuteStr) : 0;
  if (clockHour < 1 || clockHour > 12 || minute < 0 || minute > 59) return undefined;
  let hour = clockHour % 12;
  if (ampm.toLowerCase() === "pm") hour += 12;
  try {
    const todayParts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(nowMs));
    const get = (type: string) => Number(todayParts.find((p) => p.type === type)?.value ?? 0);
    const year = get("year");
    const month = get("month");
    const day = get("day");
    let candidateMs = zonedWallTimeToUtcMs(year, month, day, hour, minute, timeZone);
    if (candidateMs <= nowMs) candidateMs = zonedWallTimeToUtcMs(year, month, day + 1, hour, minute, timeZone);
    return Math.floor(candidateMs / 1000);
  } catch {
    return undefined;
  }
}

/**
 * Best-effort extraction of a reset time (unix seconds) from claude's usage-limit text. `nowMs`
 * anchors the relative ("reset after …") and zoned-clock-time ("resets 9pm (…)") forms — callers
 * pass a fixed clock in tests so assertions never race wall time (anton-fjw3); production callers
 * rely on the `Date.now()` default.
 */
export function parseResetAt(text: string | undefined, nowMs: number = Date.now()): number | undefined {
  if (!text) return undefined;
  return (
    epochSeconds(text) ??
    dateSeconds(text.match(RESET_AT_RE)?.[1]) ??
    relativeResetSeconds(text, nowMs) ??
    tzResetSeconds(text, nowMs) ??
    dateSeconds(text.match(RESET_ISO_RE)?.[0])
  );
}

/** The text the terse banners are scanned across — and the text `resetAt` is parsed out of. */
function combinedText(channels: ClaudeChannels): string {
  return `${channels.transcript}\n${channels.resultText}\n${channels.stderr}`;
}

/**
 * Terse machine banners are trusted across the full transcript (assistant + result + stderr) — the
 * result field alone isn't a reliable place to find them. The monthly spend-limit, session-limit,
 * usage-credits, and API-error sentences are model-reproducible, so none are scanned in the
 * assistant transcript. Their remaining channels are matched with strictness suited to authorship:
 * stderr (Claude Code's own) loosely, and the model-authored result field only when the notice is
 * the WHOLE result.
 */
function isUsageLimited(channels: ClaudeChannels): boolean {
  return (
    USAGE_LIMIT_RE.test(combinedText(channels)) ||
    SPEND_LIMIT_RE.test(channels.stderr) ||
    SPEND_LIMIT_RESULT_RE.test(channels.resultText) ||
    GATEWAY_BILLING_RE.test(channels.stderr) ||
    GATEWAY_BILLING_RESULT_RE.test(channels.resultText) ||
    RATE_LIMIT_RE.test(channels.stderr) ||
    RATE_LIMIT_RESULT_RE.test(channels.resultText) ||
    SESSION_LIMIT_RE.test(channels.stderr) ||
    SESSION_LIMIT_RESULT_RE.test(channels.resultText) ||
    USAGE_CREDITS_RE.test(channels.stderr) ||
    USAGE_CREDITS_RESULT_RE.test(channels.resultText)
  );
}

/**
 * The `UsageLimitError` a failed run's channels justify, or null when no quota signal is present.
 * Call this ONLY for a run that did not cleanly succeed: a healthy run whose assistant output
 * merely *mentions* a usage limit (an agent editing this very file) must never be reclassified and
 * rescheduled forever (anton-ner.2).
 */
export function usageLimitError(channels: ClaudeChannels): UsageLimitError | null {
  if (!isUsageLimited(channels)) return null;
  const message =
    channels.resultText ||
    channels.stderr.trim() ||
    channels.transcript.trim() ||
    "Claude AI usage limit reached";
  return new UsageLimitError(message, parseResetAt(combinedText(channels)));
}
