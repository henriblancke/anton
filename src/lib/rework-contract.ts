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

/** Columns of indentation past a container's content that open indented code (CommonMark). */
const CODE_INDENT = 4;

/** A tab reaches the next multiple of this, as CommonMark counts indentation. */
const TAB_STOP = 4;

/**
 * A line that opens a list item as CommonMark reads one: up to 3 leading spaces, a bullet or an
 * ordered marker, then whitespace. The marker set is {@link LIST_MARKER}'s; only where the line
 * STARTS differs, since here it decides where the item's content begins and so how far the lines
 * after it must be indented to nest in it.
 */
const LIST_ITEM = /^( {0,3})([-*+•]|\d{1,9}[.)])(?:([ \t]+)|$)/;

/**
 * A line that starts a block of its own rather than continuing a paragraph — a list item, a heading,
 * a rule, a callout. Only these end a list item's paragraph from a lesser indentation; any other
 * text there is the paragraph's lazy continuation, and the item stays open around it.
 */
const BLOCK_START = /^ {0,3}(?:[-*+•]|\d{1,9}[.)])(?:\s|$)|^ {0,3}>|^ {0,3}#{1,6}(?:\s|$)|^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;

/**
 * One blockquote marker peeled as a container: up to 3 spaces, then one `>` of a run that whitespace
 * or the line's end follows — {@link QUOTE_MARKER}'s rule, one marker at a time so `>> ` nests two.
 */
const QUOTE_STEP = /^ {0,3}>(?=>*(?:[ \t]|$))/;

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
 * marker, and yields nothing.
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
 * delimiters that framed it. Each such line files as it was typed, unshorn, the sample dedented as
 * one unit so an indentation-sensitive example keeps its nesting ({@link flushCommentedSample}); the
 * delimiter lines are judged as typed like any other, since each begins outside the comment. Only
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
  let inParagraph = false;

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
      items.length = 0;
      inParagraph = false;
      if (!fence) fence = { opener: line.text, content: [] };
      else if (line.delimiter) flushFence(line.text);
      else fence.content.push(line.text);
      continue;
    }
    if (line.text.trim() === "") {
      if (code && quoted(code.prefix)) flushCode();
      else if (code) pendingBlanks += 1;
      inParagraph = false;
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
      inParagraph = false;
      at = flushCommentedSample(raw, literal, at, out) - 1;
      continue;
    }
    // A line indented less than the innermost item's content leaves it — unless it is the lazy
    // continuation of the item's paragraph, which stays inside from any indentation.
    const indent = indentColumns(line.text);
    const lazy = inParagraph && !BLOCK_START.test(line.text.trimStart());
    while (!lazy && items.length > 0 && indent < items[items.length - 1]!) items.pop();
    const base = items[items.length - 1] ?? 0;
    const rel = indent >= base ? dedent(line.text, base) : line.text;
    if (THEMATIC_BREAK.test(rel.trim()) || isHeading(rel)) {
      inParagraph = false;
      continue;
    }
    const peeled = peelContainers(rel, base);
    items.push(...peeled.opened);
    if (peeled.fresh) inParagraph = false;
    const { text: content, column } = peeled;
    if (content.trim() === "") {
      inParagraph = false;
      continue;
    }
    if (!inParagraph && indentColumns(content, column) - column >= CODE_INDENT) {
      code = {
        prefix: deeper(peeled.prefix, CODE_INDENT),
        content: [dedent(content, column + CODE_INDENT, column)],
      };
      continue;
    }
    // A fence opens beneath a task marker as it does beneath the bullet, but the peel leaves the
    // checkbox on the content; take every one off first, as shorn does with nested boxes, so the
    // opener is the fence itself.
    const fenceLine = peelTasks(content);
    const opener = openingFence(fenceLine);
    if (opener) {
      nested = { opener: fenceLine, fence: opener, prefix: peeled.prefix, content: [] };
      inParagraph = false;
      continue;
    }
    inParagraph = !THEMATIC_BREAK.test(content.trim()) && !isHeading(content);
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
 * A commented Markdown or code sample is literal like a fence's content, so its lines file as typed
 * rather than shorn ({@link instructionCriteria}). The sample — the lines before the one carrying the
 * closing `-->` — is dedented as ONE unit by its common indentation, so an indentation-sensitive
 * example (Python, YAML) keeps its relative nesting; trimming each line on its own flattened a sample
 * like `if ok:` / `    retry()` into two unindented criteria that describe different behaviour. The
 * delimiter lines are judged as typed, each on its own, since each begins outside the comment. Blank
 * lines file nothing, as they did line by line.
 */
function flushCommentedSample(
  raw: readonly string[],
  literal: readonly boolean[],
  at: number,
  out: InstructionCriterion[],
): number {
  let end = at;
  while (end < raw.length && literal[end]) end += 1;
  const run = raw.slice(at, end);
  const closeAt = run.findIndex((line) => line.includes("-->"));
  const sample = closeAt === -1 ? run : run.slice(0, closeAt);
  const closers = closeAt === -1 ? [] : run.slice(closeAt);
  const indents = sample.filter((line) => line.trim() !== "").map((line) => indentColumns(line));
  const common = indents.length > 0 ? Math.min(...indents) : 0;
  for (const line of sample) {
    if (line.trim() === "") continue;
    out.push({ text: dedent(line, common).replace(/\s+$/, ""), fenced: false });
  }
  for (const line of closers) out.push({ text: line.trim(), fenced: false });
  return end;
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
 */
function peelContainers(
  rel: string,
  base: number,
): { text: string; column: number; prefix: Prefix; opened: number[]; fresh: boolean } {
  const prefix: Prefix = [base];
  const opened: number[] = [];
  let text = rel;
  let column = base;
  let quoted = false;
  let fresh = false;
  for (;;) {
    const item = LIST_ITEM.exec(text);
    if (item) {
      const marker = item[1]!.length + item[2]!.length;
      const content = itemContentIndent(item, column);
      text = dedent(text.slice(marker), content, column + marker);
      prefix[prefix.length - 1] = content;
      if (!quoted) opened.push(content);
      column = content;
      fresh = true;
      continue;
    }
    const quote = QUOTE_STEP.exec(text);
    if (!quote) return { text, column, prefix, opened, fresh };
    text = unquoteOne(text.slice(quote[0].length));
    prefix.push(">", 0);
    column = 0;
    quoted = true;
  }
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
