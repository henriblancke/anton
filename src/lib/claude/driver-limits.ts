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

/** Claude's machine-readable reset stamp, trailing a banner: `…usage limit reached|1700000000`. */
const RESET_EPOCH_RE = /\|\s*(\d{10,13})\s*$/m;
/** Prose form: "resets at <when>" — anything up to the next line break or clause separator. */
const RESET_AT_RE = /reset(?:s)?\s+at\s+([^\n,;]+)/i;
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

/** Best-effort extraction of a reset time (unix seconds) from claude's usage-limit text. */
export function parseResetAt(text: string | undefined): number | undefined {
  if (!text) return undefined;
  return (
    epochSeconds(text) ??
    dateSeconds(text.match(RESET_AT_RE)?.[1]) ??
    dateSeconds(text.match(RESET_ISO_RE)?.[0])
  );
}

/** The text the terse banners are scanned across — and the text `resetAt` is parsed out of. */
function combinedText(channels: ClaudeChannels): string {
  return `${channels.transcript}\n${channels.resultText}\n${channels.stderr}`;
}

/**
 * Terse machine banners are trusted across the full transcript (assistant + result + stderr) — the
 * result field alone isn't a reliable place to find them. The monthly spend-limit sentence is
 * model-reproducible prose, so it is never scanned in the assistant transcript, and its two
 * remaining channels are matched with strictness suited to their authorship: stderr (Claude Code's
 * own) loosely, the model-authored result field only when the banner is the WHOLE result.
 */
function isUsageLimited(channels: ClaudeChannels): boolean {
  return (
    USAGE_LIMIT_RE.test(combinedText(channels)) ||
    SPEND_LIMIT_RE.test(channels.stderr) ||
    SPEND_LIMIT_RESULT_RE.test(channels.resultText)
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
