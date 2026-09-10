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
  /**
   * Begins inside an HTML comment opened on an earlier line. The render hides it and it opens
   * neither a section nor a fence; whether the comment ever closes is the line's own `-->`.
   */
  commented: boolean;
  /** What the line RENDERS — HTML comments stripped outside fences, fenced content kept as written. */
  visible: string;
  /**
   * {@link text} with every commented span blanked to spaces — CHARACTER-FOR-CHARACTER as long as
   * the source, so an offset into it is an offset into the source.
   *
   * `visible` answers "what does this line say"; this answers "where in the line does it say it",
   * which is what a caller that REWRITES a line needs. Inside a fence it is `text` verbatim, since a
   * `<!--` there is content rather than markup.
   */
  masked: string;
  /** The heading this line opens. Never set inside a fence or an HTML comment: the render shows a
   * literal line there, not a section. */
  heading?: Heading;
}

/** A rendered line: the text the description shows, still flagged for whether it came from a fence. */
export interface RenderedLine {
  text: string;
  fenced: boolean;
}

/** A fence delimiter as scanned: the character, the run's length, and whatever follows it. */
export interface Fence {
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
  /** See {@link ScannedLine.masked}. */
  masked: string;
  inComment: boolean;
}

/** Where the comment open at `from` ends — the offset just past its `-->` — or undefined when the
 * comment never closes and swallows the rest of the text, the way it renders. */
const commentEnd = (text: string, from: number): number | undefined => {
  const at = text.indexOf(COMMENT_CLOSE, from);
  return at === -1 ? undefined : at + COMMENT_CLOSE.length;
};

const blanks = (len: number): string => " ".repeat(len);

/**
 * `text` with its HTML comments removed, the same text with them BLANKED, and the comment state it
 * leaves behind for the next line.
 *
 * The one comment state machine in the contract. `<!--` and `-->` are matched in order, so an
 * unclosed comment swallows the rest of the text — the way it renders, which is what makes the
 * judgement fail closed rather than read hidden markup as authored spec.
 *
 * Two renderings of one walk rather than two walks: a caller that reads what a line SAYS wants the
 * comments gone, a caller that rewrites the line in place needs its own offsets back, and computing
 * those separately is how the two would come to disagree about where a comment ends.
 */
function stripComments(text: string, inComment: boolean): CommentScan {
  let visible = "";
  let masked = "";
  let at = 0;
  let open = inComment;
  for (;;) {
    if (open) {
      const end = commentEnd(text, at);
      if (end === undefined) {
        return { visible, masked: masked + blanks(text.length - at), inComment: true };
      }
      masked += blanks(end - at);
      at = end;
      open = false;
      continue;
    }
    const start = text.indexOf(COMMENT_OPEN, at);
    if (start === -1) {
      const rest = text.slice(at);
      return { visible: visible + rest, masked: masked + rest, inComment: false };
    }
    visible += text.slice(at, start);
    masked += text.slice(at, start) + blanks(COMMENT_OPEN.length);
    at = start + COMMENT_OPEN.length;
    open = true;
  }
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

/**
 * The delimiter that closes the fence `opener` opens — its own run of backticks or tildes, alone on
 * a line. For a caller that copies a fenced block into another body: an UNCLOSED fence runs to the
 * end of the text it lands in, so it must be closed there or it swallows whatever follows.
 */
export function fenceCloser(opener: string): string {
  const fence = fenceOf(opener);
  if (!fence) throw new Error(`Not a fence delimiter: ${JSON.stringify(opener)}`);
  return fence.char.repeat(fence.len);
}

/**
 * The fence `text` opens, by the rule the scanner applies at the start of a line — or undefined.
 * For a caller that meets a fence where the scanner does not look: after a container marker, as
 * `- ```` opens one inside the list item.
 */
export function openingFence(text: string): Fence | undefined {
  const fence = fenceOf(text);
  return fence && opensFence(fence) ? fence : undefined;
}

/** Does `text` close the fence `open`, by the scanner's rule? */
export function closingFence(text: string, open: Fence): boolean {
  const fence = fenceOf(text);
  return fence !== undefined && closesFence(fence, open);
}

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
    return {
      text,
      fenced: false,
      delimiter: false,
      commented: true,
      visible: comment.visible,
      masked: comment.masked,
    };
  }
  if (fenceDelimiter(state, text)) {
    return { text, fenced: true, delimiter: true, commented: false, visible: "", masked: text };
  }
  // Inside a fence everything is literal: comment state is not tracked there, matching the render's
  // own rule that a `<!--` in fenced code is content rather than markup.
  if (state.fence) {
    return { text, fenced: true, delimiter: false, commented: false, visible: text, masked: text };
  }
  const comment = stripComments(text, false);
  state.inComment = comment.inComment;
  return {
    text,
    fenced: false,
    delimiter: false,
    commented: false,
    visible: comment.visible,
    masked: comment.masked,
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
  return scan(source).lines;
}

/**
 * A persistent HTML block's opener and the tag that closes it — CommonMark's start conditions 1, 3,
 * 4 and 5, the ones that end at their OWN closing text rather than at a blank line
 * ({@link unterminatedCloser}). Condition 2's `<!--` is the comment state machine's already.
 * Condition 7 is absent because a blank line ends it, so nothing appended after one lands inside it.
 */
const HTML_BLOCKS: { open: RegExp; close: string }[] = [
  { open: /^ {0,3}<pre(?:[ \t>]|$)/i, close: "</pre>" },
  { open: /^ {0,3}<script(?:[ \t>]|$)/i, close: "</script>" },
  { open: /^ {0,3}<style(?:[ \t>]|$)/i, close: "</style>" },
  { open: /^ {0,3}<textarea(?:[ \t>]|$)/i, close: "</textarea>" },
  { open: /^ {0,3}<\?/, close: "?>" },
  { open: /^ {0,3}<!\[CDATA\[/, close: "]]>" },
  // CommonMark's declaration block requires an uppercase ASCII letter. A lowercase `<!foo` is
  // ordinary text, so treating it as raw HTML hides the Acceptance heading that follows it.
  { open: /^ {0,3}<![A-Z]/, close: ">" },
];

/**
 * A block that ends at the next BLANK line rather than at a closing tag — CommonMark's start
 * condition 6, the named block-level tags. Its content is raw HTML until the blank terminator, so an
 * Acceptance-looking heading inside it is not a visible section. It also stops a persistent opener
 * ({@link HTML_BLOCKS}) from starting inside it: `<div>` / `<script>` / blank / `## Acceptance
 * Criteria` renders that final heading, while reading the `<script>` as a block of its own hid it and
 * appended a second one after a closing tag nobody wrote.
 *
 * Condition 7 — any other complete tag alone on its line — is absent for the same reason it is
 * absent from the send-back parser: it may not interrupt a paragraph, so recognising it here would
 * need paragraph state this walk does not keep, and misreading prose as a block hides more than it
 * reveals. Nothing it would cover holds a persistent opener without one of these tags above it.
 */
const LOOSE_HTML_BLOCK = new RegExp(
  "^ {0,3}</?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|" +
    "dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|" +
    "head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|" +
    "p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \\t>]|/>|$)",
  "i",
);

/**
 * The line that closes whatever construct `source` ends inside — the fence's own delimiter, `-->`
 * for an HTML comment, or the closing tag of a persistent HTML block — or undefined when it ends
 * clean. For a caller that APPENDS to a body: an unclosed construct runs to the end of the text, so
 * anything appended lands inside it, shown as literal code or hidden outright, and never read as a
 * heading.
 *
 * The closer carries the INDENTATION of the line that opened the construct, so it closes inside
 * whatever container holds it. This scanner reads fences flat, with no notion of the list item a
 * fence sits in, and an unindented delimiter under `- example` / an indented fence does not close
 * that fence at all: CommonMark uses the dedent to leave the ITEM first, which ends the block with
 * it, and then reads the delimiter as a fresh top-level opener that swallows everything appended
 * below — the `## Acceptance` this scanner still reports as written. Matching the opener's own
 * indentation closes the block where it was opened. A delimiter is only ever recognised up to three
 * columns in ({@link FENCE}, {@link HTML_BLOCKS}), so the indentation carried is always an
 * indentation a closer may wear.
 *
 * The HTML blocks are the ones CommonMark ends at their own closing text ({@link HTML_BLOCKS}), not
 * at a blank line: a description trailing off inside `<script>` swallowed an appended
 * `## Acceptance` in every renderer, while this scanner — which models no HTML block — reported the
 * section as written, so the bead read as complete and could never be approved. They are walked
 * here rather than in {@link ScanState} because only an APPENDING caller needs them: a heading
 * inside one is still a heading to the judge, which reads the same text the scanner does.
 */
export function unterminatedCloser(source: string): string | undefined {
  return walkHtmlBlocks(source).closer;
}

/**
 * For each line of `source`, whether a persistent HTML block ({@link HTML_BLOCKS}) holds it — the
 * opener line included. Such a line renders as raw HTML, or as nothing at all, whatever it says: a
 * `## Acceptance Criteria` inside a `<script>` is a heading to every reader of {@link scanMarkdown}
 * (which models no HTML block) and a section nobody can see in the description itself.
 *
 * For a caller that decides whether a section is THERE before writing one. Reading the hidden
 * heading as present skips the closer {@link unterminatedCloser} would have written and files a
 * bead whose rendered contract is missing the section its judge reports as written — and a bead
 * that reads as complete is never reconciled again.
 */
export function htmlBlockLines(source: string): boolean[] {
  return walkHtmlBlocks(source).inHtml;
}

/**
 * One walk of the persistent HTML blocks over `source`: which lines they hold, and the closer for
 * whatever construct the text ends inside. Both answers come from the same pass so the two readers
 * cannot disagree about where a block began or whether it ever closed.
 */
function walkHtmlBlocks(source: string): { inHtml: boolean[]; closer: string | undefined } {
  const state: ScanState = { inComment: false };
  let html: { close: string } | undefined;
  // The indentation of the line that opened whatever is still open, so the closer lands in the same
  // container the opener did.
  let indent = "";
  // A blank-terminated block (CommonMark's conditions 6 and 7) standing open. Its content is raw
  // HTML too, so nothing inside it opens anything — a `<script>` under `<div>` is text the outer
  // block holds, not a block of its own, and tracking one there hid a heading the render shows.
  let looseHtml = false;
  const inHtml: boolean[] = [];
  for (const text of source.split(/\r?\n/)) {
    // An HTML block is literal until its closing text: no fence opens and no comment starts inside
    // one, so nothing else is tracked while it stands.
    if (html) {
      // A persistent HTML block is still bound to the list item or blockquote that opened it.
      // Once a line leaves that container, CommonMark closes the container (and therefore this
      // block) before reading the leaving line. Do not let a quoted `<script>` hide a top-level
      // Acceptance heading merely because its closing tag was never written.
      if (indent && !text.startsWith(indent)) {
        html = undefined;
      } else {
        inHtml.push(true);
        if (text.toLowerCase().includes(html.close)) html = undefined;
        continue;
      }
    }
    if (looseHtml) {
      // Its nonblank content is raw HTML. The blank terminator and what follows render as Markdown.
      looseHtml = text.trim() !== "";
      inHtml.push(looseHtml);
      continue;
    }
    const openFence = state.fence !== undefined;
    const openComment = state.inComment;
    const line = scanLine(state, text);
    // This line opened one of them — a fence delimiter or a `<!--` that outlives the line.
    if ((!openFence && state.fence) || (!openComment && state.inComment)) indent = indentOf(text);
    if (line.fenced || state.inComment) {
      inHtml.push(false);
      continue;
    }
    // Judged on the comment-blanked text: a `<script>` inside `<!-- … -->` opens no block. Judged
    // past the container markers too ({@link peelContainers}): a block opens inside the list item or
    // callout that holds it, and reading the raw `- <script>` found no opener — so the heading below
    // it was reported as written while every render hid it as raw HTML.
    const container = peelContainers(line.masked);
    html = HTML_BLOCKS.find((block) => block.open.test(container.content));
    if (!html) looseHtml = LOOSE_HTML_BLOCK.test(container.content);
    inHtml.push(html !== undefined || looseHtml);
    if (html) {
      if (text.toLowerCase().includes(html.close)) html = undefined;
      else indent = container.prefix;
    }
  }
  const closer = state.fence
    ? indent + state.fence.char.repeat(state.fence.len)
    : state.inComment
      ? indent + COMMENT_CLOSE
      : html && indent + html.close;
  return { inHtml, closer: closer || undefined };
}

/** The leading whitespace of `text`, verbatim — the indentation a closer must repeat to sit in the
 * same container as its opener ({@link unterminatedCloser}). */
const indentOf = (text: string): string => /^[ \t]*/.exec(text)![0];

/**
 * One container marker at a line's head — a blockquote `>` or a list bullet — and the whitespace
 * that follows it, as CommonMark opens containers left to right.
 */
const CONTAINER_STEP = /^ {0,3}(?:(>)[ \t]?|(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$))/;

/**
 * The container markers at the head of `text`, and the content that sits inside them.
 *
 * A blockquote or list marker opens its content on the SAME line, so an HTML block can begin behind
 * one: `- <script>` starts the block inside the item, and testing the raw line found no opener at
 * all — the heading under it read as written while the render hid it inside raw HTML.
 *
 * `prefix` is what a CLOSER must carry to land in the same containers ({@link unterminatedCloser}).
 * A quote's marker is repeated verbatim; a list marker becomes the COLUMNS its content sits at,
 * since repeating the bullet would open a second item rather than continue the first. The content's
 * own indentation is carried too, so a block opened by an ordinary indented line — inside a
 * container or not — still closes at the column it opened at.
 */
function peelContainers(text: string): { prefix: string; content: string } {
  let markers = "";
  let rest = text;
  for (;;) {
    const step = CONTAINER_STEP.exec(rest);
    if (!step) return { prefix: markers + indentOf(rest), content: rest };
    markers += step[1] ? step[0] : " ".repeat(step[0].length);
    rest = rest.slice(step[0].length);
  }
}

/** One walk of the state machine: the lines, plus the state the last line left open. */
function scan(source: string): { lines: ScannedLine[]; state: ScanState } {
  const state: ScanState = { inComment: false };
  const lines = source.split(/\r?\n/).map((text) => scanLine(state, text));
  return { lines, state };
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
