/**
 * Machine-readable outcome signal (anton-j5i8). The base system prompt asks the agent to end its
 * final message with exactly one line — `ANTON-RESULT: delivered`, `ANTON-RESULT: blocked — <reason>`,
 * or `ANTON-RESULT: needs-human — <ask>` — so the harness has an honest, parseable statement of what
 * the agent believes it did. execute-epic parses this and cross-checks it against commit evidence
 * (the delivery-evidence gate). The self-report only ever CORROBORATES that gate: a missing/unparseable
 * line falls back to commit evidence alone, and a run is never failed on the self-report without
 * commit evidence.
 *
 * `needs-human` is distinct from `blocked`: the work stopped because only a person can take the next
 * step (a credential, an account, a dashboard click, a judgement call), not because the agent hit a
 * broken state.
 */

export type AntonOutcome = "delivered" | "blocked" | "needs-human";

export interface AntonResult {
  outcome: AntonOutcome;
  /**
   * The agent's stated reason (`blocked`) or ask (`needs-human`); undefined for `delivered` and when
   * the agent gave none.
   */
  reason?: string;
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
    result = outcome === "delivered" ? { outcome } : { outcome, reason: reason || undefined };
  }
  return result;
}

/** Human-readable rendering for the session log / block notes. */
export function formatAntonResult(result: AntonResult | null): string {
  if (!result) return "(no ANTON-RESULT line — falling back to commit-evidence gate)";
  switch (result.outcome) {
    case "blocked":
      return `blocked — ${result.reason ?? "(no reason given)"}`;
    case "needs-human":
      return `needs-human — ${result.reason ?? "(no ask given)"}`;
    default:
      return "delivered";
  }
}
