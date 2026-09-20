/**
 * Markdown structure for bead contracts.
 *
 * CommonMark's block rules deliberately interact: a fence can live in a list, HTML can consume
 * following heading-looking text, and a tag may or may not interrupt a paragraph. We delegate
 * those rules to `mdast-util-from-markdown` (micromark) and keep only the contract's small,
 * source-preserving projection here.
 */
import { fromMarkdown } from "mdast-util-from-markdown";

/** One blockquote marker — retained for the contract's prompt policy, not Markdown parsing. */
const BLOCKQUOTE = /^ {0,3}>[ \t]?/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/** Block starts that interrupt an open paragraph — everything BLOCK_LINE checks except indented
 * code, which CommonMark never lets interrupt a paragraph (it only starts one after a blank line),
 * and a list marker that CommonMark also refuses to let interrupt: an empty item, or an ordered
 * item that doesn't start at 1. Those stay paragraph (here, Setext heading) text. */
const PARAGRAPH_INTERRUPT = /^ {0,3}(?:[-*+]|1[.)])[ \t]+\S|^ {0,3}>|^ {0,3}#{1,6}(?:[ \t]|$)/;
const BLOCK_LINE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)|^ {0,3}>|^ {0,3}#{1,6}(?:[ \t]|$)|^ {4}/;
const HTML_BLOCK_LINE = /^ {0,3}<(?:pre|script|style|textarea)(?:[ \t>]|$)|^ {0,3}<(?:div|address|article|aside|blockquote|body|section|table|ul|ol|li|p)(?:[ \t>]|\/>|$)/i;
const HTML_DECLARATION_LINE = /^ {0,3}(?:<!--|<\?|<!\[CDATA\[|<![A-Z])/;

/** Heading text → comparison key, case- and punctuation-insensitive. */
const slug = (heading: string) => heading.toLowerCase().replace(/[^a-z0-9]+/g, "");
const blanks = (length: number) => " ".repeat(length);

export interface Heading {
  depth: number;
  key: string;
}

export interface ScannedLine {
  text: string;
  fenced: boolean;
  delimiter: boolean;
  commented: boolean;
  visible: string;
  masked: string;
  heading?: Heading;
  /** A continuation of a multi-line heading, such as a Setext underline. */
  headingRest: boolean;
}

export interface RenderedLine {
  text: string;
  fenced: boolean;
  /** Structural heading markup rather than authored body text. */
  heading: boolean;
}

export interface Fence {
  char: string;
  len: number;
  info: string;
}

interface Position {
  start: { line: number; column: number; offset?: number };
  end: { line: number; column: number; offset?: number };
}

interface MarkdownNode {
  type: string;
  value?: string;
  depth?: number;
  position?: Position;
  children?: MarkdownNode[];
}

interface Line {
  text: string;
  start: number;
  end: number;
  fenced: boolean;
  delimiter: boolean;
  commented: boolean;
  /** Inside a raw HTML block — the render shows no Markdown structure there. */
  html: boolean;
  masked: string;
  visible: string;
  heading?: Heading;
  headingRest: boolean;
}

const fenceOf = (text: string): Fence | undefined => {
  const match = FENCE.exec(text);
  return match ? { char: match[1]![0]!, len: match[1]!.length, info: match[2]! } : undefined;
};

const opensFence = (fence: Fence) => fence.char !== "`" || !fence.info.includes("`");
const closesFence = (fence: Fence, open: Fence) =>
  fence.char === open.char && fence.len >= open.len && fence.info.trim() === "";

export function fenceCloser(opener: string): string {
  // Rework callers hand us the source spelling, which can still carry a quote or list marker.
  const fence = fenceOf(opener) ?? fenceOf(opener.replace(/^ {0,3}(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$))/, ""));
  if (!fence) throw new Error(`Not a fence delimiter: ${JSON.stringify(opener)}`);
  return fence.char.repeat(fence.len);
}

export function openingFence(text: string): Fence | undefined {
  const fence = fenceOf(text);
  return fence && opensFence(fence) ? fence : undefined;
}

export function closingFence(text: string, open: Fence): boolean {
  const fence = fenceOf(text);
  return fence !== undefined && closesFence(fence, open);
}

/**
 * Peel the container markers a fenced delimiter's line may carry — each leading blockquote marker
 * (`>`) and the list marker of the innermost item, in the indentation they impose. A fence nested in
 * two blockquotes still reads `> > ```` on both its delimiter lines, so the closing line must be
 * stripped the same full way the opener's column peel does before either side is judged a fence.
 */
function stripContainerMarkers(text: string): string {
  let rest = text;
  for (;;) {
    if (/^ {0,3}>[ \t]?/.test(rest)) {
      rest = rest.replace(/^ {0,3}>[ \t]?/, "");
      continue;
    }
    const item = /^ {0,3}((?:[-*+]|\d{1,9}[.)])[ \t]+)/.exec(rest);
    if (item) {
      rest = rest.slice(item[0].length);
      continue;
    }
    break;
  }
  return rest;
}

/** A fence closer's required container prefix, one step per marker in source order: a blockquote
 * marker must repeat literally, but a list item's continuation only needs to reach the same visual
 * column — CommonMark measures it by column, not by source spelling, so `-\t` and `- ` (both column
 * 2) admit the same closers and a closer may reach that column with either spaces or a tab. */
type ClosureStep = { literal: string } | { columns: number };

function fenceContainerPrefix(text: string): ClosureStep[] {
  const steps: ClosureStep[] = [];
  let rest = text;
  for (;;) {
    const quote = /^ {0,3}>[ \t]?/.exec(rest);
    if (quote) {
      steps.push({ literal: quote[0] });
      rest = rest.slice(quote[0].length);
      continue;
    }
    const item = /^ {0,3}(?:[-*+]|\d{1,9}[.)])([ \t]+)/.exec(rest);
    if (item) {
      let column = 0;
      for (const char of item[0]) column = char === "\t" ? column + (4 - (column % 4)) : column + 1;
      steps.push({ columns: column });
      rest = rest.slice(item[0].length);
      continue;
    }
    return steps;
  }
}

/** `line` past every `steps` requirement, in order, or undefined once one is not met. A literal
 * step must match verbatim; a column step only needs `line` indented that far — by any mix of
 * spaces and tabs — and is then dedented by exactly that many columns, splitting a tab that
 * overshoots into the leftover spaces {@link dedentColumns} does. */
function peelClosurePrefix(line: string, steps: readonly ClosureStep[]): string | undefined {
  let rest = line;
  for (const step of steps) {
    if ("literal" in step) {
      if (!rest.startsWith(step.literal)) return undefined;
      rest = rest.slice(step.literal.length);
    } else {
      if (indentColumns(rest) < step.columns) return undefined;
      rest = dedentColumns(rest, step.columns);
    }
  }
  return rest;
}

/** Visual columns of `text`'s leading run of spaces and tabs, a tab reaching the next multiple of
 * four as CommonMark expands it. */
function indentColumns(text: string): number {
  let column = 0;
  for (const char of text) {
    if (char === " ") column += 1;
    else if (char === "\t") column += 4 - (column % 4);
    else break;
  }
  return column;
}

/** `text` with up to `columns` of its leading indentation removed, counted visually — a tab that
 * reaches past `columns` comes back as the leftover spaces, as CommonMark splits it. */
function dedentColumns(text: string, columns: number): string {
  let column = 0;
  let at = 0;
  while (at < text.length && column < columns) {
    const char = text[at]!;
    if (char === " ") column += 1;
    else if (char === "\t") column += 4 - (column % 4);
    else break;
    at += 1;
  }
  return " ".repeat(Math.max(0, column - columns)) + text.slice(at);
}

/** `text` is a heading precisely when the CommonMark parser produces one complete heading node. */
export function isHeading(text: string): boolean {
  const root = fromMarkdown(text) as unknown as MarkdownNode;
  const [node] = root.children ?? [];
  return node?.type === "heading" && node.position?.end.offset === text.length;
}

const lineRecords = (source: string): Line[] => {
  const out: Line[] = [];
  let start = 0;
  for (const text of source.split(/\r?\n/)) {
    out.push({
      text,
      start,
      end: start + text.length,
      fenced: false,
      delimiter: false,
      commented: false,
      html: false,
      masked: text,
      visible: text,
      headingRest: false,
    });
    start += text.length + (source.startsWith("\r\n", start + text.length) ? 2 : 1);
  }
  return out;
};

const visit = (node: MarkdownNode, fn: (node: MarkdownNode, parent?: MarkdownNode) => void, parent?: MarkdownNode) => {
  fn(node, parent);
  node.children?.forEach((child) => visit(child, fn, node));
};

const lineRange = (lines: Line[], position: Position) => ({
  start: Math.max(0, position.start.line - 1),
  end: Math.min(lines.length - 1, position.end.line - 1),
});

const paragraphLine = (line: Line): boolean =>
  !line.fenced &&
  !line.commented &&
  !line.heading &&
  !line.headingRest &&
  !line.html &&
  line.visible.trim() !== "" &&
  !THEMATIC_BREAK.test(line.text) &&
  !BLOCK_LINE.test(line.text) &&
  !HTML_BLOCK_LINE.test(line.masked) &&
  !HTML_DECLARATION_LINE.test(line.masked);

/**
 * A line the AST already placed inside an open heading's text. Unlike `paragraphLine`, this allows
 * an indented-code-looking line through: CommonMark never lets indented code interrupt an open
 * paragraph, so a four-space line here is a continuation (e.g. a multiline Setext heading), not a
 * block boundary — only the markers that can actually interrupt a paragraph disqualify it.
 */
const headingInteriorLine = (line: Line): boolean =>
  !line.fenced &&
  !line.commented &&
  !line.heading &&
  !line.headingRest &&
  !line.html &&
  line.visible.trim() !== "" &&
  !THEMATIC_BREAK.test(line.text) &&
  !PARAGRAPH_INTERRUPT.test(line.text) &&
  !HTML_BLOCK_LINE.test(line.masked) &&
  !HTML_DECLARATION_LINE.test(line.masked);

/**
 * A blockquote marker repeats on every line of its content, unlike a list marker — a list item's
 * continuation lines carry only the matching indentation, never the marker again. So peeling
 * blockquote markers reflects a container actually still open on this line; peeling anything
 * shaped like a list marker would not, since no genuine list continuation ever carries one.
 */
function stripBlockquoteMarkers(text: string): string {
  let rest = text;
  while (/^ {0,3}>[ \t]?/.test(rest)) rest = rest.replace(/^ {0,3}>[ \t]?/, "");
  return rest;
}

/**
 * An interior heading line stripped of the blockquote markers it repeats from its Setext heading
 * (`> API` under `> Backend`), so it classifies as plain paragraph text rather than tripping the
 * "starts a new block" rejection in `headingInteriorLine`. Must not reuse `stripContainerMarkers`'s
 * list-marker branch: that branch peels a container's *establishing* line (e.g. a fence opener like
 * `- ````), but an interior line was never such a line, so text that merely looks like an ordered
 * marker (`2. ---`, where `2.` can't interrupt the open paragraph) is real heading text, not a
 * marker to peel — peeling it exposed `---` to `headingInteriorLine` as a thematic break and
 * silently closed the heading early.
 */
function containerRelative(line: Line): Line {
  const stripped = stripBlockquoteMarkers(line.text);
  const peeled = line.text.length - stripped.length;
  if (peeled === 0) return line;
  return { ...line, text: stripped, masked: line.masked.slice(peeled), visible: line.visible.slice(peeled) };
}

/**
 * Preserve the contract scanner's conservative Setext projection. Micromark correctly models
 * containers, but a flat contract section reader must never let an underlined line reach across a
 * block boundary; it may still recover a visible Setext heading immediately after a list item.
 */
function markSetextHeadings(lines: Line[]): void {
  for (let at = 1; at < lines.length; at++) {
    const underline = lines[at]!;
    if (underline.heading || underline.headingRest || !SETEXT_UNDERLINE.test(underline.text)) continue;
    let start = at;
    while (start > 0 && paragraphLine(lines[start - 1]!)) start--;
    if (start === at) continue;
    lines[start]!.heading = {
      depth: underline.text.trimStart().startsWith("=") ? 1 : 2,
      key: slug(lines[start]!.visible),
    };
    for (let rest = start + 1; rest <= at; rest++) lines[rest]!.headingRest = true;
  }
}

/**
 * Comments are inline HTML tokens, so their source-preserving projection is kept separate from the
 * AST walk. Micromark decides where HTML blocks and headings are; this only removes an already
 * recognised `<!-- … -->` span without losing offsets needed by citation repairs. An opener inside
 * an inline code span is literal text — CommonMark parses no HTML there — so it never opens a
 * comment here either.
 */
/**
 * Known simplification: this tracks a comment's open/close purely by scanning raw line text, not
 * by the container it opened in. Per CommonMark, an open HTML block does not get lazy continuation
 * — so a comment opened inside a blockquote/list item that does not survive to the next line
 * actually closes there, while this keeps it open until a literal `-->` is seen. Pre-existing
 * (the prior flat scanner had the same gap); it only biases toward over-hiding content, never
 * toward leaking a genuinely hidden comment into `visible`.
 */
function stripComments(lines: Line[], codeSpans: { start: number; end: number }[]) {
  const inCode = (offset: number) => codeSpans.some((span) => offset >= span.start && offset < span.end);
  let open = false;
  for (const line of lines) {
    if (line.fenced) continue;
    let at = 0;
    let visible = "";
    let masked = "";
    const beganOpen = open;
    for (;;) {
      if (open) {
        const end = line.text.indexOf("-->", at);
        if (end === -1) {
          masked += blanks(line.text.length - at);
          open = true;
          break;
        }
        masked += blanks(end + 3 - at);
        at = end + 3;
        open = false;
        continue;
      }
      let start = line.text.indexOf("<!--", at);
      while (start !== -1 && inCode(line.start + start)) start = line.text.indexOf("<!--", start + 4);
      if (start === -1) {
        const rest = line.text.slice(at);
        visible += rest;
        masked += rest;
        break;
      }
      visible += line.text.slice(at, start);
      masked += line.text.slice(at, start) + blanks(4);
      at = start + 4;
      open = true;
    }
    line.visible = visible;
    line.masked = masked;
    line.commented = beganOpen;
  }
}

const textOf = (node: MarkdownNode): string =>
  node.type === "html" ? "" : node.value ?? node.children?.map(textOf).join("") ?? "";

/**
 * Every line classified from the CommonMark AST. The source projection intentionally keeps the
 * original lines: callers rewrite citations in place and must not reformat a bead description.
 *
 * Bead descriptions are external input, and both the recursive-descent parser and this module's
 * own AST walk recurse once per nesting level with no depth cap — a pathologically nested
 * description (thousands of nested blockquotes or list items) can overflow the stack. Falling back
 * to the flat, unstructured projection keeps every board read/write path this feeds from crashing
 * the process on such input, at the cost of not recognizing that one description's structure.
 */
export function scanMarkdown(source: string): ScannedLine[] {
  try {
    return scanMarkdownParsed(source);
  } catch {
    return lineRecords(source).map(({ text }) => ({
      text,
      fenced: false,
      delimiter: false,
      commented: false,
      visible: text,
      masked: text,
      headingRest: false,
    }));
  }
}

function scanMarkdownParsed(source: string): ScannedLine[] {
  const lines = lineRecords(source);
  const root = fromMarkdown(source) as unknown as MarkdownNode;

  visit(root, (node) => {
    if (!node.position) return;
    if (node.type === "code") {
      const { start, end } = lineRange(lines, node.position);
      // A fence's content begins past its container markers clean — `> ````, `- ```` and `> > ````
      // each carry their prefixes on the delimiter's own line, so reading the raw source line found
      // no fence there and let the delimiters render as authored text (`validateBeadContract` then
      // passed a section holding no criterion). Peel every container marker the parser reports
      // preceding the content so a container-owned fence is still read as a fence; indented code
      // carries none, so it stays unfenced.
      const openingText = lines[start]?.text.slice(node.position.start.column - 1) ?? "";
      const opening = openingFence(stripContainerMarkers(openingText));
      if (!opening) return; // Indented code is not a fenced literal for the contract.
      for (let index = start; index <= end; index++) lines[index]!.fenced = true;
      lines[start]!.delimiter = true;
      // The parser includes an unterminated block's final content line in the code node. Its trailing
      // run can resemble a delimiter, but only a full container-stripped line may close the fence —
      // and only the containers the OPENER actually carries: a top-level fence's closer must be
      // judged as-is, or a line that merely looks list/quote-shaped (`- ~~~` as literal content, not
      // a closer) gets stripped down to a false match and consumed as the delimiter.
      const closingLine = lines[end]?.text ?? "";
      const prefix = fenceContainerPrefix(lines[start]?.text.slice(0, node.position.start.column - 1) ?? "");
      const directCloser = prefix.length > 0 ? stripContainerMarkers(closingLine) : closingLine;
      const continuationCloser = prefix.length > 0 ? (peelClosurePrefix(closingLine, prefix) ?? "") : "";
      if (end !== start && (closingFence(directCloser, opening) || closingFence(continuationCloser, opening))) {
        lines[end]!.delimiter = true;
      }
      return;
    }
  });
  const codeSpans: { start: number; end: number }[] = [];
  visit(root, (node) => {
    if (node.type === "inlineCode" && node.position) {
      codeSpans.push({ start: node.position.start.offset!, end: node.position.end.offset! });
    }
  });
  stripComments(lines, codeSpans);
  visit(root, (node) => {
    if (!node.position) return;
    if (node.type === "heading") {
      const { start, end } = lineRange(lines, node.position);
      const line = lines[start];
      const uninterrupted = Array.from({ length: Math.max(0, end - start - 1) }, (_, offset) =>
        headingInteriorLine(containerRelative(lines[start + offset + 1]!)),
      ).every(Boolean);
      if (line && !line.fenced && !line.commented && (end === start || uninterrupted)) {
        line.heading = { depth: node.depth!, key: slug(textOf(node).replace(/<!--.*$/, "")) };
        for (let at = start + 1; at <= end; at++) lines[at]!.headingRest = true;
      }
    }
  });
  visit(root, (node, parent) => {
    if (!isHtmlBlock(node, parent)) return;
    const { start, end } = lineRange(lines, node.position!);
    for (let index = start; index <= end; index++) lines[index]!.html = true;
  });
  markSetextHeadings(lines);

  return lines.map(({ text, fenced, delimiter, commented, visible, masked, heading, headingRest }) => ({
    text,
    fenced,
    delimiter,
    commented,
    visible: fenced || delimiter ? (delimiter ? "" : text) : visible,
    masked,
    headingRest,
    ...(heading ? { heading } : {}),
  }));
}

/** The final source line belonging to the heading opened at `at`. */
export function headingEnd(lines: readonly ScannedLine[], at: number): number {
  let end = at;
  while (lines[end + 1]?.headingRest) end += 1;
  return end;
}

/**
 * A raw HTML block node — one the render shows as raw text, hiding any Markdown structure inside.
 * Inline tags (parented by a paragraph or heading) and comments hide no section.
 */
const isHtmlBlock = (node: MarkdownNode, parent?: MarkdownNode): boolean =>
  node.type === "html" &&
  node.position !== undefined &&
  !node.value?.startsWith("<!--") &&
  !/^<![a-z]/.test(node.value ?? "") &&
  ["root", "listItem", "blockquote"].includes(parent?.type ?? "");

/**
 * The Markdown AST identifies raw HTML blocks; inline tags and comments do not hide a section.
 *
 * Both the recursive-descent parser and {@link visit} recurse once per nesting level with no depth
 * cap, same as {@link scanMarkdown} — a pathologically nested description can overflow the stack.
 * Fall back to "no HTML block" rather than crash the process on that one description's structure.
 */
export function htmlBlockLines(source: string): boolean[] {
  const lines = lineRecords(source);
  try {
    const root = fromMarkdown(source) as unknown as MarkdownNode;
    const inHtml = lines.map(() => false);
    visit(root, (node, parent) => {
      if (!isHtmlBlock(node, parent)) return;
      const { start, end } = lineRange(lines, node.position!);
      for (let index = start; index <= end; index++) inHtml[index] = true;
    });
    return inHtml;
  } catch {
    return lines.map(() => false);
  }
}

/** The source prefix a closer needs to remain inside a list item or blockquote. */
function closerPrefix(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  let rest = source.slice(lineStart, offset);
  let prefix = "";
  // Visual columns, not source length: CommonMark expands a tab to the next multiple of four, so
  // `-\t` opens an item whose content sits at column 4 — two source characters, four columns.
  // Measuring by source length put the closer outside the item, where it opened a new fence.
  let column = 0;
  let kept = 0;
  const expand = (text: string): string => {
    for (const char of text) {
      column = char === "\t" ? column + (4 - (column % 4)) : column + 1;
    }
    return " ".repeat(column - kept);
  };
  for (;;) {
    if (!rest) return prefix + expand(/^[ \t]*/.exec(source.slice(lineStart))![0]!);
    const match = /^ {0,3}(?:(>)[ \t]?|(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$))/.exec(rest);
    if (!match) return prefix + expand(/^[ \t]*/.exec(rest)![0]!);
    if (match[1]) {
      // A blockquote marker is kept as typed — tabs included, so its width is preserved verbatim.
      prefix += match[0];
      expand(match[0]);
      kept = column;
    } else {
      // A list marker's width must still land in the prefix as spaces, or a later blockquote
      // marker's `kept = column` jump silently discards the indentation it imposed.
      prefix += expand(match[0]);
      kept = column;
    }
    rest = rest.slice(match[0].length);
  }
}

const persistentHtmlCloser = (value: string): string | undefined => {
  const lower = value.toLowerCase();
  if (/^<pre(?:[ \t>]|$)/i.test(value) && !lower.includes("</pre>")) return "</pre>";
  if (/^<script(?:[ \t>]|$)/i.test(value) && !lower.includes("</script>")) return "</script>";
  if (/^<style(?:[ \t>]|$)/i.test(value) && !lower.includes("</style>")) return "</style>";
  if (/^<textarea(?:[ \t>]|$)/i.test(value) && !lower.includes("</textarea>")) return "</textarea>";
  if (value.startsWith("<?") && !value.includes("?>")) return "?>";
  if (value.startsWith("<![CDATA[") && !value.includes("]]>") ) return "]] >".replace(" ", "");
  if (/^<![A-Z]/.test(value) && !value.includes(">")) return ">";
  return undefined;
};

/**
 * A closer for the terminal fenced block, comment, or persistent HTML block. This is deliberately
 * a small editing policy layered on top of the parser's structural result.
 *
 * Same unbounded-recursion exposure as {@link scanMarkdown} — the parser and {@link visit} both
 * recurse per nesting level with no depth cap. Falling back to "no closer needed" leaves the
 * pathological description's writer unedited rather than crashing the process that reads it.
 */
export function unterminatedCloser(source: string): string | undefined {
  try {
    return unterminatedCloserParsed(source);
  } catch {
    return undefined;
  }
}

function unterminatedCloserParsed(source: string): string | undefined {
  const root = fromMarkdown(source) as unknown as MarkdownNode;
  let closer: { offset: number; text: string } | undefined;
  visit(root, (node) => {
    const position = node.position;
    if (!position || position.end.offset !== source.length) return;
    const offset = position.start.offset ?? 0;
    if (node.type === "code") {
      const openerLine = source.slice(offset).split(/\r?\n/, 1)[0]!;
      const opener = openingFence(openerLine);
      if (opener) {
        const last = source.slice(source.lastIndexOf("\n") + 1);
        // The AST reports "ends at EOF" even for a fence that closed cleanly and simply happens to
        // be the document's last content — a wide list item's closer still carries the container's
        // indentation, which the raw final line keeps but a bare `closingFence` check rejects
        // outright (CommonMark's fence marker allows only 0-3 leading columns). Strip the opener's
        // own container prefix the same way scanMarkdown does before judging the terminal line.
        const lineStart = source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
        const prefix = fenceContainerPrefix(source.slice(lineStart, offset));
        // A top-level fence carries no container, so its closer is judged as-is — stripping here
        // regardless of `prefix` would treat a literal list/quote-shaped content line (`- ~~~`) as
        // the closer it merely resembles, closing the fence early on content it never opened inside.
        const directCloser = prefix.length > 0 ? stripContainerMarkers(last) : last;
        const continuationCloser = prefix.length > 0 ? (peelClosurePrefix(last, prefix) ?? "") : "";
        if (!closingFence(directCloser, opener) && !closingFence(continuationCloser, opener)) {
          closer = { offset, text: fenceCloser(openerLine) };
        }
      }
    }
    if (node.type === "html" && node.value?.startsWith("<!--") && !node.value.endsWith("-->")) {
      closer = { offset, text: "-->" };
    }
    if (node.type === "html" && node.value) {
      const text = persistentHtmlCloser(node.value);
      if (text) closer = { offset, text };
    }
  });
  if (!closer) {
    const lines = scanMarkdown(source);
    const inHtml = htmlBlockLines(source);
    const codeSpans: { start: number; end: number }[] = [];
    visit(root, (node) => {
      if (node.type === "inlineCode" && node.position) {
        codeSpans.push({ start: node.position.start.offset!, end: node.position.end.offset! });
      }
    });
    const inCode = (at: number) => codeSpans.some((span) => at >= span.start && at < span.end);
    let commentOffset: number | undefined;
    let commentOpen = false;
    let fence: { offset: number; opener: string } | undefined;
    let offset = 0;
    for (const [lineIndex, line] of lines.entries()) {
      const fenced = line.fenced;
      let at = 0;
      // Raw HTML hides Markdown structure — a `<!--` inside `<script>`/`<style>`/etc. is literal
      // content, not a comment opener, just as the fence fallback above already skips these lines.
      while (!fenced && !inHtml[lineIndex]) {
        if (commentOpen) {
          const end = line.text.indexOf("-->", at);
          if (end === -1) break;
          at = end + 3;
          commentOpen = false;
          commentOffset = undefined;
          continue;
        }
        let start = line.text.indexOf("<!--", at);
        while (start !== -1 && inCode(offset + start)) start = line.text.indexOf("<!--", start + 4);
        if (start === -1) break;
        commentOpen = true;
        commentOffset = offset + start;
        at = start + 4;
      }
      // A fence's interior content (fenced but not itself a delimiter) is already accounted for by
      // the AST; only delimiter lines — including an unterminated opener the primary pass above
      // couldn't reach because its container closed the construct early — feed this scan.
      const candidate =
        (!fenced || line.delimiter) && !line.commented && !inHtml[lineIndex] ? openingFence(line.text) : undefined;
      if (candidate) {
        if (fence && closingFence(line.text, openingFence(fence.opener)!)) fence = undefined;
        else fence = { offset, opener: line.text };
      }
      offset += line.text.length + (source.startsWith("\r\n", offset + line.text.length) ? 2 : 1);
    }
    if (commentOpen && commentOffset !== undefined) closer = { offset: commentOffset, text: "-->" };
    else if (fence) closer = { offset: fence.offset, text: fenceCloser(fence.opener) };
  }
  return closer && closerPrefix(source, closer.offset) + closer.text;
}

export function renderedLines(raw: string): RenderedLine[] {
  return scanMarkdown(raw)
    .filter((line) => !line.delimiter)
    .map((line) => ({
      text: line.visible,
      fenced: line.fenced,
      heading: line.heading !== undefined || line.headingRest,
    }));
}

/** Remove blockquote punctuation for the contract's TODO-placeholder policy. */
export function unquote(text: string): string {
  let out = text;
  while (BLOCKQUOTE.test(out)) out = out.replace(BLOCKQUOTE, "");
  return out;
}
