/**
 * A stable class label for a {@link ReviewFinding} (anton-oqzc), derived from the finding's own note
 * text — never from a model call. Lets an earlier round's findings be summarised to the next round
 * by class ("2 fencing/TOCTOU findings last round") without forwarding the verdicts themselves.
 *
 * Class frequencies come from an audit of the last 40 anton-spawned PRs (703 external findings from
 * chatgpt-codex-connector + claude bots across 4 repos): fencing/TOCTOU 119 (68 P1),
 * work-loss-on-error-path 59 (14 P1), scope/over-broad-match 38 (9 P1), fail-open 22 (15 P1),
 * cancellation-after-await 20 (13 P1). Those five plus a catch-all are the whole taxonomy — coarse on
 * purpose, since a class nobody maintains is worse than none.
 */
import type { ReviewFinding } from "./review-context";

export type FindingClass = "fencing-toctou" | "cancellation" | "fail-open" | "work-loss" | "scope" | "other";

/**
 * Ordered most-distinctive-first, and checked in this order: a note can plausibly use words from more
 * than one class ("the abort leaves a stale lock held"), so the first pattern that matches wins rather
 * than every match being weighed. Fencing/TOCTOU goes first as the audit's largest and highest-P1
 * class — the one a coarse taxonomy most needs to not misfile as something vaguer.
 */
const PATTERNS: Array<{ klass: Exclude<FindingClass, "other">; pattern: RegExp }> = [
  {
    klass: "fencing-toctou",
    pattern:
      /\btoctou\b|time-of-check|time of check|race condition|races? with|check-then-act|check then act|\bfenc(e|ing|ed)\b|fencing token|without (?:holding|acquiring) the lock|between the check and|stale (?:lease|read)|concurrent(?:ly)? (?:writ|modif|updat)/i,
  },
  {
    klass: "cancellation",
    pattern:
      /cancell?ation|\bcancell?ed\b|abortsignal|abortcontroller|after (?:the )?abort|ignores? the abort|continues? after (?:the )?(?:cancel|abort)|orphaned (?:request|task|job)/i,
  },
  {
    klass: "fail-open",
    pattern:
      /fails? open|fail-open|defaults? to (?:allow|permit)|silently allow|treats? (?:an? )?error as (?:success|ok|allowed)|swallows? the error and (?:continues|proceeds)|permissive fallback/i,
  },
  {
    klass: "work-loss",
    pattern:
      /work.?loss|loses? (?:the )?work|(?:on the|in the) error path|silently drops?|is (?:silently )?discarded|never retried|unhandled rejection|catch block swallows|work is lost|data loss/i,
  },
  {
    klass: "scope",
    pattern:
      /over-?broad|too broad|scope creep|matches too (?:broadly|much)|too permissive (?:glob|regex|match|pattern)|unintended (?:match|files|scope)|wildcard matches more than/i,
  },
];

/**
 * Maps a finding to its class by matching the note text against the patterns above — no model call,
 * no network, and no way to throw: a note that matches nothing (or none at all) is `"other"`, the
 * single catch-all, rather than being dropped from the summary.
 */
export function classifyFindingClass(finding: ReviewFinding): FindingClass {
  const note = finding.note;
  for (const { klass, pattern } of PATTERNS) {
    if (pattern.test(note)) return klass;
  }
  return "other";
}
