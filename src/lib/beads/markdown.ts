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
const BLOCK_LINE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)|^ {0,3}>|^ {0,3}#{1,6}(?:[ \t]|$)|^ {4}/;
const HTML_BLOCK_LINE = /^ {0,3}<(?:pre|script|style|textarea)(?:[ \t>]|$)|^ {0,3}<(?:div|address|article|aside|blockquote|body|section|table|ul|ol|li|p)(?:[ \t>]|\/>|$)|^ {0,3}(?:<!--|<\?|<!\[CDATA\[|<![A-Z])/i;

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
  line.visible.trim() !== "" &&
  !THEMATIC_BREAK.test(line.text) &&
  !BLOCK_LINE.test(line.text) &&
  !HTML_BLOCK_LINE.test(line.masked);

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
 */
export function scanMarkdown(source: string): ScannedLine[] {
  const lines = lineRecords(source);
  const root = fromMarkdown(source) as unknown as MarkdownNode;

  visit(root, (node) => {
    if (!node.position) return;
    if (node.type === "code") {
      const { start, end } = lineRange(lines, node.position);
      // The legacy line projection deliberately leaves container-owned fences to rework-contract,
      // which peels the list/quote syntax before copying that example.
      const opening = openingFence(lines[start]?.text ?? "");
      if (!opening) return; // Indented code is not a fenced literal for the contract.
      for (let index = start; index <= end; index++) lines[index]!.fenced = true;
      lines[start]!.delimiter = true;
      const closing = lines[end]?.text.slice(end === start ? node.position.start.column - 1 : 0) ?? "";
      if (end !== start && closingFence(closing, opening)) lines[end]!.delimiter = true;
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
        paragraphLine(lines[start + offset + 1]!),
      ).every(Boolean);
      if (line && !line.fenced && !line.commented && (end === start || uninterrupted)) {
        line.heading = { depth: node.depth!, key: slug(textOf(node).replace(/<!--.*$/, "")) };
        for (let at = start + 1; at <= end; at++) lines[at]!.headingRest = true;
      }
    }
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

/** The Markdown AST identifies raw HTML blocks; inline tags and comments do not hide a section. */
export function htmlBlockLines(source: string): boolean[] {
  const lines = lineRecords(source);
  const root = fromMarkdown(source) as unknown as MarkdownNode;
  const inHtml = lines.map(() => false);
  visit(root, (node, parent) => {
    if (
      node.type !== "html" ||
      !node.position ||
      node.value?.startsWith("<!--") ||
      (/^<![a-z]/.test(node.value ?? "")) ||
      !["root", "listItem", "blockquote"].includes(parent?.type ?? "")
    ) {
      return;
    }
    const { start, end } = lineRange(lines, node.position);
    for (let index = start; index <= end; index++) inHtml[index] = true;
  });
  return inHtml;
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
      expand(match[0]);
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
 */
export function unterminatedCloser(source: string): string | undefined {
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
        if (!closingFence(last, opener)) closer = { offset, text: fenceCloser(openerLine) };
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
    for (const line of lines) {
      const fenced = line.fenced;
      let at = 0;
      while (!fenced) {
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
      const candidate = openingFence(line.text);
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
