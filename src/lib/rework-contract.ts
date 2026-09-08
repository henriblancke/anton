/**
 * The rework request, the five ways it can be refused, and the checks that decide it is malformed at
 * all (anton-4ocm).
 *
 * Kept apart from the action itself ({@link reworkTicket}, lib/rework.ts) because this is the
 * vocabulary the layers ABOVE share: the route maps these five errors onto status codes and never
 * touches the board, while the action is the only thing that writes. Importing the errors from here
 * costs a caller nothing else — no bd, no `gh`, no board read — which is also what lets the rework
 * dialog import it: what the dialog refuses and what the route refuses are one judgement.
 */
import type { ReviewFinding } from "./jobs/review-context";
import {
  MAX_REWORK_INSTRUCTIONS_CHARS,
  MAX_REWORK_SUMMARY_CHARS,
  type ReworkMode,
} from "./types";

/** The founder's decision, as the route receives it. */
export interface ReworkInput {
  /** The ticket being sent back — the run target itself, or one of the tickets under it. */
  ticketId: string;
  mode: ReworkMode;
  /** One line: the reopen's `--reason`, or the follow-up bead's title. */
  summary: string;
  /** What to actually do — inlined verbatim into the implementer's prompt. */
  instructions: string;
  /** Findings the founder selected from the review report, appended to the instructions. */
  findings?: ReviewFinding[];
}

/** The request itself is malformed (missing/oversized text) — the caller's fault (400). */
export class ReworkInvalidError extends Error {}

/** The bead exists but this rework can't apply to it (422): not a run target, not one of its tickets. */
export class ReworkNotAllowedError extends Error {}

/**
 * The target moved under this request, so the send-back would race it (409). Two ways that happens:
 * a run is executing the target right now ({@link assertNoLiveRun}, lib/rework-target.ts), or its
 * pull request stopped being open while the writes were landing ({@link retireFinishedRun},
 * lib/rework-pipeline.ts). Both are answered the same way — look again and send it back — which is
 * what makes them one status.
 */
export class ReworkConflictError extends Error {}

/** Nothing on the board answers to that id (404). */
export class ReworkNotFoundError extends Error {}

/**
 * The target's PR state can't be read, so this send-back can't be decided — or, once its writes had
 * landed, stood behind (503). Whether that PR merged is the difference between re-running the target
 * and opening the work as its own target, and guessing either way strands the send-back — so it
 * fails loud instead, before the writes ({@link assertPrStillOpen}) or by undoing them
 * ({@link retireFinishedRun}). Distinct from {@link ReworkConflictError} throughout: an unreadable
 * `gh` is not evidence the PR moved, and the fix is `gh`, not another send-back.
 */
export class ReworkUnavailableError extends Error {}

/**
 * A request that has passed {@link validateReworkInput}: every field trimmed, non-empty and within
 * its bound, the mode one of the two this module implements, and the findings list defaulted — so no
 * path below has to ask any of it again.
 */
export interface ReworkRequest {
  ticketId: string;
  mode: ReworkMode;
  summary: string;
  instructions: string;
  findings: ReviewFinding[];
}

/**
 * Refuse a malformed request before anything is read off the board.
 *
 * The id is checked FIRST and on its own: a missing one is a malformed request (400), not a rework
 * that can't apply (422) — without this it would fall through to the membership check and be
 * reported as `'' is not part of <target>'s run`.
 */
export function validateReworkInput(input: ReworkInput): ReworkRequest {
  const ticketId = input.ticketId?.trim() ?? "";
  if (!ticketId) throw new ReworkInvalidError("A ticket to send back is required");
  const summary = boundedText(input.summary, MAX_REWORK_SUMMARY_CHARS, {
    missing: "A one-line summary is required",
    tooLong: "Summary is too long",
  });
  const instructions = boundedText(input.instructions, MAX_REWORK_INSTRUCTIONS_CHARS, {
    missing: "Fix instructions are required",
    tooLong: "Instructions are too long",
  });
  const findings = input.findings ?? [];
  const gap = doneGap(instructions, findings);
  if (gap) throw new ReworkInvalidError(gap);
  return {
    ticketId,
    mode: knownMode(input.mode),
    summary,
    instructions,
    findings,
  };
}

/**
 * Why these inputs state no definition of done — or null when they do (anton-xwf1).
 *
 * A follow-up's acceptance is one box per instruction line and one per attached finding
 * ({@link followUpAcceptance}, lib/rework-notes.ts), and a reopen's note is the same text handed to
 * the implementer. Inputs that yield neither — instructions that are only list markers or the
 * formula's TODO placeholder, with nothing ticked — would file a bead whose one criterion is the
 * generic findings-addressed line: a rubric no review can score and no implementer can act on. Judged here, in the vocabulary both layers share,
 * so the dialog refuses before a bead is written and the route refuses the same request the same way.
 *
 * Only the ABSENCE of a step is judged. Whether a step is a good one is the founder's call.
 */
export function doneGap(instructions: string, findings: readonly ReviewFinding[]): string | null {
  if (instructionCriteria(instructions).length > 0 || findings.length > 0) return null;
  return (
    "Nothing here says what done looks like: the fix instructions hold only list markers or rules, " +
    "or the formula's TODO placeholder, and no finding is attached. Write at least one line an " +
    "implementer can act on, or attach a finding."
  );
}

/**
 * A leading `-`, `*`, `+`, `•`, `1.` or `1)` bullet, a checkbox, or both — and the whitespace after
 * them. The bullets are CommonMark's three (the same set lib/beads/contract.ts scans for) plus the `•`
 * a founder pastes from rich text. The bullet must be followed by whitespace or end the line, so a
 * bare `-` or `+` is scaffolding while `-1 is the sentinel` and `+1` keep their sign. An ordered
 * marker is at most nine digits, as CommonMark bounds it and lib/beads/contract.ts parses it — a
 * longer number is an identifier that merely resembles numbering, and stays in the criterion. A
 * checkbox is held to the same rule as a bullet: `]` must be followed by whitespace or end the line,
 * so `[x].disabled must stay matched` — a CSS selector, not a ticked box — keeps its brackets and
 * lands in the criterion exactly as the note carries it.
 */
const LIST_MARKER = /^(?:(?:[-*+•]|\d{1,9}[.)])(?:\s+|$))?(?:\[[ xX]\](?:\s+|$))?/;

/**
 * A blockquote marker — a run of `>` and the whitespace after it — held to the same rule as a
 * bullet: it must be followed by whitespace or end the line. CommonMark reads `>95% coverage` as a
 * callout too, and lib/beads/contract.ts strips it that way because there it judges what a
 * description RENDERS. Here the shorn line is what gets FILED, as an acceptance box, so a `>` glued
 * to its text is kept as the comparison it is: shearing it would file `95% coverage` as the contract
 * while the note the implementer reads still demands more than that. A founder styling a callout
 * types `> `, so the space is what tells the two apart. Nested `>>`/`> >` shear as one marker each.
 */
const QUOTE_MARKER = /^>+(?:[ \t]+|$)/;

/**
 * A thematic break — 3+ `-`/`*`/`_` of one kind, spaces between allowed — as CommonMark and
 * lib/beads/contract.ts both read it. It renders as a rule, not text: a founder who types `---` to
 * separate two thoughts and writes neither has stated no step, and boxing it would file
 * `- [ ] ---` as the follow-up's one criterion. Judged at EVERY level of marker stripping: `- - -` is
 * a rule in full but a bare bullet once shorn, and `- ---` is a bullet in full but a rule once shorn.
 */
const THEMATIC_BREAK = /^([-*_])[ \t]*(?:\1[ \t]*){2,}$/;

/**
 * The bead formula's own prompt — `TODO — a concrete, checkable statement of done` — as
 * lib/beads/contract.ts classifies it: an UNWRITTEN line, not an authored one. A founder who pastes a
 * ticket's placeholder acceptance box and writes nothing over it has stated no step, and boxing it
 * would file the same placeholder rubric the contract gate refuses to run. Judged on the text once
 * every marker is shorn, so `- [ ] TODO —`, `1. TODO:` and bare `TODO -` read the same; anchored on
 * the separator after `TODO`, so an authored line that merely mentions one ("the TODO banner clears")
 * keeps its place.
 */
const PROMPT_LINE = /^TODO\s*[—–:-]/;

/**
 * One criterion per non-blank instruction line, shorn of whatever list marker it was typed with.
 * Instruction lines arrive as the founder typed them — prose, `-`/`*` bullets, numbered steps, or
 * boxes already — so list markers are stripped rather than nested inside a second box. A line that
 * is only a rule ({@link THEMATIC_BREAK}) or the formula's prompt ({@link PROMPT_LINE}) is
 * scaffolding like a bare marker, and yields nothing.
 */
export function instructionCriteria(instructions: string): string[] {
  return instructions
    .split(/\r?\n/)
    .map(shorn)
    .filter((line) => line.length > 0);
}

/**
 * The line with every leading list and blockquote marker stripped, or empty when nothing but
 * scaffolding remains. Markers nest — `- - `, `1. - `, `- [ ] [ ] `, `> - ` — and shearing one layer
 * can expose another bare marker or a rule (`- - ---`, `> ---`), so each layer is judged as the line
 * in full was: a rule yields nothing, a marker is shorn and the remainder judged again. What is left
 * once no marker remains is judged last against the formula's prompt, which is scaffolding in
 * whichever list shape it arrived.
 *
 * The blockquote marker comes off with the list markers ({@link QUOTE_MARKER}) for the reason
 * lib/beads/contract.ts strips it: it styles its content, it is not content. A founder who pastes a
 * ticket's `> - [ ] TODO — ...` callout has written nothing, and leaving the `>` on hid the
 * placeholder from {@link PROMPT_LINE} and filed the same marker-only box the contract gate refuses.
 */
function shorn(line: string): string {
  let text = line.trim();
  for (;;) {
    if (THEMATIC_BREAK.test(text)) return "";
    const next = text.replace(QUOTE_MARKER, "").trim().replace(LIST_MARKER, "");
    if (next === text) return PROMPT_LINE.test(text) ? "" : text;
    text = next;
  }
}

/**
 * A required free-text field, bounded. Both limits are the founder's own text landing verbatim in an
 * implementer's prompt, so they are refused here rather than truncated somewhere downstream.
 */
function boundedText(
  raw: string | undefined,
  max: number,
  refusal: { missing: string; tooLong: string },
): string {
  const text = raw?.trim() ?? "";
  if (!text) throw new ReworkInvalidError(refusal.missing);
  if (text.length > max) {
    throw new ReworkInvalidError(`${refusal.tooLong} (${text.length} > ${max} characters)`);
  }
  return text;
}

/**
 * The mode is never inferred: which of reopen and follow-up is right is a judgement about whether the
 * ticket lied about being done, and only a human reading the review can make it — so an unknown one
 * is refused rather than guessed at.
 */
function knownMode(mode: ReworkMode): ReworkMode {
  if (mode !== "reopen" && mode !== "follow-up") {
    throw new ReworkInvalidError(`Unknown rework mode "${String(mode)}"`);
  }
  return mode;
}
