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
import {
  closingFence,
  type Fence,
  fenceCloser,
  isHeading,
  openingFence,
  scanMarkdown,
  type ScannedLine,
} from "./beads/markdown";
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
 * A follow-up's acceptance is one box per instruction line, each fenced block as written, and one
 * box per attached finding ({@link followUpAcceptance}, lib/rework-notes.ts), and a reopen's note is
 * the same text handed to the implementer. Inputs that yield neither — instructions that are only
 * list markers, headings, rules, empty code blocks or the formula's TODO placeholder, with nothing
 * ticked — would file a bead whose one criterion is the generic findings-addressed line: a rubric no
 * review can score and no implementer can act on. Judged here, in the vocabulary both layers share,
 * so the dialog refuses before a bead is written and the route refuses the same request the same way.
 *
 * Only the ABSENCE of a step is judged. Whether a step is a good one is the founder's call.
 */
export function doneGap(instructions: string, findings: readonly ReviewFinding[]): string | null {
  if (instructionCriteria(instructions).length > 0 || findings.length > 0) return null;
  return (
    "Nothing here says what done looks like: the fix instructions hold only list markers, headings " +
    "or rules, empty code blocks, or the formula's TODO placeholder, and no finding is attached. " +
    "Write at least one line an implementer can act on, or attach a finding."
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
 * lands in the criterion exactly as the note carries it. The box may be the zero-character `[]`, as
 * lib/beads/contract.ts reads it: a founder who types `- []` has started a box and stopped, and
 * reading it as text filed `[]` as the follow-up's one criterion.
 */
const LIST_MARKER = /^(?:(?:[-*+•]|\d{1,9}[.)])(?:\s+|$))?(?:\[[ xX]?\](?:\s+|$))?/;

/**
 * A GFM task-list checkbox at a step's head — `[ ]`, `[x]`, `[X]` or the zero-character `[]`, and the
 * whitespace after it — held to {@link LIST_MARKER}'s rule that `]` is followed by whitespace or the
 * line's end, so a CSS selector like `[x].disabled` keeps its brackets. It is the checkbox half of
 * {@link LIST_MARKER} on its own: a container peel ({@link peelContainers}) strips the bullet but
 * leaves the checkbox, since CommonMark makes it the item paragraph's text, not a container. A fence
 * still opens beneath it as it does beneath the bullet, so it comes off before fence detection just as
 * {@link shorn} takes it off an ordinary step — without it `- [ ] ```md` files the opener as a plain
 * criterion, drops the literal heading, shears the bullet, and lets the closer swallow later steps.
 */
const TASK_MARKER = /^\[[ xX]?\](?:\s+|$)/;

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
 * A Setext heading underline as CommonMark reads one — a line of only `=` (an h1) or only `-` (an
 * h2), any length, up to 3 columns in. The underline turns the paragraph line above it into a
 * heading, so both are scaffolding like an ATX `## Backend` and neither files as a criterion. Unlike
 * a thematic break ({@link THEMATIC_BREAK}), which needs three marks, a `-` underline is ANY nonempty
 * run — `Backend\n-` and `Backend\n--` render as h2s just as `Backend\n---` does, so filing the label
 * as a step would let a heading-only draft pass {@link doneGap}. The marks are contiguous: `- -` is a
 * list and `- - -` a thematic break, neither a heading underline. Recognised only from the line it
 * underlines, since a paragraph must precede it — which is also why it outranks a bare thematic break.
 */
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;

/** Columns of indentation past a container's content that open indented code (CommonMark). */
const CODE_INDENT = 4;

/** A tab reaches the next multiple of this, as CommonMark counts indentation. */
const TAB_STOP = 4;

/**
 * A line that opens a list item as CommonMark reads one: up to 3 leading spaces, a bullet or an
 * ordered marker, then whitespace. The bullets are CommonMark's three ONLY — the rich-text `•`
 * {@link LIST_MARKER} shears is deliberately absent, since CommonMark reads `•` as ordinary
 * paragraph text, not a list. Opening a synthetic container on it would misread an example beneath
 * it: `• Expected output:` / (blank) / `    - literal` is a paragraph and a four-space code block, so
 * `- literal` is content the note renders verbatim — treating `•` as a two-column container instead
 * left the example only two columns in and sheared its bullet to `literal`. This regex decides where
 * an item's content begins and so how far later lines must indent to nest, which is exactly the
 * CommonMark structure `•` must stay out of.
 */
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:([ \t]+)|$)/;

/**
 * A line that starts a block of its own rather than continuing a paragraph — a list item, a heading,
 * a rule, a callout. Only these end a list item's paragraph from a lesser indentation; any other
 * text there is the paragraph's lazy continuation, and the item stays open around it.
 */
const BLOCK_START = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)|^ {0,3}>|^ {0,3}#{1,6}(?:\s|$)|^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;

/**
 * A line that INTERRUPTS an open paragraph, ending it — {@link BLOCK_START}'s set, but a list marker
 * only when it can break a paragraph: an ordered one whose start number is 1, and either kind
 * carrying CONTENT. CommonMark lets an ordered list break a paragraph only when it starts at 1 and no
 * other number: `Backend\n2. API\n===` is one multiline Setext heading, not a label above a list,
 * since `2.` does not interrupt. The start number is a VALUE, not a spelling — leading zeros are
 * stripped, so `01.` and `001.` start at 1 and interrupt just as `1.` does; `0{0,8}1` matches those
 * (and nothing longer than {@link LIST_ITEM}'s nine-digit bound). A CONTENTLESS item may not
 * interrupt one either, whichever marker it wears: `Backend\n*\n===` (likewise `+`, `1.`, or a marker
 * trailed by nothing but spaces) is one Setext heading stating no step, and reading the bare marker
 * as an interrupt filed the label and its underline as criteria and let a heading-only send-back pass
 * {@link doneGap}. Hence `[ \t]+\S`: whitespace after the marker, then something for the item to
 * hold. A blockquote or ATX marker interrupts while empty, as CommonMark has them — an empty callout
 * and a bare `#` both open their block.
 * Used only to find where a Setext paragraph ends ({@link setextHeadingRun}); list STRUCTURE still
 * reads every ordered marker ({@link BLOCK_START}, {@link LIST_ITEM}), so `1. a` / `2. b` stay two
 * items — restricting that would misnest the second.
 */
const PARA_INTERRUPT = /^ {0,3}(?:[-*+]|0{0,8}1[.)])[ \t]+\S|^ {0,3}>|^ {0,3}#{1,6}(?:\s|$)|^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;

/**
 * One blockquote marker peeled as a container: up to 3 spaces, then one `>` of a run that whitespace
 * or the line's end follows — {@link QUOTE_MARKER}'s rule, one marker at a time so `>> ` nests two.
 */
const QUOTE_STEP = /^ {0,3}>(?=>*(?:[ \t]|$))/;

const COMMENT_OPEN = "<!--";

const COMMENT_CLOSE = "-->";

/**
 * The tag names CommonMark's HTML block condition 6 knows, verbatim from the spec's list. Matched
 * case-insensitively after a `<` or `</`, and only when whitespace, `>`, `/>` or the line's end
 * follows — so `<paragraph-ish>` prose is not a block.
 */
const HTML_BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|" +
  "dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|" +
  "hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|" +
  "section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";

/**
 * A line that begins an HTML block, which interrupts an open paragraph — CommonMark's start
 * conditions 1 through 6, anchored at the line's start (up to 3 columns in). Each opens a block that
 * ends the paragraph above it, so no Setext underline below can reach back across it: `Fix the
 * retry` / `<div>` / `===` is an actionable step, a block and a stray `===`, and reading the run as
 * one heading dropped the step and left {@link doneGap} refusing a request that stated one. A tag
 * opened MID-line is inline HTML instead and keeps the paragraph open, which is why the head is
 * anchored.
 *
 * Condition 7 — any other complete tag alone on its line — is deliberately absent: the spec's one
 * exception is that a type 7 block may NOT interrupt a paragraph, so `Fix the retry` / `<span x="y">`
 * / `===` really is one multiline Setext heading and files nothing.
 */
const HTML_BLOCK_START = new RegExp(
  "^ {0,3}(?:" +
    "<(?:pre|script|style|textarea)(?:[ \\t>]|$)" +
    "|<!--" +
    "|<\\?" +
    "|<![A-Za-z]" +
    "|<!\\[CDATA\\[" +
    `|</?(?:${HTML_BLOCK_TAGS})(?:[ \\t>]|/>|$)` +
    ")",
  "i",
);

/**
 * The containers a line's content sits in, outermost first: a column its text must reach, or a
 * blockquote marker it must carry. A code block or fence opened after container markers keeps
 * only the lines that carry the same prefix; the first that does not has left the container, and
 * the block ends with it. A column after a `>` counts from the marker, not the line.
 */
type Prefix = (number | ">")[];

/** One thing the instructions say must be true, as the follow-up's acceptance will file it. */
export interface InstructionCriterion {
  /**
   * A shorn instruction line — or, for a code block, the whole block inside its fence: a fenced
   * block as typed, delimiters included, and an indented one re-fenced ({@link refenced}).
   */
  text: string;
  /** A code block: literal content, filed as it was typed rather than boxed line by line. */
  fenced: boolean;
}

/**
 * One criterion per non-blank instruction line, shorn of whatever list marker it was typed with,
 * and one per code block, kept verbatim. Instruction lines arrive as the founder typed them
 * — prose, `-`/`*` bullets, numbered steps, or boxes already — so list markers are stripped rather
 * than nested inside a second box. A line that is only a rule ({@link THEMATIC_BREAK}), a heading
 * ({@link isHeading}) or the formula's prompt ({@link PROMPT_LINE}) is scaffolding like a bare
 * marker, and yields nothing. A paragraph line the next line underlines with `=` or any run of `-`
 * is a Setext heading ({@link setextHeadingRun}), so both it and the underline
 * yield nothing too.
 *
 * Fences are read the way the contract judge reads them ({@link scanMarkdown}): everything inside
 * is LITERAL. A founder who pastes an expected output or a Markdown example has authored the lines
 * `## Expected` and `- item` exactly as they stand, and judging them as heading and bullet dropped
 * one and altered the other — the note kept the example while the acceptance silently asked for
 * less. The block travels as one criterion, delimiters included, so what files is what was typed;
 * an unclosed one is closed ({@link fenceCloser}), since verbatim it would swallow every section
 * written after it. A fence holding nothing but blank lines says nothing, as the judge reads it.
 *
 * Outside a fence a line is judged as TYPED, not as the scanner's `visible` text with HTML comments
 * stripped. The instructions come from a plain textarea and land raw in the bead's note, which no
 * markdown renderer shows: a founder who types `<!--` sees it, and so does the implementer reading
 * the note. Judging the render would hide every line after an unmatched `<!--` — the request about
 * comment parsing that lib/rework-notes.ts escapes the opener to KEEP as a criterion — and the
 * contract would then say less than the note beside it. What was typed is what files.
 *
 * The lines INSIDE a comment that closes are literal for the same reason a fence's are: a founder
 * who types `<!--`, a Markdown sample, `-->` has authored the sample as an example, and shearing
 * `- item` to `item` and dropping `## heading` filed less than the note shows while keeping the two
 * delimiters that framed it. The sample files as ONE literal block, dedented as one unit so an
 * indentation-sensitive example keeps its nesting through to the rendered Acceptance
 * ({@link flushCommentedSample}); the delimiter lines are judged as typed like any other, since each
 * begins outside the comment — but a delimiter that CARRIES a line of the sample (`<!-- if ok:`,
 * `    retry() -->`) contributes it to the block, since only the delimiter itself is punctuation
 * ({@link openedSample}). Only
 * a comment that CLOSES is read so ({@link insideClosedComment}): after a stray `<!--` the rest of
 * the instructions are ordinary steps, and filing their labels and markers verbatim would be the
 * render's mistake in the other direction.
 *
 * An INDENTED code block is literal for the same reason, and CommonMark opens one where the scanner
 * does not: a line indented {@link CODE_INDENT} columns past its container's content, after a
 * blank line, a heading, a rule or a fence — anywhere but inside a paragraph. The note renders
 * `Expected output:`, a blank, `    - item` as a code block, and shearing its bullet filed `item` as
 * the contract while the note still showed the marker. The container is the innermost open list
 * item ({@link itemContentIndent}): four columns under `- Expected output:` is a nested item, since
 * the item's content starts two columns in and a founder who indents sub-steps beneath `Add a
 * retry:` means bullets, while eight columns there is four past the content and renders as code.
 * The block is filed inside a fence rather than as it was indented ({@link refenced}): it lands
 * among the acceptance's boxes, where four spaces after a `- [ ]` line render as nesting, not code.
 *
 * Both blocks can also open on a container's OWN line, where the scanner sees neither: `- ```md`
 * opens a fence inside the list item, as `> ```` does inside a callout, and a marker followed by
 * five or more spaces holds indented code after the one space that is the item's padding
 * ({@link itemContentIndent}). Shearing such a line filed the fence's opener as a step and what
 * followed as steps or nothing. So every marker is peeled first ({@link peelContainers}), and what
 * opens after them keeps the lines that stay inside the same containers ({@link peelPrefix}) —
 * filed dedented, as the note renders them. A task marker rides on the item's paragraph, not its
 * container, so the peel leaves it on the content; every one comes off before the fence check
 * ({@link peelTasks}) so `- [ ] ```md` — and nested `- [ ] [ ] ```md` — opens its fence as the bare
 * `- ```md` does. A fence the
 * scanner did not see leaves its verdicts stale from that line on, so the rest is scanned afresh
 * once the block ends.
 */
export function instructionCriteria(instructions: string): InstructionCriterion[] {
  const out: InstructionCriterion[] = [];
  let lines = scanMarkdown(instructions);
  let literal = insideClosedComment(lines);
  const raw = lines.map((line) => line.text);
  let fence: { opener: string; content: string[] } | undefined;
  // A fence opened after container markers, which the scanner does not track.
  let nested: { opener: string; fence: Fence; prefix: Prefix; content: string[] } | undefined;
  let code: { prefix: Prefix; content: string[] } | undefined;
  // Blank lines inside a block belong to it only when more of its lines follow.
  let pendingBlanks = 0;
  // Content column of every open list item, innermost last.
  const items: number[] = [];
  // The containers the open paragraph sits in, or undefined when none is open: a line continues a
  // paragraph only from inside the SAME containers ({@link samePrefix}).
  let openParagraph: Prefix | undefined;

  // The state after a nested fence is clean — a fence closes every comment — so a fresh scan of
  // what follows is the scan the scanner would have made had it seen the fence.
  const rescan = (from: number) => {
    if (from >= raw.length) return;
    lines = [...lines.slice(0, from), ...scanMarkdown(raw.slice(from).join("\n"))];
    literal = insideClosedComment(lines);
  };
  const flushFence = (closer: string) => {
    if (fence && fence.content.some((line) => line.trim() !== "")) {
      out.push({ text: [fence.opener, ...fence.content, closer].join("\n"), fenced: true });
    }
    fence = undefined;
  };
  const flushNested = (closer: string) => {
    if (nested && nested.content.some((line) => line.trim() !== "")) {
      out.push({ text: [nested.opener, ...nested.content, closer].join("\n"), fenced: true });
    }
    nested = undefined;
    pendingBlanks = 0;
  };
  const flushCode = () => {
    if (code) out.push({ text: refenced(code.content), fenced: true });
    code = undefined;
    pendingBlanks = 0;
  };
  const blanks = () => Array<string>(pendingBlanks).fill("");

  for (let at = 0; at < lines.length; at += 1) {
    if (nested) {
      const text = raw[at]!;
      // A blank line stays inside a list item; it ends a callout, as any line without its `>` does.
      if (text.trim() === "" && !quoted(nested.prefix)) {
        pendingBlanks += 1;
        continue;
      }
      const inner = peelPrefix(text, nested.prefix);
      if (inner !== undefined && closingFence(inner, nested.fence)) {
        nested.content.push(...blanks());
        flushNested(inner);
        rescan(at + 1);
        continue;
      }
      if (inner !== undefined) {
        nested.content.push(...blanks(), inner);
        pendingBlanks = 0;
        continue;
      }
      // Leaving the container closes the fence with it; the line itself is judged afresh.
      flushNested(fenceCloser(nested.opener));
      rescan(at);
    }
    const line = lines[at]!;
    if (line.fenced) {
      flushCode();
      // A fence opened on its OWN line inside a list item is bound to that item, which the flat
      // scanner cannot see: it reports the opener and every line after it as fenced, so a later
      // line that dedents out of the item was filed as the fence's content rather than as the step
      // it is. CommonMark ends the block where its container ends, so hand such a fence to the
      // nested machinery, which already closes one at its container's edge.
      const heldFence = !fence ? itemFence(line.text, items) : undefined;
      if (heldFence) {
        nested = heldFence;
        openParagraph = undefined;
        continue;
      }
      items.length = 0;
      openParagraph = undefined;
      if (!fence) fence = { opener: line.text, content: [] };
      else if (line.delimiter) flushFence(line.text);
      else fence.content.push(line.text);
      continue;
    }
    if (line.text.trim() === "") {
      if (code && quoted(code.prefix)) flushCode();
      else if (code) pendingBlanks += 1;
      openParagraph = undefined;
      continue;
    }
    if (code) {
      const inner = peelPrefix(line.text, code.prefix);
      if (inner !== undefined) {
        code.content.push(...blanks(), inner);
        pendingBlanks = 0;
        continue;
      }
      // A marker-only `>` inside a blockquote is a blank line within the block, not a line that
      // has left it: it carries the quote but not the code indent, so hold it as a pending blank.
      if (blankQuoteLine(line.text, code.prefix)) {
        pendingBlanks += 1;
        continue;
      }
      flushCode();
    }
    if (literal[at]) {
      openParagraph = undefined;
      const prefix = containerPrefix(line.text, items);
      at = flushCommentedSample(lines, literal, at, out, [], prefix) - 1;
      continue;
    }
    // A line indented less than the innermost item's content leaves it — unless it is the lazy
    // continuation of the item's paragraph, which stays inside from any indentation.
    const indent = indentColumns(line.text);
    const lazy = openParagraph !== undefined && !BLOCK_START.test(line.text.trimStart());
    while (!lazy && items.length > 0 && indent < items[items.length - 1]!) items.pop();
    const base = items[items.length - 1] ?? 0;
    const rel = indent >= base ? dedent(line.text, base) : line.text;
    const peeled = peelContainers(rel, base);
    items.push(...peeled.opened);
    const { text: content, column } = peeled;
    // A paragraph continues only inside the containers it opened in: `> a` / `>     code` re-enters
    // the same callout, while `Step` / `>     - literal` enters a NEW one and begins a block there.
    // Comparing prefixes says which — opening a list item or entering a quote both change it, so
    // either ends the paragraph above, as CommonMark has them do.
    //
    // A callout's paragraph is the one exception: CommonMark continues it LAZILY across a line that
    // repeats no `>`, so `> Expected output:` / `    ## literal` is the same two-line paragraph
    // `>     ## literal` writes. Judged on `rel` with its indentation intact — four columns opens
    // indented code, which may not interrupt a paragraph any more than a heading indented that far
    // can — so the line is more of the paragraph's text ({@link continued}) rather than the code
    // block a fresh block start there would be.
    const lazyQuoted =
      openParagraph !== undefined && quoted(openParagraph) && !PARA_INTERRUPT.test(rel);
    const inParagraph =
      openParagraph !== undefined && (lazyQuoted || samePrefix(openParagraph, peeled.prefix));
    if (content.trim() === "") {
      openParagraph = undefined;
      continue;
    }
    // A line {@link CODE_INDENT} columns past its container's content while a paragraph is open can
    // start no block at all — a heading, a rule and a fence each need three columns or fewer, and
    // indented code cannot interrupt a paragraph — so CommonMark renders it as more of that
    // paragraph's TEXT. Its heading or rule shape is spelling, not scaffolding: `Expected output:` /
    // `    ## literal` is one paragraph of two authored lines, and dropping the second as a label
    // filed a contract asking for less than the note shows. Markers still shear ({@link continued}),
    // as they do on the same line indented under a list item — a founder pasting bullets means steps
    // wherever they land — but a line here never yields NOTHING.
    if (inParagraph && indentColumns(content, column) - column >= CODE_INDENT) {
      const text = continued(content);
      if (text) out.push({ text, fenced: false });
      continue;
    }
    if (!inParagraph && indentColumns(content, column) - column >= CODE_INDENT) {
      code = {
        prefix: deeper(peeled.prefix, CODE_INDENT),
        content: [dedent(content, column + CODE_INDENT, column)],
      };
      continue;
    }
    // A rule or a heading standing at its container's own content column is scaffolding, judged
    // before any marker is peeled so `   ---` reads as the rule it renders as. Deeper than that it
    // is never either — the two branches above have already taken it as paragraph text or as code.
    if (THEMATIC_BREAK.test(rel.trim()) || isHeading(rel)) {
      openParagraph = undefined;
      continue;
    }
    // A fence opens beneath a task marker as it does beneath the bullet, but the peel leaves the
    // checkbox on the content; take every one off first, as shorn does with nested boxes, so the
    // opener is the fence itself. The indentation a block start may carry comes off with them
    // ({@link blockStartIndent}), since shorn trims a line before shearing its markers.
    const start = blockStartIndent(content, column);
    const fenceLine = peelTasks(dedent(content, column + start, column));
    const opener = openingFence(fenceLine);
    if (opener) {
      nested = {
        opener: fenceLine,
        fence: opener,
        prefix: deeper(peeled.prefix, start),
        content: [],
      };
      openParagraph = undefined;
      continue;
    }
    const paragraph = !THEMATIC_BREAK.test(content.trim()) && !isHeading(content);
    // The containers the paragraph this line belongs to sits in — its OWN, not this line's, which a
    // lazy continuation peels afresh at the top level: `> Backend` / `API` / `===` is one quoted
    // paragraph, and judging `API` against `[0]` found the `===` a top-level heading needs and
    // dropped both, leaving `Backend` alone in the acceptance while the note still shows three lines.
    const paragraphPrefix = inParagraph && openParagraph !== undefined ? openParagraph : peeled.prefix;
    // A Setext underline closing this paragraph makes every line of it a heading, so all are
    // scaffolding — the whole run, not just the last line, is skipped.
    const setextRun = paragraph ? setextHeadingRun(raw, lines, literal, at, paragraphPrefix) : 0;
    if (setextRun > 0) {
      openParagraph = undefined;
      at += setextRun - 1;
      continue;
    }
    // The sample of a closed comment can begin on the OPENER line, which is not itself `commented`
    // and so was filed whole: `<!-- if ok:` / `    retry()` / `-->` emitted the opener as its own
    // checkbox and dedented `retry()` alone, losing the nesting the note keeps.
    const carried = openedSample(content, peelVisible(line.visible, peeled.prefix), literal[at + 1] === true);
    if (carried !== undefined) {
      openParagraph = undefined;
      out.push({ text: content.slice(0, carried.at).trim(), fenced: false });
      at = flushCommentedSample(lines, literal, at + 1, out, [carried.first], peeled.prefix) - 1;
      continue;
    }
    // A lazy continuation keeps the paragraph's own containers, so the next line is judged against
    // the quote it is still inside rather than the top level it appears to sit at.
    openParagraph = paragraph ? paragraphPrefix : undefined;
    const text = shorn(line.text);
    if (text) out.push({ text, fenced: false });
  }
  flushCode();
  if (nested) flushNested(fenceCloser(nested.opener));
  if (fence) flushFence(fenceCloser(fence.opener));
  return out;
}

/**
 * For each line, whether it begins inside an HTML comment that goes on to close. A line beginning
 * inside a comment closes it iff it holds a `-->`, so a run of commented lines is closed by its last
 * one; walked backwards, that verdict reaches every line of the run and stops at the first line
 * outside it — which is also where a comment reopened on the closing line starts its own run.
 */
function insideClosedComment(lines: readonly ScannedLine[]): boolean[] {
  const out = Array<boolean>(lines.length).fill(false);
  let closes = false;
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at]!;
    if (!line.commented) {
      closes = false;
      continue;
    }
    if (line.text.includes("-->")) closes = true;
    out[at] = closes;
  }
  return out;
}

/**
 * File the closed HTML comment beginning at `at` as criteria, and return the index past its run.
 *
 * A commented Markdown or code sample is literal like a fence's content, so it files as ONE fenced
 * block ({@link refenced}) rather than shorn or boxed line by line — the same shape an indented code
 * block files as ({@link instructionCriteria}). The sample — the lines before the one carrying the
 * closing `-->` — is dedented as one unit by its common indentation, so an indentation-sensitive
 * example (Python, YAML) keeps its relative nesting through to the rendered Acceptance: a `- [ ]` on
 * each line makes separate list items whose leading spaces Markdown collapses, flattening `if ok:` /
 * `    retry()` into criteria that ask for different behaviour than the note shows, while a fenced
 * block renders verbatim. The delimiter lines are judged as typed, each on its own, since each begins
 * outside the comment. A sample of nothing but blank lines files nothing.
 *
 * A chained comment closes and reopens on one line (`--> <!--`), so a single literal run holds
 * several samples — one per `-->`. Each files as its own block, dedented on its own: bulk-filing the
 * tail after the first `-->` would flatten a later block's example carried by the note.
 *
 * A closing line can also CARRY the sample's last line (`    retry() -->`). Its content joins the
 * block rather than filing whole, which would shear the indentation off and show the delimiter as
 * requirement text — the same criteria the closer-on-its-own-line form files. An OPENER line carries
 * the sample's FIRST line the same way (`<!-- if ok:`); a chained `-->  <!-- if ok:` does both at
 * once ({@link openedSample}). The run's own opener is never `literal` — it begins outside the
 * comment — so the caller hands its carried line in as `opening`.
 */
function flushCommentedSample(
  lines: readonly ScannedLine[],
  literal: readonly boolean[],
  at: number,
  out: InstructionCriterion[],
  opening: string[] = [],
  prefix: Prefix = [0],
): number {
  let end = at;
  while (end < lines.length && literal[end]) end += 1;
  let sample: string[] = [...opening];
  // Whether the comment holding this run was opened by a delimiter-only line — the line above the
  // run, which begins outside the comment and so is never itself `literal`. A chained closer can
  // reopen one, so it is re-judged on every closing line below. Judged past the containers too:
  // inside `- <!-- if ok:` the bullet is not prose the opener carries.
  const above = lines[at - 1];
  let openedBlock =
    above !== undefined && peelVisible(above.visible, prefix).trim() === "";
  const flushSample = () => {
    const indents = sample.filter((line) => line.trim() !== "").map((line) => indentColumns(line));
    if (indents.length > 0) {
      const common = Math.min(...indents);
      const body = sample.map((line) => (line.trim() === "" ? "" : dedent(line, common).replace(/\s+$/, "")));
      out.push({ text: refenced(trimBlankEdges(body)), fenced: true });
    }
    sample = [];
  };
  for (let next = at; next < end; next += 1) {
    // The sample's lines carry their containers' markers, which are not part of the example: a
    // blockquoted `>     retry()` dedents to the code the note renders, while keeping the `>` left
    // the common-indent pass at zero and refenced a quoted Markdown fragment instead.
    const line = peelPrefix(lines[next]!.text, prefix) ?? lines[next]!.text;
    const closes = line.indexOf(COMMENT_CLOSE);
    if (closes === -1) {
      sample.push(line);
      continue;
    }
    // A closer can carry the sample's last line: `    retry() -->` is both. It joins the block it
    // continues rather than filing whole, which would shear its indentation off and show the
    // delimiter as requirement text.
    //
    // Two things make a prefix sample rather than prose. Sample lines already stand above it, so the
    // block is plainly open — or nothing does, and the run's FIRST line carries the whole body
    // (`<!--` / `    retry() -->`), which is a sample exactly when the comment was opened by a line
    // that renders as nothing but its delimiter. That second test is what tells the block form from
    // a sentence: `Handle an unmatched <!--` / `Keep a matched <!-- x --> as text.` opens its comment
    // mid-prose, so the continuation is more prose and files as the sentence it was typed as, while
    // a bare `<!--` opens a block whose body is an example. Requiring preceding lines alone refused
    // the one-line body and filed `retry() -->` with its indentation shorn and the delimiter shown
    // as requirement text.
    const carried = (sample.length > 0 || openedBlock) && line.slice(0, closes).trim() !== "";
    if (carried) sample.push(line.slice(0, closes));
    flushSample();
    // A chained line can carry the NEXT sample's first line too: `-->  <!-- if ok:` is a closer, an
    // opener, and the start of a second example. What files is the delimiters; the tail is sample.
    const opened = openedSample(line, peelVisible(lines[next]!.visible, prefix), literal[next + 1] === true);
    const from = carried ? closes : 0;
    out.push({ text: line.slice(from, opened?.at ?? line.length).trim(), fenced: false });
    if (opened) sample.push(opened.first);
    // A chained `--> <!--` reopens on the line it closed: the next run is a block exactly when this
    // line renders as nothing but its delimiters.
    openedBlock = peelVisible(lines[next]!.visible, prefix).trim() === "";
  }
  flushSample();
  return end;
}

/**
 * The sample's first line, where the opener `line` carries it — or undefined when it carries none.
 * `continues` is whether the comment it opens runs on into a `literal` line, the sample the caller
 * is about to file.
 *
 * A comment's sample can begin on the opener line itself: `<!-- if ok:` / `    retry()` / `-->` is
 * one indentation-sensitive example, but the opener begins OUTSIDE the comment, so it is never
 * `literal` and used to file whole — a checkbox of its own, with `retry()` dedented alone beside it,
 * which asks for different behaviour than the note shows. Splitting at the LAST `<!--` (a chained
 * `--> <!--` opens on the line it closed) hands the delimiter back for judging as typed and the tail
 * to the sample: the mirror of a closer carrying the sample's last line
 * ({@link flushCommentedSample}).
 *
 * Only a line whose `visible` render is nothing but the delimiter carries a sample. A line with prose
 * of its own — `see <!-- start` — is the sentence it was typed as, and files whole like every other
 * delimiter line; a bare `<!--` carries nothing to file.
 *
 * The delimiter is granted ONE column of padding, as CommonMark grants a `>` marker one
 * ({@link unquoteOne}), so `<!-- if ok:` dedents to the block the opener-on-its-own-line form files
 * rather than one column shallower.
 */
function openedSample(text: string, visible: string, continues: boolean): { at: number; first: string } | undefined {
  if (!continues || visible.trim() !== "") return undefined;
  const opens = text.lastIndexOf(COMMENT_OPEN);
  if (opens === -1) return undefined;
  const at = opens + COMMENT_OPEN.length;
  const tail = text.slice(at);
  if (tail.trim() === "") return undefined;
  return { at, first: /^[ \t]/.test(tail) ? tail.slice(1) : tail };
}

/**
 * The `visible` render of a line past the containers `prefix` names, or as it stands when it carries
 * none of them. A container marker is not prose the line says: inside `- <!-- if ok:` the bullet is
 * the item that holds the comment, and judging the unpeeled `- ` as text refused the carried sample
 * and filed the opener as a criterion of its own. A markdown renderer strips the comment from
 * `visible` but leaves the markers, so they come off here — a `>` bearing the same one space
 * CommonMark grants it ({@link peelPrefix}).
 *
 * A line that OPENS its container carries the markers themselves rather than the columns they
 * establish, so the column prefix cannot peel them: `- <!-- if ok:` renders as `- `, not as
 * nothing, and the carried sample was refused while the opener filed as a criterion of its own.
 * Those come off by the same left-to-right walk the content took ({@link peelContainers}).
 */
function peelVisible(visible: string, prefix: Prefix): string {
  return peelPrefix(visible, prefix) ?? peelContainers(visible, 0).text;
}

/**
 * The containers the innermost open list item names, for a line inside a closed comment. Such a line
 * is literal, so it never reaches the container peel every ordinary line goes through
 * ({@link peelContainers}) — but its markers are still not part of the example, and it can carry the
 * `>` of a callout the scanner tracks no more than the caller's `items` stack does. The item columns
 * are what the stack holds; a quoted comment's marker is peeled from the run's own lines
 * ({@link flushCommentedSample}), whose prefix this seeds.
 */
function containerPrefix(text: string, items: readonly number[]): Prefix {
  const base = items[items.length - 1] ?? 0;
  const indent = indentColumns(text);
  const prefix: Prefix = [indent >= base ? base : 0];
  let rest = dedent(text, prefix[0] as number);
  while (QUOTE_STEP.test(rest)) {
    rest = unquoteOne(rest.slice(QUOTE_STEP.exec(rest)![0].length));
    prefix.push(">", 0);
  }
  return prefix;
}

/**
 * The column the text of `line` starts at, a tab reaching the next tab stop — counted from `from`,
 * the column `line` itself begins at when it is the tail of a longer one.
 */
function indentColumns(line: string, from = 0): number {
  let column = from;
  for (const char of line) {
    if (char === " ") column += 1;
    else if (char === "\t") column += TAB_STOP - (column % TAB_STOP);
    else break;
  }
  return column;
}

/**
 * `line` past column `to`, its indentation counted from `from` as {@link indentColumns} counts it.
 * A tab that reaches past the boundary is split as CommonMark splits it: the columns beyond the
 * boundary come back as spaces.
 */
function dedent(line: string, to: number, from = 0): string {
  let column = from;
  let at = 0;
  while (at < line.length && column < to) {
    const char = line[at]!;
    if (char === " ") column += 1;
    else if (char === "\t") column += TAB_STOP - (column % TAB_STOP);
    else break;
    at += 1;
  }
  return " ".repeat(Math.max(0, column - to)) + line.slice(at);
}

/**
 * `rel` — a line dedented to `base`, the innermost open item's content column — with every list
 * and blockquote marker at its head peeled, as CommonMark opens containers left to right: what is
 * left is the line's own content, `column` where it starts, and `prefix` what a following line
 * must carry to sit inside the same containers. Items opened before any `>` are reported for the
 * caller's stack, whose columns count from the line's start; those after one are not, since the
 * stack has no way to say "after the marker" — the prefix does.
 *
 * Whether a container was ENTERED here rather than continued is the caller's question about the open
 * paragraph, and `prefix` answers it: a line that opened an item or a quote carries a prefix its
 * predecessor did not ({@link samePrefix}).
 */
function peelContainers(
  rel: string,
  base: number,
): { text: string; column: number; prefix: Prefix; opened: number[] } {
  const prefix: Prefix = [base];
  const opened: number[] = [];
  let text = rel;
  let column = base;
  let quoted = false;
  for (;;) {
    const item = LIST_ITEM.exec(text);
    if (item) {
      const marker = item[1]!.length + item[2]!.length;
      const content = itemContentIndent(item, column);
      text = dedent(text.slice(marker), content, column + marker);
      prefix[prefix.length - 1] = content;
      if (!quoted) opened.push(content);
      column = content;
      continue;
    }
    const quote = QUOTE_STEP.exec(text);
    if (!quote) return { text, column, prefix, opened };
    text = unquoteOne(text.slice(quote[0].length));
    prefix.push(">", 0);
    column = 0;
    quoted = true;
  }
}

/**
 * Do these two lines sit in the SAME containers? A paragraph is only continued from inside the
 * containers it opened in: `> a` / `>     code` re-enters one callout, so the second line is more of
 * the first's paragraph, while `Step` / `>     - literal` ENTERS a callout and begins a block there
 * — CommonMark never lazily continues a paragraph into a container it was not already in.
 */
function samePrefix(a: Prefix, b: Prefix): boolean {
  return a.length === b.length && a.every((step, at) => step === b[at]);
}

/** The text after a `>` marker: CommonMark grants the marker one space, and no more. */
const unquoteOne = (text: string): string =>
  !text.startsWith(">") && /^[ \t]/.test(text) ? text.slice(1) : text;

/** `line` inside the containers `prefix` names, or undefined when it has left them. */
function peelPrefix(line: string, prefix: Prefix): string | undefined {
  let rest = line;
  for (const step of prefix) {
    if (step === ">") {
      const quote = QUOTE_STEP.exec(rest);
      if (!quote) return undefined;
      rest = unquoteOne(rest.slice(quote[0].length));
    } else {
      if (indentColumns(rest) < step) return undefined;
      rest = dedent(rest, step);
    }
  }
  return rest;
}

const quoted = (prefix: Prefix): boolean => prefix.includes(">");

/**
 * Whether `line` is a blank line inside the blockquote `prefix` names: it carries every marker up to
 * and including the innermost `>`, but nothing past it. CommonMark keeps such a line as a blank
 * WITHIN the contained block rather than ending it, so an indented-code example spanning a quoted
 * blank line — `>     first`, `>`, `>     second` — is one block, not two. Judged against the quote
 * portion of the prefix only: the code's own indent past the `>` is exactly what a blank line lacks.
 */
function blankQuoteLine(line: string, prefix: Prefix): boolean {
  const last = prefix.lastIndexOf(">");
  if (last === -1) return false;
  const peeled = peelPrefix(line, prefix.slice(0, last + 1));
  return peeled !== undefined && peeled.trim() === "";
}

/**
 * How many lines the Setext heading beginning at the paragraph line `at` spans — its text lines and
 * the underline that closes them — or 0 when no underline does. A Setext heading's text is every
 * paragraph line up to a {@link SETEXT_UNDERLINE}, so `Backend` / `API` / `=======` is one h1, not a
 * label above a heading; skipping only the last line would still file `Backend` as a criterion a
 * review cannot score, and {@link doneGap} would accept a draft that states no step. The run is
 * judged inside the paragraph's own containers `prefix`, so `> Backend` / `> =======` pairs too, and
 * a blank line, a line that interrupts the paragraph ({@link PARA_INTERRUPT}), a fence — the
 * scanner's own, or one opened past the container markers where it sees none — a comment
 * — whether it stays open or closes on its own line ({@link HTML_BLOCK_START}) — or a line that
 * leaves the container ends the paragraph before any underline: those are not headings.
 */
function setextHeadingRun(
  raw: readonly string[],
  lines: readonly ScannedLine[],
  literal: readonly boolean[],
  at: number,
  prefix: Prefix,
): number {
  for (let next = at + 1; next < lines.length; next += 1) {
    if (lines[next]!.fenced || literal[next]) return 0;
    // A callout's paragraph continues LAZILY across a line repeating no `>`, so such a line is more
    // of the heading's text rather than the end of it: `> Backend` / `API` / `> ===` is one h1, and
    // stopping the walk at `API` filed the label as a step a review cannot score.
    const peeledInner = peelPrefix(raw[next]!, prefix);
    const lazy = peeledInner === undefined && quoted(prefix);
    const inner = lazy ? raw[next]! : peeledInner;
    if (inner === undefined || inner.trim() === "") return 0;
    // A comment that opens AND closes on one line is neither `commented` nor `literal`, so the walk
    // used to cross it — dropping an actionable paragraph as a heading and leaving doneGap to refuse
    // a request that stated a step. It opens an HTML block, which ends the paragraph like any other.
    if (HTML_BLOCK_START.test(inner)) return 0;
    // A fence opened AFTER container markers is invisible to the flat scanner, so `fenced` above
    // never fires for it and the walk crossed the block: `> Fix the retry` / `> ``` ` / `> expected`
    // / `> ``` ` / `> ===` is a step, a sample and a stray `===`, and reading the run as one heading
    // dropped both and left doneGap refusing a request that stated a step. Judged on the peeled
    // `inner`, whose own {@link openingFence} bound of three columns is what keeps a deeper line
    // indented code — which cannot interrupt a paragraph and so stays part of the heading.
    // Task markers come off first, as the main parser takes them off before its own fence check
    // ({@link peelTasks}): this module opens a fence beneath `[ ] ` — GFM makes the box the item
    // paragraph's text, not scaffolding a fence must clear — so the two paths must agree on where one
    // opens. They did not while a CLOSED `> [ ] ``` ` / `> expected` / `> ``` ` fence was found here
    // (its own closer stopped the walk) and an UNCLOSED one was not: `> Fix the retry` / `> [ ] ``` `
    // / `> expected` / `> ===` was consumed whole as a Setext heading, and doneGap refused a
    // send-back that stated a step. The indentation a fence may carry comes off with the markers,
    // as the main path takes it ({@link blockStartIndent}).
    const bare = peelTasks(dedent(inner, blockStartIndent(inner, 0)));
    if (openingFence(inner) || openingFence(bare)) return 0;
    // An underline is not paragraph continuation text, so it cannot arrive lazily: `> Backend` /
    // `API` / `===` leaves the callout and files all three lines as the paragraph they render as,
    // rather than a heading that would drop the founder's text.
    if (SETEXT_UNDERLINE.test(inner)) return lazy ? 0 : next - at + 1;
    // A line that interrupts the paragraph ends it, so no underline can reach `at` — but a non-1
    // ordered marker does not interrupt, and stays part of the multiline heading. Judged on `inner`
    // with its indentation intact: a marker indented four columns past the container cannot interrupt
    // an open paragraph, so `Backend\n    ## API\n===` is one Setext heading — trimming it first
    // filed `Backend` as a step and let a heading-only draft pass doneGap.
    if (PARA_INTERRUPT.test(inner)) return 0;
  }
  return 0;
}

/**
 * The container-bound fence `text` opens inside the innermost open list item, or undefined when it
 * opens none — it is not a fence, or no item holds it.
 *
 * The scanner reads fences flat, with no notion of the item they sit in ({@link scanMarkdown}), so a
 * fence indented to an item's content column is reported as an ordinary one and everything after it
 * — past the blank line, past the bullet that leaves the item — is reported as its content. Reading
 * it as nested instead ends the block where the item ends, as CommonMark does: `- Here's an
 * example:` / an indented fence / a blank / `- Fix the retry` is a code block and a SECOND step, not
 * one block swallowing the step. Items the opener has already dedented out of are popped off
 * `items` first, so the column it is judged against is the item it actually sits in.
 */
function itemFence(
  text: string,
  items: number[],
): { opener: string; fence: Fence; prefix: Prefix; content: string[] } | undefined {
  const indent = indentColumns(text);
  while (items.length > 0 && indent < items[items.length - 1]!) items.pop();
  const base = items[items.length - 1] ?? 0;
  if (base === 0 || indent < base) return undefined;
  const opener = dedent(text, base);
  const fence = openingFence(opener);
  return fence && { opener, fence, prefix: [base], content: [] };
}

/**
 * The columns of indentation `content` carries that a block start is allowed — one to three past its
 * container's content column `column`, and none once four open indented code instead. A fence and the
 * task markers riding in front of it are found past that indentation, as {@link shorn} shears a line
 * it has trimmed first: without it `  [ ] ```md` filed its opener as an ordinary criterion while the
 * column-0 `[ ] ```md` opened a fence, and the closer left behind opened one that swallowed every
 * step after it. Held under {@link CODE_INDENT} so a four-column line stays what it was — a fence
 * needs three columns or fewer, and a lazy continuation there is paragraph text.
 */
function blockStartIndent(content: string, column: number): number {
  const indent = indentColumns(content, column) - column;
  return indent < CODE_INDENT ? indent : 0;
}

/** `prefix` with its innermost column `columns` further in — where an indented block's content starts. */
function deeper(prefix: Prefix, columns: number): Prefix {
  const out = [...prefix];
  out[out.length - 1] = (out[out.length - 1] as number) + columns;
  return out;
}

/**
 * The column a list item's content starts at: the marker's own column and width, then the
 * whitespace after it — one to four columns, or one when the marker ends the line or five or more
 * follow, as CommonMark reads both (the rest of such a line is indented code).
 */
function itemContentIndent(item: RegExpExecArray, base: number): number {
  const markerEnd = base + item[1]!.length + item[2]!.length;
  let column = markerEnd;
  for (const char of item[3] ?? "") {
    column += char === "\t" ? TAB_STOP - (column % TAB_STOP) : 1;
  }
  const after = column - markerEnd;
  return markerEnd + (after >= 1 && after <= 4 ? after : 1);
}

/**
 * An indented code block's content, de-indented, inside a backtick fence it cannot close: one
 * backtick longer than any run opening a content line, as CommonMark bounds a closer. The block
 * renders exactly as the indented original did, and the judge reads it as literal either way.
 */
function refenced(content: string[]): string {
  const longest = Math.max(0, ...content.map((line) => /^ {0,3}(`*)/.exec(line)![1]!.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [fence, ...content, fence].join("\n");
}

/** `lines` with its leading and trailing blank lines dropped, keeping the blanks between content. */
function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let stop = lines.length;
  while (start < stop && lines[start]!.trim() === "") start += 1;
  while (stop > start && lines[stop - 1]!.trim() === "") stop -= 1;
  return lines.slice(start, stop);
}

/**
 * The line with every leading list and blockquote marker stripped, or empty when nothing but
 * scaffolding remains. Markers nest — `- - `, `1. - `, `- [ ] [ ] `, `> - ` — and shearing one layer
 * can expose another bare marker, a rule or a heading (`- - ---`, `> ---`, `- ## Backend`), so each
 * layer is judged as the line in full was: a rule or heading yields nothing, a marker is shorn and
 * the remainder judged again. What is left once no marker remains is judged last against the
 * formula's prompt, which is scaffolding in whichever list shape it arrived.
 *
 * A heading is scaffolding for the reason lib/beads/contract.ts reads it so: `## Backend` labels the
 * steps under it, it is not one. A founder who structures the note that way has stated the steps
 * beneath the label, and boxing the label filed `- [ ] ## Backend` as a criterion no implementer
 * can act on — while a note that is ONLY labels passed the gate having stated nothing. The heading
 * rule is the scanner's own ({@link isHeading}), so `#123 fixed the retry` keeps its issue number.
 *
 * The blockquote marker comes off with the list markers ({@link QUOTE_MARKER}) for the reason
 * lib/beads/contract.ts strips it: it styles its content, it is not content. A founder who pastes a
 * ticket's `> - [ ] TODO — ...` callout has written nothing, and leaving the `>` on hid the
 * placeholder from {@link PROMPT_LINE} and filed the same marker-only box the contract gate refuses.
 */
/**
 * `text` with every leading GFM task marker peeled ({@link TASK_MARKER}). Boxes nest — a founder
 * pastes `- [ ] [ ] ```md` as `shorn` reads `- [ ] [x] twice boxed` — so one `.replace` leaves a
 * `[ ] ` glued to the fence and the opener goes undetected; peeling to a fixed point matches shorn's
 * nested-marker behaviour, so a fence opens beneath any depth of scaffolding.
 */
function peelTasks(text: string): string {
  let out = text;
  for (let next = out.replace(TASK_MARKER, ""); next !== out; next = out.replace(TASK_MARKER, "")) {
    out = next;
  }
  return out;
}

function shorn(line: string): string {
  let text = line.trim();
  for (;;) {
    if (THEMATIC_BREAK.test(text) || isHeading(text)) return "";
    const next = text.replace(QUOTE_MARKER, "").trim().replace(LIST_MARKER, "");
    if (next === text) return PROMPT_LINE.test(text) ? "" : text;
    text = next;
  }
}

/**
 * A line CONTINUING an open paragraph, shorn — {@link shorn} without the rules that yield nothing
 * for a heading or a rule.
 *
 * Those two rules read a shape as scaffolding: `## Backend` labels the steps below it and `---`
 * separates two thoughts, so neither is a step. A line that cannot interrupt the paragraph above it
 * is neither — CommonMark renders it as more of that paragraph's text, so `Expected output:` /
 * `    ## literal` is one paragraph of two lines and the founder authored both. Dropping the second
 * filed a contract that asked for less than the note beside it shows. Markers still shear (a pasted
 * bullet is a step in either position), and the formula's prompt still yields nothing: a `TODO —`
 * placeholder is unwritten wherever it lands.
 */
function continued(line: string): string {
  let text = line.trim();
  for (;;) {
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
