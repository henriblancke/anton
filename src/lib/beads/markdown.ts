/**
 * The markdown scanner the bead contract is read through (anton-lauu).
 *
 * One pass, one state machine. Every stage of the contract — sectioning a description by heading,
 * reading what a section RENDERS, judging whether it says anything — needs the same three facts
 * about a line: does it sit inside a fenced code block, does it begin inside an HTML comment, and
 * what does the render actually show of it. The contract used to answer those twice, and the two
 * answers could disagree in exactly the place that matters: a `## Acceptance` one copy sees and the
 * other hides is a ticket approved against a definition of done nobody can read.
 *
 * Markdown only — it knows nothing of the contract's sections, tiers, or verdicts (contract.ts).
 */

/** An ATX heading: up to 3 leading spaces, 1-6 `#`, the text, optional closing `#`s (CommonMark).
 * The marker is followed by whitespace OR the end of the line: a bare `#` is an empty heading, and
 * reading it as text let a section holding nothing but one pass the gate as authored. */
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)[ \t]*#*[ \t]*)?$/;

/** An opening or closing code fence: up to 3 leading spaces, then 3+ backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** One blockquote marker — up to 3 leading spaces, `>`, then an optional space (CommonMark). */
const BLOCKQUOTE = /^ {0,3}>[ \t]?/;

const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";

/** Heading text → comparison key, case- and punctuation-insensitive: `## Out-of-Scope:` → `outofscope`.
 * Inline HTML comments are stripped first: `## Acceptance <!-- markdownlint-disable-line -->` still
 * renders an Acceptance heading, and slugging the raw annotation missed the section — the hard gate
 * rejected otherwise shaped work. An unclosed comment runs to the end of the line, as it renders. */
const slug = (heading: string) =>
  heading
    .replace(/<!--.*?(?:-->|$)/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

/** Is this line a heading? A judge of "does this section say anything" asks: a subheading is
 * scaffolding over the content below it, not content itself. */
export const isHeading = (text: string): boolean => HEADING.test(text);

/** The section a heading line opens. */
export interface Heading {
  /** The `#` count — how deeply the section nests. */
  depth: number;
  /** The heading text as a comparison key (see {@link slug}). */
  key: string;
}

/** One scanned line of a markdown body: the raw text plus everything a reader of it must know. */
export interface ScannedLine {
  /** The source line, verbatim. */
  text: string;
  /** Inside a fenced code block — the delimiter lines included. Fenced text is LITERAL content. */
  fenced: boolean;
  /** A fence delimiter: punctuation rather than content, so the render shows no line for it. */
  delimiter: boolean;
  /** What the line RENDERS — HTML comments stripped outside fences, fenced content kept as written. */
  visible: string;
  /** The heading this line opens. Never set inside a fence or an HTML comment: the render shows a
   * literal line there, not a section. */
  heading?: Heading;
}

/** A rendered line: the text the description shows, still flagged for whether it came from a fence. */
export interface RenderedLine {
  text: string;
  fenced: boolean;
}

interface Fence {
  char: string;
  len: number;
  /** Whatever follows the delimiter — an info string on an opener, whitespace on a closer. */
  info: string;
}

interface ScanState {
  fence?: Fence;
  inComment: boolean;
}

interface CommentScan {
  visible: string;
  inComment: boolean;
}

/** What follows the `-->` that closes the comment `text` starts inside, or undefined when the
 * comment never closes — it then swallows the rest of the text, the way it renders. */
const afterComment = (text: string): string | undefined => {
  const at = text.indexOf(COMMENT_CLOSE);
  if (at === -1) return undefined;
  return text.slice(at + COMMENT_CLOSE.length);
};

/** {@link stripComments} for text that starts OUTSIDE a comment. */
function stripFromOutside(text: string): CommentScan {
  let visible = "";
  let rest = text;
  for (;;) {
    const at = rest.indexOf(COMMENT_OPEN);
    if (at === -1) return { visible: visible + rest, inComment: false };
    visible += rest.slice(0, at);
    const after = afterComment(rest.slice(at + COMMENT_OPEN.length));
    if (after === undefined) return { visible, inComment: true };
    rest = after;
  }
}

/**
 * `text` with its HTML comments removed, and the comment state it leaves behind for the next line.
 *
 * The one comment state machine in the contract. `<!--` and `-->` are matched in order, so an
 * unclosed comment swallows the rest of the text — the way it renders, which is what makes the
 * judgement fail closed rather than read hidden markup as authored spec.
 */
function stripComments(text: string, inComment: boolean): CommentScan {
  if (!inComment) return stripFromOutside(text);
  const rest = afterComment(text);
  if (rest === undefined) return { visible: "", inComment: true };
  return stripFromOutside(rest);
}

const fenceOf = (text: string): Fence | undefined => {
  const match = FENCE.exec(text);
  if (!match) return undefined;
  return { char: match[1][0], len: match[1].length, info: match[2] };
};

/** CommonMark, kept to what a description can hit: a backtick fence's info string may not contain a
 * backtick, and a closing fence matches the opening character, is at least as long, and carries
 * nothing but whitespace after it. */
const opensFence = (fence: Fence): boolean => fence.char !== "`" || !fence.info.includes("`");
const closesFence = (fence: Fence, open: Fence): boolean =>
  fence.char === open.char && fence.len >= open.len && fence.info.trim() === "";

/** Does this line delimit a fence? Advances `state` across the block it opens or closes. */
function fenceDelimiter(state: ScanState, text: string): boolean {
  const fence = fenceOf(text);
  if (!fence) return false;
  const open = state.fence;
  if (!open) {
    if (!opensFence(fence)) return false;
    state.fence = fence;
    return true;
  }
  if (!closesFence(fence, open)) return false;
  state.fence = undefined;
  return true;
}

const headingOf = (text: string): Heading | undefined => {
  const match = HEADING.exec(text);
  if (!match) return undefined;
  return { depth: match[1].length, key: slug(match[2] ?? "") };
};

function scanLine(state: ScanState, text: string): ScannedLine {
  // A line that BEGINS inside a comment opens neither a section nor a fence — the render hides it.
  // Text after a `-->` on the same line is kept out of the heading judgement on purpose: a heading
  // must start the line, and the closing delimiter already occupies that position.
  if (state.inComment) {
    const comment = stripComments(text, true);
    state.inComment = comment.inComment;
    return { text, fenced: false, delimiter: false, visible: comment.visible };
  }
  if (fenceDelimiter(state, text)) return { text, fenced: true, delimiter: true, visible: "" };
  // Inside a fence everything is literal: comment state is not tracked there, matching the render's
  // own rule that a `<!--` in fenced code is content rather than markup.
  if (state.fence) return { text, fenced: true, delimiter: false, visible: text };
  const comment = stripComments(text, false);
  state.inComment = comment.inComment;
  return {
    text,
    fenced: false,
    delimiter: false,
    visible: comment.visible,
    heading: headingOf(text),
  };
}

/**
 * Every line of `source`, classified: fenced, delimiter, what it renders, and the heading it opens.
 *
 * Fences and comments matter because the contract is judged on HEADINGS. A bead whose description
 * quotes the formula (or any markdown sample) in a ``` block carries the literal line
 * `## Acceptance` with example boxes under it, and a scanner blind to fences reads that sample as
 * the real section — passing the blocking gate on a ticket that states no definition of done at
 * all. A `## Acceptance` hidden inside a `<!-- … -->` comment is the same hole from the other side:
 * the render shows no heading and no criteria, so a scanner that recognized it would open a section
 * over text nothing ever renders — classifying invisible text as the written spec.
 *
 * An unclosed fence (or comment) runs to the end of the text, so the contract fails closed — the
 * same way the description renders.
 */
export function scanMarkdown(source: string): ScannedLine[] {
  const state: ScanState = { inComment: false };
  return source.split(/\r?\n/).map((text) => scanLine(state, text));
}

/**
 * A body's lines as the rendered description shows them: fence delimiters dropped, HTML comments
 * (`<!-- … -->`, single- or multi-line) stripped. Both are invisible in the render, so a judge of
 * "does this section say anything" must not count them — a template placeholder like
 * `## Acceptance\n<!-- add criteria here -->` is as empty as the heading alone.
 *
 * Each line keeps its `fenced` flag: fenced content is LITERAL, so scaffolding filters (headings,
 * empty list markers, the TODO prompt) hold only outside fences — a rubric written as a fenced
 * Markdown example whose content is heading-shaped is still authored text, and filtering it read
 * the section as absent.
 */
export function renderedLines(raw: string): RenderedLine[] {
  return scanMarkdown(raw)
    .filter((line) => !line.delimiter)
    .map((line) => ({ text: line.visible, fenced: line.fenced }));
}

/**
 * `text` with every blockquote marker stripped, nesting included — the content the callout wraps.
 *
 * The marker is punctuation: `> TODO — fill this in` renders the prompt inside a callout, and it is
 * exactly as unwritten as the bare line. A judge blind to the prefix saw no prompt to match and read
 * the section as authored, so a project-local formula that styles its placeholders as callouts
 * passed the blocking gate with no definition of done at all.
 */
export function unquote(text: string): string {
  let out = text;
  while (BLOCKQUOTE.test(out)) out = out.replace(BLOCKQUOTE, "");
  return out;
}
