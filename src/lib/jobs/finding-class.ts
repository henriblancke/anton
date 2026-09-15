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

type Matcher = RegExp | ((note: string) => boolean);

/**
 * The passive "is discarded/lost/dropped" and "lost/dropped after/when" phrasings say nothing about
 * loss *of work* on their own — "the first character is dropped when parsing" or "the diagnostic
 * context is lost after wrapping the error" match the words without describing a work-loss regression.
 * They only count when a work-bearing noun (job, task, queue, ...) or a retry/requeue signal appears
 * within a short window of the match.
 */
const WORK_LOSS_PASSIVE = /is (?:silently )?(?:discarded|lost|dropped)|(?:lost|dropped) (?:after|when)/gi;
const WORK_SUBJECT =
  /\b(?:job|task|queue|batch|record|item|request|message|event|payload|entry|entries|submission|update)s?\b/i;
const RETRY_SIGNAL = /\b(?:retry|retried|retries|requeue|requeued|re-?queue|re-?queued|redeliver|redelivered|reprocess|reprocessed)\b/i;
const WORK_LOSS_CONTEXT_WINDOW = 60;

function matchesWorkLossPassive(note: string): boolean {
  WORK_LOSS_PASSIVE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORK_LOSS_PASSIVE.exec(note))) {
    const start = Math.max(0, match.index - WORK_LOSS_CONTEXT_WINDOW);
    const end = Math.min(note.length, match.index + match[0].length + WORK_LOSS_CONTEXT_WINDOW);
    const context = note.slice(start, end);
    if (WORK_SUBJECT.test(context) || RETRY_SIGNAL.test(context)) return true;
  }
  return false;
}

function matchesWorkLoss(note: string): boolean {
  return (
    /work.?loss|loses? (?:the )?work|silently drops?|never retried|unhandled rejection|work is lost|data loss/i.test(
      note,
    ) || matchesWorkLossPassive(note)
  );
}

/**
 * Ordered most-distinctive-first, and checked in this order: a note can plausibly use words from more
 * than one class ("the abort leaves a stale lock held"), so the first pattern that matches wins rather
 * than every match being weighed. Fencing/TOCTOU goes first as the audit's largest and highest-P1
 * class — the one a coarse taxonomy most needs to not misfile as something vaguer.
 */
const PATTERNS: Array<{ klass: Exclude<FindingClass, "other">; pattern: Matcher }> = [
  {
    klass: "fencing-toctou",
    pattern:
      /\btoctou\b|time-of-check|time of check|race condition|races? with|check-then-act|check then act|\b(?:un)?fenc(?:e|ing|ed)\b|fencing token|without (?:holding|acquiring) the lock|between the check and|stale (?:lease|read)|concurrent(?:ly)? (?:writ|modif|updat)|re-?reads? .{0,60}?before|reassert(?:s|ed|ing)? (?:the )?(?:claim|lock|lease|marker|ownership)|retired claim|final (?:fenc(?:e|ing)|lock|lease|claim|token|marker|ownership|guard)\s+await|lease (?:can |could |may |might |will )?expir(?:e|es|ed|ing)|expir(?:e|es|ed|ing) .{0,60}?(?:lease|ownership|claim)|ownership (?:may |could |can |might |will )?(?:transfer|change|shift|reassign)/i,
  },
  {
    klass: "cancellation",
    pattern:
      /cancell?ation|\bcancell?ed\b|\baborted\b|abort[- ]?signal|abortcontroller|after (?:the )?abort|ignores? the abort|continues? (?:after|when) (?:the )?(?:cancel|abort|signal)|orphaned (?:request|task|job)/i,
  },
  {
    klass: "fail-open",
    pattern:
      /fails? open|fail-open|defaults? to (?:allow|permit)|silently allow|treats? (?:an? )?error as (?:success|ok|allowed)|swallows? the error and (?:continues|proceeds)|permissive fallback/i,
  },
  {
    klass: "work-loss",
    // Generic error-path phrasing ("on the error path", "catch block swallows") is deliberately
    // excluded: it says nothing about loss on its own (e.g. "wrong status code on the error path"
    // isn't work-loss), so this only fires on an accompanying loss/drop/retry signal.
    pattern: matchesWorkLoss,
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
    const matched = typeof pattern === "function" ? pattern(note) : pattern.test(note);
    if (matched) return klass;
  }
  return "other";
}
