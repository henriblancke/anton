/**
 * Machine-readable outcome signal (anton-j5i8). The base system prompt asks the agent to end its
 * final message with exactly one line — `ANTON-RESULT: delivered`,
 * `ANTON-RESULT: blocked — <class> — <reason>`, or `ANTON-RESULT: needs-human — <ask>` — so the
 * harness has an honest, parseable statement of what the agent believes it did. execute-epic parses
 * this and cross-checks it against commit evidence (the delivery-evidence gate). The self-report
 * only ever CORROBORATES that gate: a missing/unparseable line falls back to commit evidence alone,
 * and a run is never failed on the self-report without commit evidence.
 *
 * `needs-human` is distinct from `blocked`: the work stopped because only a person can take the next
 * step (a credential, an account, a dashboard click, a judgement call), not because the agent hit a
 * broken state.
 */

export type AntonOutcome = "delivered" | "blocked" | "needs-human";

/**
 * Why a run stopped, in a form anton can switch on (anton-ie05 / R5.1) — the closed enum the base
 * prompt asks a blocked agent to name. `gardener/repair.ts` repairs a SUBSET of these
 * (`REPAIR_CLASSES`); `env` and `other` are here to be named honestly, not to be acted on.
 *
 * The two enums are deliberately independent: both directions of drift fail closed, because a class
 * one side does not recognise escalates rather than repairs.
 */
export const BLOCK_CLASSES = [
  "ref-stale",
  "dep-missing",
  "acceptance-missing",
  "oversized",
  "env",
  "other",
] as const;

export type BlockClass = (typeof BLOCK_CLASSES)[number];

/** EXACT, case-sensitive membership — see {@link CLASSIFIED_REASON_RE} for why nothing looser. */
export function isBlockClass(value: string | undefined): value is BlockClass {
  return value !== undefined && (BLOCK_CLASSES as readonly string[]).includes(value);
}

export interface AntonResult {
  outcome: AntonOutcome;
  /**
   * The agent's stated reason (`blocked`) or ask (`needs-human`); undefined for `delivered` and when
   * the agent gave none.
   */
  reason?: string;
  /**
   * Why it blocked, for `blocked` only. `other` is both "the agent said `other`" and "the agent
   * classified nothing" — the two are indistinguishable on the wire and mean the same thing to every
   * caller: nothing anton can act on, so it escalates (R5.2).
   */
  klass?: BlockClass;
}

/**
 * One `ANTON-RESULT:` line. The outcome word is required; a reason may follow after a separator
 * (em/en dash, hyphen, or colon) or plain whitespace. Case-insensitive so a stray capitalization
 * still parses. Anchored to the (trimmed) start of a line so a mention buried mid-sentence in the
 * agent's prose never matches.
 */
const RESULT_LINE_RE =
  /^ANTON-RESULT:\s*(delivered|blocked|needs-human)\b[ \t]*(?:[—–:-][ \t]*)?(.*)$/i;

/**
 * A blocked reason that LEADS with a class token: `<token>` alone, or `<token> — <prose>`.
 *
 * Two deliberate tightenings, because a fleet mid-rollout emits the classified and the legacy format
 * at once and guessing between them runs the wrong repair on a bead nobody classified:
 *
 *   • The token is matched, then tested for EXACT membership. No prefix, substring, or
 *     case-insensitive match — `ref …` and `REF-STALE …` are prose, not the `ref-stale` class.
 *   • The separator must be preceded by whitespace, so a hyphenated word can never be split at its
 *     own hyphen: `dep-missing-thing — x` yields the token `dep-missing-thing`, not `dep-missing`.
 *
 * Anything that fails either test keeps its text whole and lands in `other`.
 */
const CLASSIFIED_REASON_RE = /^([a-z-]+)(?:[ \t]+[—–:-][ \t]*(.*))?$/;

/** Split a blocked reason into its class and prose, defaulting to `other` with the text untouched. */
function classifyBlock(reason: string | undefined): { klass: BlockClass; reason?: string } {
  const m = reason ? CLASSIFIED_REASON_RE.exec(reason) : null;
  if (!m || !isBlockClass(m[1])) return { klass: "other", reason: reason || undefined };
  return { klass: m[1], reason: m[2]?.trim() || undefined };
}

/**
 * Extract the agent's self-reported outcome from the claude result text. Returns the LAST matching
 * `ANTON-RESULT:` line (the agent is asked to emit it as its final line; the last one wins if it
 * corrected itself), or `null` when no line parses — the caller then falls back to the
 * commit-evidence gate alone.
 */
export function parseAntonResult(text: string | null | undefined): AntonResult | null {
  if (!text) return null;
  let result: AntonResult | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const m = RESULT_LINE_RE.exec(rawLine.trim());
    if (!m) continue;
    const outcome = m[1].toLowerCase() as AntonOutcome;
    const reason = m[2]?.trim();
    if (outcome === "delivered") result = { outcome };
    else if (outcome === "blocked") result = { outcome, ...classifyBlock(reason) };
    else result = { outcome, reason: reason || undefined };
  }
  return result;
}

/** Human-readable rendering for the session log / block notes. */
export function formatAntonResult(result: AntonResult | null): string {
  if (!result) return "(no ANTON-RESULT line — falling back to commit-evidence gate)";
  switch (result.outcome) {
    case "blocked": {
      // `other` carries no information a reader does not already have from the prose.
      const klass = result.klass && result.klass !== "other" ? `${result.klass} — ` : "";
      return `blocked — ${klass}${result.reason ?? "(no reason given)"}`;
    }
    case "needs-human":
      return `needs-human — ${result.reason ?? "(no ask given)"}`;
    default:
      return "delivered";
  }
}
