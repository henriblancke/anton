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
 * The passive "is/are/was/were/has-been/have-been/had-been discarded/lost/dropped",
 * "lost/dropped after/when", and "silently drops" phrasings say nothing about loss *of work* on
 * their own — "the first character is dropped when parsing", "the diagnostic context is lost
 * after wrapping the error", or "the logger silently drops duplicate metric labels" all match the
 * words without describing a work-loss regression. They only count when a work-bearing noun (job,
 * task, queue, ...) or a retry/requeue signal is the verb's actual subject or object — adjacent
 * with no clause boundary in between — not merely mentioned nearby: "while parsing a request, the
 * first character is dropped" has "request" in an earlier, unrelated clause. Past-tense, perfect-
 * passive, modal, and get-passive auxiliaries ("were discarded", "has been discarded", "will be
 * discarded", "can be dropped", "gets discarded", "got dropped") count the same as "is/are" — a
 * finding describing loss that already happened, could/will happen, or is phrased with "gets"/"got"
 * instead of "is"/"was" is still a work-loss finding.
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
// causes data loss for large IDs" is a numeric-precision bug, not a dropped job/queue entry, and
// so is "converting the error code to number causes data loss for large values": a bare "error"
// mention nearby isn't a work-loss signal either, since a numeric-precision or formatting bug can
// happen to sit next to the word "error" without any job, task, or retry ever being lost. It only
// counts when an actual work-bearing noun or retry/requeue signal (WORK_LOSS_SIGNAL) shares the
// same clause — the same CLAUSE_GAP exclusions as the other contextual loss matchers, so "causes
// data loss; the job status remains correct" doesn't credit "job" across the semicolon.
//
// A work-bearing noun immediately followed by another noun ("the job ID", "the record count") is
// that noun's attributive modifier, not the value experiencing the loss — "casting the job ID to
// number causes data loss for large values" corrupts the ID, not the job, and "serializing the
// record count as a float causes data loss" corrupts the count, not the record. So when the
// signal word comes before "data loss", it only counts when the signal sits right before a causal
// verb (mod whitespace) that ties *it* — not some other noun it merely modifies — to the loss.
const WORK_LOSS_CAUSAL_VERB =
  "(?:causes?|caused|causing|results?\\s+in|resulting\\s+in|resulted\\s+in|leads?\\s+to|leading\\s+to|led\\s+to|triggers?|triggering|triggered)";
const DATA_LOSS_CONTEXT = new RegExp(
  `\\bdata loss\\b${CLAUSE_GAP}\\b${WORK_LOSS_SIGNAL}\\b|\\b${WORK_LOSS_SIGNAL}\\b\\s+\\b${WORK_LOSS_CAUSAL_VERB}\\b${CLAUSE_GAP}\\bdata loss\\b`,
  "i",
);
// Modal passive forms ("will be discarded", "can be dropped", "may be lost") describe the same
// loss-on-error-path behavior as the present/past/perfect forms below — a finding phrased as what
// *will* or *can* happen on failure is still reporting work-loss, not a lesser claim.
const WORK_LOSS_PASSIVE_AUX =
  "(?:is|are|was|were|has been|have been|had been|will be|can be|may be|might be|could be|shall be|must be|gets?|got)";
const WORK_LOSS_VERB_AFTER = `(?:${WORK_LOSS_PASSIVE_AUX} (?:silently )?(?:discarded|lost|dropped)|(?:lost|dropped) (?:after|when))`;
const WORK_LOSS_OBJECT_AFTER = `(?:${WORK_LOSS_PASSIVE_AUX} (?:silently )?(?:discarded|lost|dropped)|silently drops?)`;
// Whitespace only, not CLAUSE_GAP: "the record delimiter is dropped" and "the item count is
// lost" both have a WORK_LOSS_SIGNAL word ("record", "item") immediately before another noun
// ("delimiter", "count") that is the subject's real head — the signal word there is an
// attributive modifier, not the thing being lost. Requiring the verb to sit right after the
// signal word (mod whitespace) means a following noun breaks the match instead of the arbitrary
// gap letting it be skipped over, so only "record is dropped"/"job is lost"-shaped subjects bind.
const WORK_LOSS_SUBJECT_FIRST = new RegExp(`\\b${WORK_LOSS_SIGNAL}\\b\\s+\\b${WORK_LOSS_VERB_AFTER}\\b`, "gi");
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
// Quantifiers ("all", "both", "every") sit in the same determiner slot as "the"/"queued"/etc —
// "drops all queued jobs" is exactly as much a direct-object work-loss as "drops the queued job" —
// so they're admitted here rather than via a separate branch.
const WORK_LOSS_DIRECT_OBJECT_DETERMINER =
  "(?:the|a|an|this|that|these|those|our|their|its|his|her|my|your|all|both|every|queued|pending|in-?flight|unacked|unprocessed|failed|new|old)";
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
  /\bsignal\.aborted\b|abort[- ]?signal|abortcontroller|after (?:the )?abort|ignores? the abort|continues? (?:after|when) (?:the )?(?:cancel|abort|signal)|\babort(?:s|ing)\b[^.]{0,40}\bawait\b|\bawait\b[^.]{0,40}\babort(?:s|ing)\b|\baborted\b[^.]{0,40}\bawait\b|\bawait\b[^.]{0,40}\baborted\b/i;
// "orphaned task/job/request" alone describes any leftover row or process, not specifically one
// left behind by a cancellation race — "deleting the parent leaves an orphaned task row in the
// database" is a data-integrity finding, not a cancellation one. It only counts alongside an
// actual await/signal/abort/cancel context, not the broader CANCEL_CONTEXT list above (which
// includes "request" itself and would make the gate vacuous for "orphaned request").
const ORPHANED_WORK = /\borphaned (?:requests?|tasks?|jobs?)\b/gi;
const ORPHANED_CANCEL_CONTEXT =
  /\b(?:awaits?|awaited|awaiting|signal|abortsignal|abortcontroller|cancell?(?:ations?|ing|ed|s)?|abort(?:s|ed|ing)?|mid-?flight|in-?flight)\b/i;

function matchesCancellation(note: string): boolean {
  if (CANCEL_REST.test(note)) return true;
  for (const match of note.matchAll(CANCEL_BARE)) {
    const start = Math.max(0, match.index - 60);
    const end = Math.min(note.length, match.index + match[0].length + 60);
    if (CANCEL_CONTEXT.test(note.slice(start, end))) return true;
  }
  for (const match of note.matchAll(ORPHANED_WORK)) {
    const start = Math.max(0, match.index - 60);
    const end = Math.min(note.length, match.index + match[0].length + 60);
    if (ORPHANED_CANCEL_CONTEXT.test(note.slice(start, end))) return true;
  }
  return false;
}

// "returns true/allowed/granted/authorized/permitted" tied to a throw/fail/error/catch within the
// same sentence is a fail-open finding phrased as returned authorization rather than one of the
// literal "fails open"/"fail-open" formulations below — e.g. "the permission check returns true
// when the database lookup throws" or "the catch returns allowed". Bounded to `[^.]{0,50}?` (not a
// full CLAUSE_GAP) since either order (result-then-cause or cause-then-result) is valid English
// here and both need covering.
const FAIL_OPEN_LITERAL =
  /fails? open|fail-open|defaults? to (?:allow|permit)|silently allow|treats? (?:an? )?error as (?:success|ok|allowed)|swallows? the error and (?:continues|proceeds)|permissive fallback/i;
const FAIL_OPEN_ERROR_WORD = "(?:throws?|thrown|throwing|fails?|failed|failure|errors?|errored|exception|rejects?|rejected|catch(?:es|ing)?)";
// "allowed"/"granted"/"authorized"/"permitted" are themselves authorization-specific — no extra
// context needed. Bare "true" isn't: "the equality helper returns true for unequal inputs, causing
// an error in sorting" ties a boolean return to an error word with no authorization semantics at
// all, so a "returns true ... error" match only counts once an actual permission/access/check word
// (matchesFailOpenTrueResult below) also appears nearby.
const FAIL_OPEN_AUTHORIZED_RESULT_FIRST = new RegExp(
  `returns? (?:allowed|granted|authorized|permitted)[^.]{0,50}?${FAIL_OPEN_ERROR_WORD}`,
  "i",
);
const FAIL_OPEN_AUTHORIZED_RESULT_LAST = new RegExp(
  `${FAIL_OPEN_ERROR_WORD}[^.]{0,50}?returns? (?:allowed|granted|authorized|permitted)`,
  "i",
);
const FAIL_OPEN_TRUE_RESULT_FIRST = new RegExp(`returns? true[^.]{0,50}?${FAIL_OPEN_ERROR_WORD}`, "gi");
const FAIL_OPEN_TRUE_RESULT_LAST = new RegExp(`${FAIL_OPEN_ERROR_WORD}[^.]{0,50}?returns? true`, "gi");
// Deliberately excludes generic "check"/"validat*"/"verif*" — those describe any conditional, not
// specifically an access-control one: "the equality check returns true for unequal inputs, causing
// an error in sorting" and "the parser validation returns true for malformed input when decoding
// throws" are correctness bugs with no authorization semantics at all. Only a permission/access/
// auth-specific word nearby should send the next reviewer looking for an access-control defect.
const FAIL_OPEN_AUTH_CONTEXT =
  /\b(?:permission|permissions|access|auth|authz|authoriz\w*|grant\w*|allow\w*|privilege\w*|role\w*|acl|scoped?|entitlement\w*)\b/i;

function matchesFailOpenTrueResult(note: string): boolean {
  for (const re of [FAIL_OPEN_TRUE_RESULT_FIRST, FAIL_OPEN_TRUE_RESULT_LAST]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(note))) {
      const start = Math.max(0, match.index - 60);
      const end = Math.min(note.length, match.index + match[0].length + 60);
      if (FAIL_OPEN_AUTH_CONTEXT.test(note.slice(start, end))) return true;
      re.lastIndex = match.index + 1;
    }
  }
  return false;
}

// Fail-open expressed as granted access rather than a returned verdict — "access is allowed when
// the lookup rejects" or "a failed check grants access" — describes the same authorization-on-
// error behavior as the returns-form matchers above, just with the access noun as the sentence's
// subject/object instead of a function's return value. No extra auth-context gate is needed here
// since "access"/"permission" are already authorization-specific.
const FAIL_OPEN_ACCESS_NOUN = "(?:access|permission)";
const FAIL_OPEN_ACCESS_PASSIVE = `\\b${FAIL_OPEN_ACCESS_NOUN}\\b[^.]{0,20}?\\b(?:is|are|was|were|gets?|got)\\b[^.]{0,20}?\\b(?:allowed|granted|permitted|authorized)\\b`;
const FAIL_OPEN_ACCESS_ACTIVE = `\\b(?:grants?|allows?|permits?|authorizes?)\\b[^.]{0,20}?\\b${FAIL_OPEN_ACCESS_NOUN}\\b`;
const FAIL_OPEN_ACCESS_GRANTED_FIRST = new RegExp(
  `(?:${FAIL_OPEN_ACCESS_PASSIVE}|${FAIL_OPEN_ACCESS_ACTIVE})[^.]{0,50}?${FAIL_OPEN_ERROR_WORD}`,
  "i",
);
const FAIL_OPEN_ACCESS_GRANTED_LAST = new RegExp(
  `${FAIL_OPEN_ERROR_WORD}[^.]{0,50}?(?:${FAIL_OPEN_ACCESS_PASSIVE}|${FAIL_OPEN_ACCESS_ACTIVE})`,
  "i",
);

// "the request" alone isn't authorization-specific the way "access"/"permission" are — "a failed
// network call allows the request to be retried without backoff" is ordinary retry policy, not
// fail-open. It only counts alongside an explicit permission/access/auth word nearby, checked with
// a stricter context set than FAIL_OPEN_AUTH_CONTEXT: that set includes allow\w*/grant\w*, which
// would trivially match the "allows"/"grants" verb already inside this pattern's own match.
const FAIL_OPEN_REQUEST_NOUN = "the request";
const FAIL_OPEN_REQUEST_PASSIVE = `\\b${FAIL_OPEN_REQUEST_NOUN}\\b[^.]{0,20}?\\b(?:is|are|was|were|gets?|got)\\b[^.]{0,20}?\\b(?:allowed|granted|permitted|authorized)\\b`;
const FAIL_OPEN_REQUEST_ACTIVE = `\\b(?:grants?|allows?|permits?|authorizes?)\\b[^.]{0,20}?\\b${FAIL_OPEN_REQUEST_NOUN}\\b`;
const FAIL_OPEN_REQUEST_GRANTED_FIRST = new RegExp(
  `(?:${FAIL_OPEN_REQUEST_PASSIVE}|${FAIL_OPEN_REQUEST_ACTIVE})[^.]{0,50}?${FAIL_OPEN_ERROR_WORD}`,
  "gi",
);
const FAIL_OPEN_REQUEST_GRANTED_LAST = new RegExp(
  `${FAIL_OPEN_ERROR_WORD}[^.]{0,50}?(?:${FAIL_OPEN_REQUEST_PASSIVE}|${FAIL_OPEN_REQUEST_ACTIVE})`,
  "gi",
);
const FAIL_OPEN_REQUEST_AUTH_CONTEXT =
  /\b(?:permission|permissions|access|auth|authz|authoriz\w*|privilege\w*|role\w*|acl|scoped?|entitlement\w*)\b/i;

function matchesFailOpenRequestGranted(note: string): boolean {
  for (const re of [FAIL_OPEN_REQUEST_GRANTED_FIRST, FAIL_OPEN_REQUEST_GRANTED_LAST]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(note))) {
      const start = Math.max(0, match.index - 60);
      const end = Math.min(note.length, match.index + match[0].length + 60);
      if (FAIL_OPEN_REQUEST_AUTH_CONTEXT.test(note.slice(start, end))) return true;
      re.lastIndex = match.index + 1;
    }
  }
  return false;
}

function matchesFailOpen(note: string): boolean {
  return (
    FAIL_OPEN_LITERAL.test(note) ||
    FAIL_OPEN_AUTHORIZED_RESULT_FIRST.test(note) ||
    FAIL_OPEN_AUTHORIZED_RESULT_LAST.test(note) ||
    FAIL_OPEN_ACCESS_GRANTED_FIRST.test(note) ||
    FAIL_OPEN_ACCESS_GRANTED_LAST.test(note) ||
    matchesFailOpenTrueResult(note) ||
    matchesFailOpenRequestGranted(note)
  );
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
    pattern: matchesFailOpen,
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
      /overly broad|over-?broad|too broad|scope creep|matches too (?:broadly|much)|too permissive (?:glob|regex|match|pattern)|unintended (?:match|files|scope)|wildcard matches more than/i,
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
