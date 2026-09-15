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
 * The passive "is/are discarded/lost/dropped", "lost/dropped after/when", and "silently drops"
 * phrasings say nothing about loss *of work* on their own — "the first character is dropped when parsing", "the
 * diagnostic context is lost after wrapping the error", or "the logger silently drops duplicate metric
 * labels" all match the words without describing a work-loss regression. They only count when a
 * work-bearing noun (job, task, queue, ...) or a retry/requeue signal is the verb's actual subject or
 * object — adjacent with no clause boundary in between — not merely mentioned nearby: "while parsing a
 * request, the first character is dropped" has "request" in an earlier, unrelated clause.
 */
const WORK_LOSS_SUBJECT =
  "(?:job|task|queue|batch|record|item|request|message|event|payload|entry|entries|submission|update)s?";
const WORK_LOSS_RETRY =
  "(?:retry|retried|retries|requeue|requeued|re-?queue|re-?queued|redeliver|redelivered|reprocess|reprocessed)";
const WORK_LOSS_SIGNAL = `(?:${WORK_LOSS_SUBJECT}|${WORK_LOSS_RETRY})`;
// No comma/semicolon/colon/dash/period/apostrophe in the gap, so a noun from an earlier clause —
// or a possessive that hands the subject role to whatever follows it ("the request body's first
// character is dropped") — can't be credited as this loss's subject. The colon matters the same
// way a comma does: "For each request: the first character is dropped" introduces a new clause
// after the colon, so "request" can't bind across it to "is dropped".
const CLAUSE_GAP = "[^,;:.'\\u2019\\u2013\\u2014]{0,30}?";
// Bare "data loss" says nothing about lost *work* on its own — "casting this bigint to number
// causes data loss for large IDs" is a numeric-precision bug, not a dropped job/queue entry. It
// only counts when a work-bearing noun (WORK_LOSS_SUBJECT) or "error(s)" shares the same clause —
// the same CLAUSE_GAP exclusions as the other contextual loss matchers, so "causes data loss; the
// job status remains correct" doesn't credit "job" across the semicolon.
const DATA_LOSS_CONTEXT = new RegExp(
  `\\bdata loss\\b${CLAUSE_GAP}\\b(?:${WORK_LOSS_SUBJECT}|errors?)\\b|\\b(?:${WORK_LOSS_SUBJECT}|errors?)\\b${CLAUSE_GAP}\\bdata loss\\b`,
  "i",
);
const WORK_LOSS_VERB_AFTER =
  "(?:(?:is|are) (?:silently )?(?:discarded|lost|dropped)|(?:lost|dropped) (?:after|when))";
const WORK_LOSS_OBJECT_AFTER = "(?:(?:is|are) (?:silently )?(?:discarded|lost|dropped)|silently drops?)";
const WORK_LOSS_SUBJECT_FIRST = new RegExp(`\\b${WORK_LOSS_SIGNAL}\\b${CLAUSE_GAP}\\b${WORK_LOSS_VERB_AFTER}\\b`, "gi");
// The gap is captured so matchesWorkLossVerbFirst can reject it below when the noun belongs to an
// intervening clause rather than to this verb.
const WORK_LOSS_VERB_FIRST = new RegExp(`\\b${WORK_LOSS_OBJECT_AFTER}\\b(${CLAUSE_GAP})\\b${WORK_LOSS_SIGNAL}\\b`, "gi");
// A noun right after a preposition ("for each request", "in every batch") is that preposition's
// object, not the loss verb's subject: "For each request the first character is dropped" must not
// credit "request" as the lost value just because no punctuation sits between them. Tested against
// the text immediately preceding the candidate subject.
const WORK_LOSS_PREPOSITIONAL_OBJECT =
  /\b(?:for|per|in|during|within|throughout|across|among|about|regarding|concerning|via|of|with|without|to|from|into|onto|upon)\s+(?:each|every|any|all|both|no|another|some|one|this|that|these|those|a|an|the|our|their|its|his|her|my|your)?\s*$/i;
// A gerund between the loss verb and the candidate noun ("is dropped when parsing a request") means
// the noun is that gerund's object, not the lost value — the lost value there is "the first
// character", not "a request". Reject any gap containing one rather than crediting the noun to the
// loss verb just because no clause-breaking punctuation sits between them.
const WORK_LOSS_INTERVENING_GERUND = /\b\w+ing\b/i;

function matchesWorkLossPassive(note: string): boolean {
  // A manual exec loop, not matchAll: a rejected match ("For each request the queued job is
  // lost") consumes all the way through the verb, swallowing "job" inside its span. matchAll
  // would resume after that whole span and never give "job" its own chance to match, so on
  // rejection we resume scanning from just past the rejected subject instead.
  WORK_LOSS_SUBJECT_FIRST.lastIndex = 0;
  let subjectMatch: RegExpExecArray | null;
  while ((subjectMatch = WORK_LOSS_SUBJECT_FIRST.exec(note))) {
    const index = subjectMatch.index;
    const precedingText = note.slice(Math.max(0, index - 40), index);
    if (!WORK_LOSS_PREPOSITIONAL_OBJECT.test(precedingText)) return true;
    WORK_LOSS_SUBJECT_FIRST.lastIndex = index + 1;
  }
  for (const match of note.matchAll(WORK_LOSS_VERB_FIRST)) {
    const gap = match[1] ?? "";
    if (!WORK_LOSS_INTERVENING_GERUND.test(gap)) return true;
  }
  return false;
}

// Active "loses"/"lose", "drops"/"drop", and "discards"/"discard" count the same as the passive
// forms above, but only when the work-bearing noun is the verb's actual direct object, not just
// some later noun the arbitrary CLAUSE_GAP happened to reach: "drops support for queue items" and
// "discards a field from the request" both have a real (non-work) object — "support", "a field" —
// between the verb and the work noun, so the work noun there is a prepositional object, not what
// got dropped. The gap only allows a short run of determiners/adjectives right after the verb, so
// an intervening noun or preposition breaks the match instead of being skipped over.
const WORK_LOSS_DIRECT_OBJECT_DETERMINER =
  "(?:the|a|an|this|that|these|those|our|their|its|his|her|my|your|queued|pending|in-?flight|unacked|unprocessed|failed|new|old)";
const WORK_LOSS_ACTIVE = new RegExp(
  `\\b(?:loses?|drops?|discards?)\\b(?:\\s+${WORK_LOSS_DIRECT_OBJECT_DETERMINER}){0,3}\\s+\\b(?:work|${WORK_LOSS_SIGNAL})\\b`,
  "i",
);

// Bare "unhandled rejection" says nothing about lost *work* on its own — "this unhandled rejection
// causes the endpoint to return 500 instead of the validation response" is a wrong-status-code bug,
// not a dropped job. It only counts when a work-bearing noun or retry/requeue signal
// (WORK_LOSS_SIGNAL) shares the same ~60-char window, the same gating the other loss matchers apply.
const UNHANDLED_REJECTION = /\bunhandled rejections?\b/gi;
const WORK_LOSS_SIGNAL_RE = new RegExp(`\\b${WORK_LOSS_SIGNAL}\\b`, "i");

function matchesUnhandledRejection(note: string): boolean {
  for (const match of note.matchAll(UNHANDLED_REJECTION)) {
    const start = Math.max(0, match.index - 60);
    const end = Math.min(note.length, match.index + match[0].length + 60);
    if (WORK_LOSS_SIGNAL_RE.test(note.slice(start, end))) return true;
  }
  return false;
}

function matchesWorkLoss(note: string): boolean {
  return (
    /work.?loss|never retried|work is lost/i.test(note) ||
    matchesUnhandledRejection(note) ||
    DATA_LOSS_CONTEXT.test(note) ||
    WORK_LOSS_ACTIVE.test(note) ||
    matchesWorkLossPassive(note)
  );
}

// Every other fencing/TOCTOU alternative already carries its own ownership/lease/lock context in
// its wording; only the bare fenc(e/ing/ed) word doesn't — see matchesFencingToctou below.
const FENCING_BARE = /\b(?:un)?fenc(?:e|ing|ed)\b/gi;
const FENCING_OWNERSHIP_CONTEXT =
  /\b(?:lease|lock|claim|ownership|owner|worker|concurrent(?:ly)?|races?|racing|guard|marker|token|acquir\w*|hold(?:ing|s)?)\b/i;
const FENCING_REST =
  /\btoctou\b|time-of-check|time of check|race condition|races? with|check-then-act|check then act|fencing token|without (?:holding|acquiring) the lock|between the check and|stale (?:lease|read)|concurrent(?:ly)? (?:writ|modif|updat)|re-?reads? .{0,60}?before|reassert(?:s|ed|ing)? (?:the )?(?:claim|lock|lease|marker|ownership)|retired claim|final (?:fenc(?:e|ing)|lock|lease|claim|token|marker|ownership|guard)\s+await|lease (?:can |could |may |might |will )?expir(?:e|es|ed|ing)|expir(?:e|es|ed|ing) .{0,60}?(?:lease|ownership|claim)|ownership (?:may |could |can |might |will )?(?:transfer|change|shift|reassign)/i;

/**
 * The bare "fenc(e/ing/ed)" word is as much Markdown vocabulary ("the example is unfenced, so it
 * renders as code") as it is an ownership-race term ("read without a fence"), so on its own it
 * only counts when a lease/lock/claim/ownership/concurrency word appears within 60 chars of it —
 * otherwise the next review round gets sent hunting for a race that was never reported. A note can
 * carry more than one bare occurrence (an unrelated Markdown mention followed by the real one), so
 * every occurrence is checked rather than stopping at the first.
 */
function matchesFencingToctou(note: string): boolean {
  if (FENCING_REST.test(note)) return true;
  for (const bareMatch of note.matchAll(FENCING_BARE)) {
    const start = Math.max(0, bareMatch.index - 60);
    const end = Math.min(note.length, bareMatch.index + bareMatch[0].length + 60);
    if (FENCING_OWNERSHIP_CONTEXT.test(note.slice(start, end))) return true;
  }
  return false;
}

/**
 * Ordered most-distinctive-first, and checked in this order: a note can plausibly use words from more
 * than one class ("the abort leaves a stale lock held"), so the first pattern that matches wins rather
 * than every match being weighed. Fencing/TOCTOU goes first as the audit's largest and highest-P1
 * class — the one a coarse taxonomy most needs to not misfile as something vaguer.
 */
// Bare "cancel(s/ling/led/lation)" is as much ordinary prose ("this migration cancels the effect of
// PR #200", "the transaction was canceled by the database after a constraint failure", "no way to
// cancel the upload") as it is the cancellation-after-await race this class means to summarise — none
// of those describe an await/signal race. So, like the bare `fenc(e/ing/ed)` word above, it only
// counts when await/signal/request/run/caller-cancellation context appears within 60 chars — the
// other alternatives below already carry that context in their own wording (abort-signal mentions,
// "after the abort", an await adjacent to abort/aborted) and don't need the gate.
const CANCEL_BARE = /\bcancell?(?:ations?|ing|ed|s)?\b/gi;
const CANCEL_CONTEXT = /\b(?:awaits?|awaited|awaiting|signal|abortsignal|abortcontroller|requests?|caller|run|mid-?flight|in-?flight)\b/i;
const CANCEL_REST =
  /\bsignal\.aborted\b|abort[- ]?signal|abortcontroller|after (?:the )?abort|ignores? the abort|continues? (?:after|when) (?:the )?(?:cancel|abort|signal)|orphaned (?:request|task|job)|\babort(?:s|ing)\b[^.]{0,40}\bawait\b|\bawait\b[^.]{0,40}\babort(?:s|ing)\b|\baborted\b[^.]{0,40}\bawait\b|\bawait\b[^.]{0,40}\baborted\b/i;

function matchesCancellation(note: string): boolean {
  if (CANCEL_REST.test(note)) return true;
  for (const match of note.matchAll(CANCEL_BARE)) {
    const start = Math.max(0, match.index - 60);
    const end = Math.min(note.length, match.index + match[0].length + 60);
    if (CANCEL_CONTEXT.test(note.slice(start, end))) return true;
  }
  return false;
}

const PATTERNS: Array<{ klass: Exclude<FindingClass, "other">; pattern: Matcher }> = [
  {
    klass: "fencing-toctou",
    pattern: matchesFencingToctou,
  },
  {
    klass: "cancellation",
    pattern: matchesCancellation,
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
