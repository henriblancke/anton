/**
 * Dead code that has callers is not dead (anton-23xe). stringer's `deadcode` collector resolves
 * references from the source it walks, and it does not follow every one: all ten `unused-function`
 * signals in the 2026-08-17 scan named a symbol with real call sites — `withOperator` has three,
 * `getRunById` two, the gardener fixture's helpers one suite each — every caller in a test file the
 * collector skipped. Each one still cost the health record a debt point and each triage pass the
 * judgment to re-derive that it was wrong.
 *
 * So a deadcode signal is checked against the tree before anyone counts it, in the same seam that
 * drops findings about untracked files (lib/stringer) — before annotation, so the health record and
 * the triage prompt see one set rather than one counting what the other dropped.
 *
 * The check is `git grep`, not a parse: the question is only whether the symbol is written outside
 * the file that declares it, and the index already knows which files to read without walking
 * `node_modules` or a build dir. Grep sees text, so hits are read against the prose around them —
 * a name in a comment or a doc is being described, not called, and this module's own docblock would
 * otherwise keep the symbols it names alive forever. Prose is judged in the file's own language,
 * and by where the symbol sits rather than how its line begins: the middle of a block carries no
 * marker, a comment opened after code carries one the line start never shows, and `;` opens a
 * comment in Lisp but guards a real call in TypeScript. Conservative in the direction that matters
 * — a tree anton cannot search, or a file it cannot read, drops nothing, so an unsearchable repo
 * over-reports rather than deleting a finding nobody hears about again.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { promisify } from "node:util";
import { collectorOf, type ScanSignal } from "./scan-severity";

const execFileAsync = promisify(execFile);

/** The collector these rules are about; every other signal rides through untouched. */
const DEADCODE_COLLECTOR = "deadcode";

/**
 * How many distinct symbols one pass will search for. A scan carrying more than this is a repo
 * anton has never scanned before (a whole-repo baseline pass), and the budget bounds what a nightly
 * spends on it. Hitting it means "not checked", so the signals past it keep their place — reported,
 * not silently dropped, and counted in the filter's diagnostics so a truncated pass can't be read
 * as a verified one.
 */
export const SYMBOL_BUDGET = 200;

/**
 * 30s, for the same reason `git ls-files` gets it in lib/stringer: `git grep` over an indexed tree
 * returns in well under a second, so anything near this is git stuck (stale lock, dead NFS mount)
 * and should surface fast rather than hold the scan slot.
 */
const GREP_TIMEOUT_MS = 30_000;

/**
 * stringer's phrasing for every deadcode kind it emits: `Unused function: onWrite`,
 * `Unused type: ScanPass`. The symbol is the whole claim — without it there is nothing to check, so
 * a title anton can't read leaves the signal exactly as stringer wrote it.
 */
const UNUSED_TITLE = /^\s*unused\s+[\w-]+\s*:\s*([A-Za-z_$][\w$]*)/i;

/**
 * Files that are prose by construction. A symbol named in documentation is being described, not
 * called, and a doc outliving its code is the ordinary case rather than evidence the code is live.
 * `.mdx` is not one of them: it imports and renders components, so it is read as code below.
 */
const PROSE_FILE = /\.(?:md|markdown|txt|rst|adoc|org)$/i;

/**
 * A line opening with a comment marker in *some* language, for a file whose language anton has no
 * grammar for below. It is the union across languages, so a marker one language doesn't share is
 * still read as prose — `;` is a Lisp comment and an ASI guard, and without knowing the file this
 * has to assume the reading that keeps a signal anton cannot disprove. Only the start of the
 * trimmed line is checked, for the same reason; what a line test cannot see — the continuation
 * lines of a block — is `UNKNOWN_SYNTAX` below.
 */
const COMMENT_LINE = /^(?:\/\/|\/\*|\*\/|\*|#|--|;|%|<!--|"""|''')/;

interface CommentSyntax {
  /** Markers that comment out the rest of their line. */
  line: string[];
  /** Delimiter pairs that span lines, opener then closer. */
  block: [string, string][];
  /** Whether an opener met inside an open block nests rather than reading as ordinary text. */
  nested?: boolean;
  /**
   * Whether the block delimiters are only delimiters at the start of a line. Ruby's `=begin` /
   * `=end` are, so `total =begin_of_month` is an assignment rather than a comment that never closes.
   */
  anchored?: boolean;
}

/**
 * Comment grammar by file kind. Judging a hit by how its line begins gets both ends wrong: the
 * middle of a block carries no marker of its own, so `neverCalled was removed later` reads as a
 * call, while a legitimate `;neverCalled()` reads as a Lisp comment. Knowing the language lets a
 * hit be judged where it actually sits. Only the grammars stringer's collectors meet are tracked;
 * a language without one falls back to the union line test above.
 */
interface FileSyntax extends CommentSyntax {
  files: RegExp;
}

const COMMENT_SYNTAX: FileSyntax[] = [
  {
    files: /\.(?:[cm]?[jt]sx?|go|java|c|h|cc|cpp|hpp|cs|css|scss|less|dart|proto)$/i,
    line: ["//"],
    block: [["/*", "*/"]],
  },
  {
    // Rust, Swift, Scala and Kotlin nest block comments: in `/* outer /* inner */ tail */` the
    // first `*/` closes only the inner one. Reading them with the C-like grammar ends the comment
    // early, so `tail` reads as code — a caller that isn't there, deleting a finding that was right.
    files: /\.(?:rs|swift|scala|kt|kts)$/i,
    line: ["//"],
    block: [["/*", "*/"]],
    nested: true,
  },
  {
    // PHP takes `#` as well as `//`, so it can't ride with the C-like languages, where `#` opens a
    // preprocessor directive rather than a comment. A PHP 8 attribute (`#[Route]`) reads as a
    // comment under this — the conservative direction, which keeps a signal rather than deleting it.
    files: /\.(?:php|phtml)$/i,
    line: ["//", "#"],
    block: [["/*", "*/"]],
  },
  {
    files: /\.(?:html?|xml|svg|vue|svelte|astro)$/i,
    line: ["//"],
    block: [
      ["<!--", "-->"],
      ["/*", "*/"],
    ],
  },
  {
    // MDX is a program, not a document: `import { Widget } from './widget'` and `<Widget />` name a
    // real caller. What is inert is the JSX comment; the code spans and fenced examples that also
    // show a symbol rather than calling it are blanked before this by `maskMdxProse`, which reads
    // markdown's fences as fences instead of pairing backticks one at a time. The rest of the body
    // is markdown, so a hit surviving this is judged again by `referencesMdx`.
    //
    // The comment is read as bare `/* */` rather than `{/* */}`: JSX lets the braces stand off
    // (`{ /* Widget was removed */ }`), and a grammar spelled with them attached leaves that span
    // unmasked, where the leading `{` then proves the prose is an expression and erases a true
    // finding. `/*` outside a braced expression is markdown text, so the widened marker can only
    // blank prose — the direction that keeps a signal rather than dropping one.
    //
    // `//` for the same reason: an ESM block and a braced expression are JavaScript, where a
    // `// Widget was removed` sits on a line `mdxOpenLines` has already called executable, and
    // reading that prose as a call erases a true finding. In the markdown body `//` is a URL at
    // worst, and blanking the tail of one only leaves a signal standing.
    files: /\.mdx$/i,
    line: ["//"],
    block: [["/*", "*/"]],
  },
  {
    files: /\.(?:py|pyi)$/i,
    line: ["#"],
    block: [
      ['"""', '"""'],
      ["'''", "'''"],
    ],
  },
  {
    // Ruby's block comment is a pair of line-anchored markers rather than an inline delimiter, and
    // it is the only comment `#` cannot express: without it the continuation lines of a `=begin`
    // block read as code, and prose naming a symbol proves a caller that isn't there.
    files: /\.(?:rb|rake|gemspec)$/i,
    line: ["#"],
    block: [["=begin", "=end"]],
    anchored: true,
  },
  {
    // SQL's line comment is `--`, which the unknown-language fallback cannot read: `--` is as often
    // a decrement operator, so it is only a marker where the file says so. Without this grammar a
    // trailing `-- neverCalled was removed` reads as a call and deletes a true finding. Blocks are
    // read as nesting because PostgreSQL nests them; a dialect that doesn't only ends up holding a
    // comment open longer, which leaves a signal standing rather than dropping one.
    files: /\.(?:sql|psql|pgsql|ddl)$/i,
    line: ["--"],
    block: [["/*", "*/"]],
    nested: true,
  },
  {
    files: /\.(?:sh|bash|zsh|ya?ml|toml)$/i,
    line: ["#"],
    block: [],
  },
];

/**
 * The grammar for a file whose language anton tracks none for. Line comments stay with the union
 * line test above, read only at the start of a line, because `;` and `--` end statements in as many
 * languages as they open comments in. What needs real state is the block: a symbol named on a
 * continuation line of an open `/*` in a `.sql` file carries no marker of its own, so a line test
 * reads it as a call and deletes a finding that was right. The pairs are the union across
 * languages — a delimiter one of them doesn't share still opens a comment, and every mistake in
 * that direction ends in "this hit is prose", which leaves a signal standing rather than dropping
 * one.
 */
const UNKNOWN_SYNTAX: CommentSyntax = {
  line: [],
  block: [
    ["/*", "*/"],
    ["<!--", "-->"],
  ],
};

/** The grammar to read a file with, or undefined when anton tracks none for its language. */
function commentSyntaxOf(file: string): FileSyntax | undefined {
  return COMMENT_SYNTAX.find((syntax) => syntax.files.test(file));
}

/** The first comment starting at or after `from`, whichever kind opens earliest. */
function nextComment(
  line: string,
  from: number,
  syntax: CommentSyntax,
): { at: number; marker: string; closer?: string } | undefined {
  let found: { at: number; marker: string; closer?: string } | undefined;
  for (const marker of syntax.line) {
    const at = line.indexOf(marker, from);
    if (at >= 0 && (!found || at < found.at)) found = { at, marker };
  }
  for (const [opener, closer] of syntax.block) {
    const at = syntax.anchored ? (line.startsWith(opener) ? 0 : -1) : line.indexOf(opener, from);
    if (at >= from && (!found || at < found.at)) found = { at, marker: opener, closer };
  }
  return found;
}

/** The line with its comment spans replaced by spaces — same length, so offsets still line up. */
function blankSpans(line: string, spans: [number, number][]): string {
  if (spans.length === 0) return line;
  let out = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    out += line.slice(cursor, start) + " ".repeat(end - start);
    cursor = end;
  }
  return out + line.slice(cursor);
}

/** A block comment open across lines, and how deep its openers are stacked. */
interface OpenBlock {
  opener: string;
  closer: string;
  depth: number;
}

/**
 * Where the open block ends on this line, and whether it ended at all. In a nesting language an
 * opener met inside the block pushes a level, so only the closer matching the OUTERMOST opener ends
 * the comment — without the count, the first closer releases the rest of the outer comment to be
 * read as code.
 */
function closeBlock(
  line: string,
  from: number,
  open: OpenBlock,
  nested: boolean,
  anchored: boolean,
): { at: number; closed: boolean } {
  // A line-anchored closer ends the comment only as the line's first token, and the rest of that
  // line is the comment's too — Ruby ignores whatever trails `=end`.
  if (anchored) {
    return from === 0 && line.startsWith(open.closer)
      ? { at: line.length, closed: true }
      : { at: line.length, closed: false };
  }
  let at = from;
  while (at < line.length) {
    const nestAt = nested ? line.indexOf(open.opener, at) : -1;
    const endAt = line.indexOf(open.closer, at);
    if (endAt < 0 && nestAt < 0) break;
    if (nestAt >= 0 && (endAt < 0 || nestAt < endAt)) {
      open.depth += 1;
      at = nestAt + open.opener.length;
      continue;
    }
    open.depth -= 1;
    at = endAt + open.closer.length;
    if (open.depth === 0) return { at, closed: true };
  }
  return { at: line.length, closed: false };
}

/**
 * The file's lines with every comment blanked out, so a hit is read against the code actually left
 * on its line. The scan is textual: a delimiter inside a string literal opens a block that isn't
 * there, and a `//` inside a URL comments out the rest of its line. Every such mistake ends in
 * "this hit is prose", which leaves a signal standing rather than deleting one.
 */
function maskComments(text: string, syntax: CommentSyntax): string[] {
  let open: OpenBlock | undefined;
  return text.split("\n").map((line) => {
    const spans: [number, number][] = [];
    let at = 0;
    while (at < line.length) {
      if (open) {
        const { at: end, closed } = closeBlock(
          line,
          at,
          open,
          syntax.nested === true,
          syntax.anchored === true,
        );
        spans.push([at, end]);
        at = end;
        if (closed) open = undefined;
        continue;
      }
      const opened = nextComment(line, at, syntax);
      if (!opened) break;
      if (!opened.closer) {
        spans.push([opened.at, line.length]);
        break;
      }
      spans.push([opened.at, opened.at + opened.marker.length]);
      at = opened.at + opened.marker.length;
      open = { opener: opened.marker, closer: opened.closer, depth: 1 };
    }
    return blankSpans(line, spans);
  });
}

/**
 * Word characters as `git grep -w` counts them, plus the two grep breaks a word on that a
 * JavaScript identifier is spelled with: `$mount`, `mount$` and `this.#mount` are names of their
 * own, not the symbol `mount`. Reading grep's boundaries literally makes any of them a caller and
 * deletes a true finding; counting them as word characters can only leave standing a signal anton
 * failed to disprove, which is the direction this filter errs in everywhere else.
 */
const WORD_CHAR = /[0-9A-Za-z_$#]/;

/**
 * Whether the line still writes the symbol as a whole word once its comments are blanked out.
 * `isCode` narrows a whole-word hit further by what precedes it on the line, for a file whose
 * comments are not the only thing on it that isn't code.
 */
function referencesWord(
  line: string | undefined,
  symbol: string,
  isCode?: (head: string) => boolean,
): boolean {
  if (line === undefined) return false;
  for (let at = line.indexOf(symbol); at >= 0; at = line.indexOf(symbol, at + 1)) {
    const before = at > 0 ? line[at - 1] : "";
    const after = line[at + symbol.length] ?? "";
    if (WORD_CHAR.test(before) || WORD_CHAR.test(after)) continue;
    if (!isCode || isCode(line.slice(0, at))) return true;
  }
  return false;
}

/** Files read as MDX — markdown prose around code that runs. */
const MDX_FILE = /\.mdx$/i;

/** MDX's ESM block: the only place an import or export can stand. */
const MDX_ESM_LINE = /^\s*(?:import|export)\b/;

/**
 * An ESM statement as JavaScript spells one, rather than a paragraph opening with the word
 * `export`. `MDX_ESM_LINE` can afford to be loose — a prose line it reads as code only leaves a
 * signal standing — but leaving a line's backticks unmasked runs the other way: unmasking the span
 * in ``export the `Widget` helper`` would let that sentence prove a caller and delete a true
 * finding. So the keyword has to be followed by something markdown prose does not put there.
 */
const MDX_ESM_STATEMENT =
  /^\s*(?:import\s*(?:[({*'"]|type\b)|import\s+[A-Za-z_$][\w$]*\s*(?:,|from\b)|export\s+(?:default\b|type\b|\*|\{|const\b|let\b|var\b|class\b|(?:async\s+)?function\b))/;

/**
 * A markdown fence, opening or closing: up to three spaces of indent, then a run of three or more
 * backticks or tildes, then the info string. Fences are the delimiter a code example actually
 * carries, and pairing backticks one at a time cannot see one — `~~~~tsx` holds no backtick at all
 * and an even-length ```` ```` ```` pairs off against itself, leaving `<Widget />` in the example
 * looking like a rendered tag and erasing a finding that was right.
 */
const MDX_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** The whole line replaced by spaces — same length, so a hit's offsets still line up. */
function blankAll(line: string): string {
  return " ".repeat(line.length);
}

/** The index just past the run of backticks starting at `at`. */
function backtickRunEnd(line: string, at: number): number {
  let end = at;
  while (line[end] === "`") end += 1;
  return end;
}

/** Where the run of exactly `length` backticks that closes a code span ends, if one does. */
function closingBacktickRun(line: string, from: number, length: number): number | undefined {
  let at = from;
  while (at < line.length) {
    const next = line.indexOf("`", at);
    if (next < 0) break;
    const end = backtickRunEnd(line, next);
    if (end - next === length) return end;
    at = end;
  }
  return undefined;
}

/**
 * The line with its inline code spans blanked, and the expression depth it leaves for the line
 * below. A span opens on a run of backticks and closes on the next run of the same length, so
 * ``` ``<Widget />`` ``` is one span rather than two bare pairs with live code between them. An
 * unopened-looking run — one nothing closes — is blanked to the end of the line: over-blanking
 * hides a caller and leaves a signal standing, which is the direction this filter errs in
 * everywhere.
 *
 * A backtick inside an open braced expression is a template literal rather than a code span: MDX
 * runs `` {`${Widget()}`} ``, so blanking it would hide a real caller. Braces inside a blanked span
 * don't count — a `{` shown in an example opens nothing.
 */
function maskMdxCodeSpans(line: string, depth = 0): { masked: string; depth: number } {
  const spans: [number, number][] = [];
  let at = 0;
  while (at < line.length) {
    const char = line[at];
    if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
    else if (char === "`") {
      const openEnd = backtickRunEnd(line, at);
      if (depth > 0) {
        at = openEnd;
        continue;
      }
      const close = closingBacktickRun(line, openEnd, openEnd - at);
      spans.push([at, close ?? line.length]);
      if (close === undefined) break;
      at = close;
      continue;
    }
    at += 1;
  }
  return { masked: blankSpans(line, spans), depth };
}

/**
 * An MDX file with everything markdown holds out of the program blanked: fenced code blocks and
 * inline code spans. Both show a symbol rather than calling it, and both have to be read as
 * markdown spells them — a fence runs from its opening run of backticks or tildes to the first line
 * closing it with at least as many of the same character, whatever sits in between.
 *
 * Indented code blocks are not read, because MDX does not have them: indentation there is JSX and
 * ESM continuation, and blanking it would hide the wrapped caller `mdxOpenLines` exists to find.
 */
function maskMdxProse(text: string): string {
  let fence: string | undefined;
  let esm = false;
  let depth = 0;
  return text
    .split("\n")
    .map((line) => {
      const marker = MDX_FENCE.exec(line);
      if (fence !== undefined) {
        const closes =
          marker !== null &&
          marker[1].startsWith(fence[0]) &&
          marker[1].length >= fence.length &&
          marker[2].trim() === "";
        if (closes) fence = undefined;
        return blankAll(line);
      }
      // A backtick fence's info string cannot itself hold a backtick: ``` ```a` ``` is an inline
      // span, not a fence, and opening one there would blank the rest of the file.
      if (marker && (marker[1].startsWith("~") || !marker[2].includes("`"))) {
        fence = marker[1];
        return blankAll(line);
      }
      // A backtick inside an ESM statement opens a template literal, not a markdown code span, so
      // the interpolation in ``export const meta = `${Widget()}` `` names a real caller. The block
      // runs to the next blank line — the bound `mdxOpenLines` reads it with — so a template
      // literal spanning lines stays code for as long as the statement holding it does. A braced
      // expression holds a template literal open the same way, carried line to line as depth and
      // closed by the same blank line.
      if (!line.trim()) {
        esm = false;
        depth = 0;
      } else if (!esm && MDX_ESM_STATEMENT.test(line)) {
        esm = true;
        depth = 0;
      }
      if (esm) return line;
      const span = maskMdxCodeSpans(line, depth);
      depth = span.depth;
      return span.masked;
    })
    .join("\n");
}

/**
 * A tag opening right where the symbol starts — `<Widget`, `</Widget`, `<UI.Widget`. The member
 * prefix counts because JSX resolves `<UI.Widget />` to the same binding a bare tag would: a page
 * that imports a namespace and renders through it may name the symbol nowhere else, and reading
 * that tag as prose reports a rendered component dead.
 */
const TAG_HEAD = /<\/?\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)*$/;

/** The quotes JavaScript writes a string or a template literal with. */
const QUOTE = /["'`]/;

/**
 * The characters of `text` that punctuate a program, with the contents of its strings and template
 * literals skipped. A quoted brace is text rather than a delimiter: `{ready ? "}" : Widget()}` runs
 * to the brace its punctuation closes on, and counting the quoted one ends the expression a line
 * early, so the call under it reads as prose and the caller it names goes uncounted.
 *
 * `inCode` is asked per character, because the depth it answers from moves as the scan runs. A
 * quote only delimits inside code — in prose an apostrophe is an apostrophe, and reading one as a
 * string would swallow the braces of the expression behind it and hand the rest of the line back
 * to the markup rules.
 */
function* punctuation(text: string, inCode: () => boolean): Generator<string> {
  let quote: string | undefined;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quote !== undefined) {
      if (char === "\\") at += 1;
      else if (char === quote) quote = undefined;
    } else if (inCode() && QUOTE.test(char)) quote = char;
    else yield char;
  }
}

/**
 * Whether the text before the symbol leaves a braced expression open, counting from the depth the
 * lines above left open. An expression closes on the line that opened it unless a caller tracked
 * that depth — `<p>{version} Widget was removed</p>` renders `Widget` as text once `}` has run —
 * so treating any earlier `{` on the line as still open reads that prose as code, calls the page a
 * caller, and deletes a true finding about a genuinely unused symbol.
 */
function insideExpression(head: string, depth = 0): boolean {
  for (const char of punctuation(head, () => depth > 0)) {
    if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

/**
 * Which lines of an MDX file start inside a block that is still executing — an expression or an
 * ESM statement left open by an earlier line. Both shapes wrap: `{` on its own line with `Widget()`
 * under it, or a named import spread over three. Judging each line alone reads those continuations
 * as markdown and misses the caller they name, which is how a live component keeps costing the
 * health record a debt point.
 *
 * A blank line closes whatever is open. MDX separates its blocks that way, so an unbalanced brace
 * in prose can only mislead its own paragraph rather than every line below it — the bound that
 * matters, since reading prose as code is what deletes a true finding. An expression whose braces
 * really do span the blank line loses its depth here and the caller under it goes uncounted: that
 * costs one signal that stands, where trusting the brace costs findings across the rest of the
 * file, so the bound is kept deliberately.
 *
 * That blank line is the only thing that closes the ESM block, because it is the only thing MDX
 * itself closes one with: an `import`/`export` block runs to the next empty line and is parsed
 * whole. Ending it on its opening line instead — whenever that line balanced its delimiters, or
 * carried none — reads `export default` with `Widget()` under it as markdown and misses the caller.
 *
 * Blankness is read from `raw`, the file before masking: a line masking emptied held a comment
 * inside the block, not the empty line MDX ends a block at, and closing on it drops the rest of an
 * `export const meta = {` back to markdown.
 */
function mdxOpenLines(code: string[], raw: string[]): boolean[] {
  const open: boolean[] = [];
  let depth = 0;
  let esm = false;
  for (const [index, line] of code.entries()) {
    open.push(depth > 0 || esm);
    if (!raw[index]?.trim()) {
      depth = 0;
      esm = false;
      continue;
    }
    if (depth === 0 && !esm && MDX_ESM_LINE.test(line)) esm = true;
    for (const char of punctuation(line, () => depth > 0 || esm)) {
      // Only braces hold an expression open; an import's list can also wrap in `(` or `[`, which
      // are ordinary punctuation in the markdown around it.
      if (char === "{" || (esm && (char === "(" || char === "["))) depth += 1;
      else if (char === "}" || (esm && (char === ")" || char === "]")))
        depth = Math.max(0, depth - 1);
    }
  }
  return open;
}

/**
 * Whether an MDX line uses the symbol or merely names it. MDX executes three shapes — an
 * `import`/`export` statement, a JSX tag, and a braced expression — and everything else in the file
 * is markdown, where a name is being described. Discounting the whole file instead (as `PROSE_FILE`
 * once did) throws away the import that renders a component, and the signal about a live component
 * goes on costing the health record a debt point every night.
 *
 * `open` is the same three shapes seen from the line above: inside one of them the whole line is
 * code, so nothing more has to precede the symbol on it.
 */
function referencesMdx(line: string | undefined, symbol: string, open = false): boolean {
  if (line !== undefined && (open || MDX_ESM_LINE.test(line))) return referencesWord(line, symbol);
  return referencesWord(line, symbol, (head) => TAG_HEAD.test(head) || insideExpression(head));
}

/**
 * Files read as markup — HTML and the single-file component formats built on it. Comment masking
 * blanks what `<!-- -->` hides and nothing else, so `<p>neverCalled was removed</p>` survives it
 * intact and reads as a call: a committed doc page or template would then delete a true finding
 * about a genuinely unused symbol. Their text is judged like MDX's markdown instead.
 */
const MARKUP_FILE = /\.(?:html?|xml|svg|vue|svelte|astro)$/i;

/** Astro puts its module in a `---` fence at the top of the file, above any markup. */
const ASTRO_FILE = /\.astro$/i;
const ASTRO_FENCE = /^---\s*$/;

/** A `<script>` or `</script>` tag, with whatever attributes it carries (`<script lang="ts">`). */
const SCRIPT_TAG = /<(\/?)script\b[^>]*?(\/?)>/gi;

/** The same for `<style>`, whose braces are CSS rather than the template's interpolations. */
const STYLE_TAG = /<(\/?)style\b[^>]*?(\/?)>/gi;

/**
 * The framework directive prefixes that introduce a binding: Svelte's `use:enhance`, Vue's
 * `v-on:click`. Only the known prefixes count — accepting any `word:` would read `the helper:
 * neverCalled ran nightly` as a call.
 */
const DIRECTIVE = String.raw`(?:use|on|bind|transition|in|out|animate|class|style|slot|v-[\w-]+)`;

/**
 * A directive taking a bare binding rather than a braced one: `<form use:enhance>` and
 * `<b v-on:click=go>` name a real caller with no other code around them.
 */
const DIRECTIVE_HEAD = new RegExp(String.raw`(?:^|[\s"'])${DIRECTIVE}:\s*$`);

/**
 * An attribute that carries code rather than content — a handler, a framework directive, a dynamic
 * bind: `onclick`, `v-if`, `@click`, `bind:value`, Angular's `[prop]` and `(event)`.
 */
const CODE_ATTR = String.raw`(?:on[a-z]+|v-[\w-]+|${DIRECTIVE}:[\w.-]*|[@:#][\w.-]+|\([\w.-]+\)|\[[\w.-]+\])`;

/**
 * Inside the quoted value of a code-carrying attribute, opened on this line — `onclick="go()"`,
 * `@click='go'`, `v-if="ready"`, `bind:value="widget"`, `[prop]="widget"`. An ordinary attribute
 * holds content rather than a binding, so `<div title="Widget was removed">` names the symbol the
 * way the text between the tags does: counting every attribute would let a committed page prove its
 * own caller and delete a true finding.
 */
const ATTR_VALUE = new RegExp(String.raw`(?:^|[\s"'])${CODE_ATTR}\s*=\s*["'][^"']*$`, "i");

/**
 * The same attribute with its value left unquoted — `<button onclick=Widget()>` is HTML a browser
 * runs, and the symbol starts right at the `=`. Only whitespace may precede the name: inside a
 * quoted value an `onclick=` is text a reader sees rather than a binding the page carries.
 */
const ATTR_VALUE_BARE = new RegExp(String.raw`(?:^|\s)${CODE_ATTR}\s*=\s*$`, "i");

/** Where a line is program text rather than markup, as `[start, end)` offsets into that line. */
type CodeSpans = [number, number][];

/**
 * Which spans of a markup file are program text rather than markup: the body of a `<script>`
 * element, or an Astro frontmatter block. Those are where a component gets imported, so judging
 * them by markup's rules would miss the import that proves the symbol live.
 *
 * Spans rather than whole lines, because an element can share its line with rendered text:
 * `<p>Widget was removed</p><script>go()</script>` runs only between the tags, and calling the
 * whole line executable lets the prose beside the script prove a caller and delete a true finding.
 *
 * Read from the masked lines, so a `<script>` shown inside a comment opens nothing.
 */
function markupCodeSpans(code: string[], file: string): CodeSpans[] {
  const frontmatterEnd = ASTRO_FILE.test(file) ? astroFrontmatterEnd(code) : -1;
  const scripts = elementBodySpans(code, SCRIPT_TAG, frontmatterEnd + 1);
  return code.map((line, index) =>
    index <= frontmatterEnd ? [[0, line.length]] : (scripts[index] ?? []),
  );
}

/**
 * Where each line sits inside the body of `tag` — the program a `<script>` holds, the CSS a
 * `<style>` holds. Both are the element's own language rather than the template's, so the markup
 * rules stop at their tags.
 */
function elementBodySpans(code: string[], tag: RegExp, from = 0): CodeSpans[] {
  const lines: CodeSpans[] = [];
  let open = false;
  for (const [index, line] of code.entries()) {
    if (index < from) {
      lines.push([]);
      continue;
    }
    const spans: CodeSpans = [];
    // A body an earlier line left open runs from the start of this one; a body this line opens
    // runs from the end of its tag, and an unclosed one carries on into the line below.
    let start: number | undefined = open ? 0 : undefined;
    for (const match of line.matchAll(tag)) {
      const [opener, closing, selfClosing] = match;
      if (closing === "/") {
        if (start !== undefined) spans.push([start, match.index]);
        start = undefined;
      } else if (start === undefined && selfClosing !== "/") {
        start = match.index + opener.length;
      }
    }
    if (start !== undefined) spans.push([start, line.length]);
    open = start !== undefined;
    lines.push(spans);
  }
  return lines;
}

/**
 * How deep a braced expression is left open at the start of each markup line. A template
 * interpolation wraps — `<div>{{` with `Widget()` on the line under it — and judging that line
 * alone finds no brace before the symbol, so a binding the template really invokes reads as
 * rendered text and its signal goes on costing the health record a debt point. MDX carries the
 * same state across its lines for the same reason.
 *
 * Braces inside a `<script>` or `<style>` body don't count: an object literal or a CSS rule is the
 * element's own punctuation, not an interpolation, and letting one open an expression would read
 * every line below it as code.
 *
 * A blank line closes whatever is open, and blankness is read from `raw` — the file before masking
 * — so a line a comment emptied is not mistaken for the break. That bound is deliberate, as it is
 * in MDX: an unbalanced `{` in rendered text can then only mislead its own block instead of every
 * line after it, and reading prose as code is the direction that deletes a true finding.
 */
function markupOpenDepths(code: string[], script: CodeSpans[], raw: string[]): number[] {
  const style = elementBodySpans(code, STYLE_TAG);
  const depths: number[] = [];
  let depth = 0;
  for (const [index, line] of code.entries()) {
    depths.push(depth);
    if (!raw[index]?.trim()) {
      depth = 0;
      continue;
    }
    const skip = [...(script[index] ?? []), ...(style[index] ?? [])];
    let template = "";
    for (let at = 0; at < line.length; at += 1)
      template += skip.some(([start, end]) => at >= start && at < end) ? " " : line[at];
    for (const char of punctuation(template, () => depth > 0)) {
      if (char === "{") depth += 1;
      else if (char === "}") depth = Math.max(0, depth - 1);
    }
  }
  return depths;
}

/** The last line of the Astro frontmatter fence, or -1 when the file opens with markup. */
function astroFrontmatterEnd(code: string[]): number {
  const open = code.findIndex((line) => line.trim() !== "");
  if (open < 0 || !ASTRO_FENCE.test(code[open] ?? "")) return -1;
  const close = code.findIndex((line, index) => index > open && ASTRO_FENCE.test(line));
  // An unclosed fence is not a module: reading the rest of the file as code would let its markup
  // text prove a caller, which is the direction that deletes a true finding.
  return close;
}

/**
 * Whether a markup line uses the symbol or merely renders it. Outside a script block the file is
 * a template, where only three shapes run: a tag name, the value of a code-carrying attribute, and
 * a braced expression (`{count}` in Svelte and Astro, `{{ count }}` in Vue). Text between the tags
 * — and inside a static attribute — is what the page shows a reader, so a name there describes the
 * symbol rather than calling it.
 *
 * `depth` is how many expressions the lines above left open, so an interpolation that wraps still
 * reads as one on the line the call actually sits on.
 */
function referencesMarkup(
  line: string | undefined,
  symbol: string,
  code: CodeSpans = [],
  depth = 0,
): boolean {
  return referencesWord(line, symbol, (head) => {
    const at = head.length;
    if (code.some(([start, end]) => at >= start && at < end)) return true;
    // Only the markup since the last script body is template: a brace left in the JavaScript
    // beside it is not the `{count}` that would make the text after it an expression. A script
    // between the line's start and the symbol restarts that reading, so the depth carried from
    // above stops there too.
    const from = code.reduce((last, [, end]) => (end <= at ? end : last), 0);
    const markup = head.slice(from);
    return (
      TAG_HEAD.test(markup) ||
      ATTR_VALUE.test(markup) ||
      ATTR_VALUE_BARE.test(markup) ||
      DIRECTIVE_HEAD.test(markup) ||
      insideExpression(markup, from === 0 ? depth : 0)
    );
  });
}

/** Files whose program also renders text: the JSX a `.jsx`/`.tsx` module carries. */
const JSX_FILE = /\.[jt]sx$/i;

/**
 * A tag this line opens and leaves open — `<p>`, `<Panel tone="warn">` — so what follows it is
 * rendered. Not a self-closing `<Icon />`, which renders nothing after itself and leaves the code
 * beside it code, and not a closing `</p>`, which ends the text rather than starting it.
 */
const JSX_OPEN_TAG = String.raw`<[A-Za-z][\w.$:-]*(?:\s[^<>]*)?(?<![/])>`;

/**
 * What a reader sees, with none of the punctuation that would make it program text. A generic
 * closes with the same `>` a tag does — `new Map<string, Widget>()` — so the text after one has to
 * read as a sentence before the line is called rendered, or a real call goes uncounted.
 */
const JSX_TEXT = new RegExp(String.raw`${JSX_OPEN_TAG}[^<>{}()[\]=;\\|&+*/\`]*$`);

/** The symbol inside a plain string prop — `<p title="Widget was removed">` renders that too. */
const JSX_PROP_TEXT = new RegExp(
  String.raw`<[A-Za-z][\w.$:-]*\s[^<>]*[\w-]\s*=\s*(?:"[^"<>{}]*|'[^'<>{}]*)$`,
);

/**
 * Whether a JSX line uses the symbol or merely renders it. A `.jsx`/`.tsx` file is a program, so
 * everything on it is code except what it shows a reader: the text a tag opens, and the value of a
 * plain string prop. `<p>Widget was removed</p>` names the symbol the way a doc page does, and
 * counting that page as a caller deletes a true finding about a genuinely unused symbol.
 *
 * Only text the opening tag leaves on the symbol's own line reads that way. Children wrapped onto
 * lines of their own would need the file's JSX nesting carried across it, and a module's generics,
 * comparisons and arrows cannot be told from tags without a parser: misreading a program's own
 * lines as rendered text drops real callers wholesale, which is the costlier direction in the
 * language this repo is mostly written in. The bound is kept deliberately.
 */
function referencesJsx(line: string | undefined, symbol: string): boolean {
  return referencesWord(line, symbol, (head) => !JSX_TEXT.test(head) && !JSX_PROP_TEXT.test(head));
}

/** One deadcode signal the filter removed, and the proof that removed it. */
export interface DroppedDeadcode {
  /** The file stringer named, as it spelled it. */
  path: string;
  /** The symbol it called unused. */
  symbol: string;
  /** stringer's `Kind` — `unused-function` or `unused-type`. */
  kind: string;
  /** Where the callers are, so the drop can be checked by hand. */
  reason: string;
}

/** What the reference check did to this scan — every drop is surfaced, never silent. */
export interface DeadcodeFilter {
  dropped: DroppedDeadcode[];
  /**
   * Why the tree could not be searched, when it couldn't be. Nothing is dropped in that case: a
   * filter that can't prove a symbol has callers must leave the signal in, so an unsearchable repo
   * under-filters rather than deleting findings.
   */
  unavailable?: string;
  /**
   * How many signals the pass never reached, because the symbol budget ran out mid-scan. They ride
   * through counted — but a truncated pass otherwise reads exactly like a fully verified one, so
   * the diagnostics say how much of the scan the check never saw.
   */
  unchecked?: number;
}

/** The symbol a deadcode signal is about, or undefined when its title doesn't name one. */
function symbolOf(signal: ScanSignal): string | undefined {
  const title = signal.Title ?? signal.title;
  if (typeof title !== "string") return undefined;
  return UNUSED_TITLE.exec(title)?.[1];
}

/**
 * The declaring file spelled the way `git grep` spells its hits: repo-relative, with mid-path
 * traversals collapsed. Undefined when the signal names no file, the repo root, or somewhere
 * outside the repo — an absolute path left absolute would match no hit, so the declaration would
 * survive its own exclusion, read as its own caller, and erase a genuinely dead symbol.
 */
function filePathOf(repoPath: string, signal: ScanSignal): string | undefined {
  const raw = signal.FilePath ?? signal.filePath;
  if (typeof raw !== "string" || !raw) return undefined;
  const rel = isAbsolute(raw) ? relative(repoPath, raw) : normalize(raw);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
  return rel;
}

function kindOf(signal: ScanSignal): string {
  const raw = signal.Kind ?? signal.kind;
  return typeof raw === "string" && raw ? raw : DEADCODE_COLLECTOR;
}

/** The `git grep` hits that could be a reference: the lines to check, by file. */
type CandidateHits = Map<string, number[]>;

/** A file read once and reused across symbols: its comments blanked, plus MDX's cross-line state. */
interface MaskedFile {
  code: string[];
  /** For MDX, which lines start inside a block — an expression or ESM statement — left open above. */
  open?: boolean[];
  /** For markup, where each line is program text: a `<script>` body or an Astro frontmatter line. */
  script?: CodeSpans[];
  /** For markup, how many braced expressions the lines above leave open at each line's start. */
  depth?: number[];
}

/**
 * The hits that survive the cheap prose tests, by file. `git grep -n -z` writes one record per hit
 * as `path\0line\0text\n`, so a file is judged by its hits rather than by appearing in a filename
 * list.
 *
 * Documentation files are discounted here without reading anything — a name written in prose is not
 * a reference. So is a line opening with a comment marker, but only in a file whose language anton
 * has no grammar for: the rest are judged against their own text, where a comment opened mid-line
 * and the middle of a block are both visible and `;` is not mistaken for a marker. An unrecognized
 * file's block comments are still tracked when it is read below.
 *
 * A name inside a string literal or a same-named local declaration still counts: grep cannot tell
 * those from a call, and only a parser could.
 */
function candidateHits(stdout: string): CandidateHits {
  const hits: CandidateHits = new Map();
  for (const record of stdout.split("\n")) {
    const pathEnd = record.indexOf("\0");
    if (pathEnd < 0) continue;
    const textStart = record.indexOf("\0", pathEnd + 1);
    if (textStart < 0) continue;
    const file = normalize(record.slice(0, pathEnd));
    if (PROSE_FILE.test(file)) continue;
    if (!commentSyntaxOf(file) && COMMENT_LINE.test(record.slice(textStart + 1).trimStart()))
      continue;
    const line = Number(record.slice(pathEnd + 1, textStart));
    if (!Number.isInteger(line) || line < 1) continue;
    hits.set(file, [...(hits.get(file) ?? []), line]);
  }
  return hits;
}

/**
 * The files holding at least one hit that still writes the symbol as code once the comments around
 * it are blanked out. A file is read only when it carries a hit — with its own grammar when anton
 * tracks one, and with the union fallback when it doesn't, since an unrecognized extension is no
 * reason to read the middle of a block comment as a call. The masked text is cached across symbols
 * because one busy file answers for many of them.
 *
 * A file anton cannot read proves nothing: without its text there is no evidence the hit is a call,
 * and an unproven caller must not delete a finding.
 */
async function codeReferencingFiles(
  repoPath: string,
  symbol: string,
  hits: CandidateHits,
  masked: Map<string, MaskedFile | undefined>,
  abort?: AbortSignal,
): Promise<string[]> {
  const files: string[] = [];
  for (const [file, lines] of hits) {
    // The reads are the rest of the check once grep has answered, and a busy symbol has many of
    // them: a job cancelled here must stop rather than read out the list it no longer owes anyone.
    abort?.throwIfAborted();
    const syntax = commentSyntaxOf(file) ?? UNKNOWN_SYNTAX;
    const isMdx = MDX_FILE.test(file);
    const isMarkup = !isMdx && MARKUP_FILE.test(file);
    const isJsx = !isMdx && !isMarkup && JSX_FILE.test(file);
    if (!masked.has(file)) {
      try {
        const text = await readFile(join(repoPath, file), { encoding: "utf8", signal: abort });
        // MDX's markdown — its fences and code spans — is blanked before the JSX comment grammar
        // runs, so a `/*` or `//` shown inside an example can't open a comment across the program.
        const code = maskComments(isMdx ? maskMdxProse(text) : text, syntax);
        const raw = text.split("\n");
        const script = isMarkup ? markupCodeSpans(code, file) : undefined;
        masked.set(file, {
          code,
          open: isMdx ? mdxOpenLines(code, raw) : undefined,
          script,
          depth: script && markupOpenDepths(code, script, raw),
        });
      } catch {
        // A cancelled read is not an unreadable file. Swallowing it would turn the abort into
        // "proves no caller" and let the pass finish on a verdict nobody asked for.
        abort?.throwIfAborted();
        masked.set(file, undefined);
      }
    }
    const entry = masked.get(file);
    if (!entry) continue;
    const references = (line: number): boolean => {
      const text = entry.code[line - 1];
      if (isMdx) return referencesMdx(text, symbol, entry.open?.[line - 1] === true);
      if (isMarkup)
        return referencesMarkup(text, symbol, entry.script?.[line - 1], entry.depth?.[line - 1]);
      if (isJsx) return referencesJsx(text, symbol);
      return referencesWord(text, symbol);
    };
    if (lines.some(references)) files.push(file);
  }
  return files;
}

/**
 * The scan's exclusions as `git grep` pathspecs, so the reference check reads the file set stringer
 * actually walked. A repo that commits its build output (`dist/bundle.js`) names every symbol it
 * bundled; counting that copy as a caller would delete a true finding about the source stringer was
 * pointed at and grep was not. `:(glob)` so `dist/**` keeps the glob meaning stringer gives it, and
 * a leading `.` because git refuses a pathspec list that only excludes.
 *
 * Over-excluding is the safe direction: a file grep never reads proves no caller, and an unproven
 * caller leaves the signal standing.
 */
function excludePathspecs(exclude: readonly string[]): string[] {
  const globs = exclude.map((glob) => glob.trim()).filter(Boolean);
  return globs.length === 0 ? [] : [".", ...globs.map((glob) => `:(exclude,glob)${glob}`)];
}

/**
 * Every file that references the symbol as a whole word — tracked files plus anything new that
 * isn't ignored, since a caller written today is a caller. `-F`/`-w` so a symbol carrying regex
 * punctuation (`$mount`) matches itself rather than a pattern, `-z` so a non-ASCII path comes back
 * unquoted under `core.quotePath`, `-I` so a binary blob is never read as a call site, `-n` so a
 * hit can be located in its file and judged against the comments around it, and the scan's own
 * exclusions so generated and vendored trees answer for nothing.
 *
 * The caller's signal goes to the child so a cancelled job kills the grep it is waiting on instead
 * of paying out its 30s timeout.
 */
async function filesMentioning(
  repoPath: string,
  symbol: string,
  masked: Map<string, MaskedFile | undefined>,
  pathspecs: string[],
  abort?: AbortSignal,
): Promise<string[] | { unavailable: string }> {
  try {
    const args = ["-C", repoPath, "grep", "-n", "-I", "-w", "-F", "-z", "--untracked", "-e", symbol];
    if (pathspecs.length > 0) args.push("--", ...pathspecs);
    const { stdout } = await execFileAsync("git", args, {
      timeout: GREP_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      signal: abort,
    });
    return await codeReferencingFiles(repoPath, symbol, candidateHits(stdout), masked, abort);
  } catch (err) {
    // A cancelled job is not an unsearchable tree. Reporting the kill as `unavailable` would let the
    // scan finish and record the pass, holding up shutdown and the `--delta` baseline unwind — so
    // the abort is rethrown, ahead of the exit-code test because a killed grep can surface as either.
    abort?.throwIfAborted();
    // Exit 1 is `git grep`'s "no match" — the answer, not a failure. Anything else is git unable to
    // answer at all, which must not read as "nothing references it".
    const e = err as { code?: number | string } | null;
    if (e?.code === 1) return [];
    return { unavailable: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Drop the deadcode signals the tree contradicts, and say which. Runs BEFORE annotation, in
 * lib/stringer's one filter seam, so the health record's counts and the triage prompt's file
 * describe the same set.
 *
 * One reference in ANOTHER file is enough to keep the symbol alive: the collector's own claim is
 * that nothing references it, and a single word-boundary hit on a code line outside its declaration
 * falsifies exactly that. Every file this scan reports as declaring the symbol is excluded, because
 * a symbol always mentions itself there — counting a declaration would drop every signal, which is
 * the one outcome worse than counting phantoms. `opts.exclude` is the scan's own exclusion set, so the search covers the files stringer
 * inspected and no others — a committed build or vendor tree is not a caller of the source it copied.
 *
 * Only reached when a scan actually carries a deadcode signal, so an ordinary pass runs no git.
 *
 * Cancellation throws rather than returning a partial verdict: a pass the caller stopped has not
 * checked the tree, and letting it return would write a scan file and record a health point for a
 * job already on its way out.
 */
export async function filterDeadcodeSignals(
  repoPath: string,
  signals: ScanSignal[],
  opts: { exclude?: readonly string[]; abort?: AbortSignal } = {},
): Promise<{ kept: ScanSignal[]; deadcode: DeadcodeFilter }> {
  const { abort } = opts;
  const relevant = signals.filter((signal) => collectorOf(signal) === DEADCODE_COLLECTOR);
  if (relevant.length === 0) return { kept: signals, deadcode: { dropped: [] } };

  const pathspecs = excludePathspecs(opts.exclude ?? []);
  // Every file that declares a given symbol, gathered before any grep. Two signals can name the
  // same symbol in different files (an overload in a sibling module, a helper copied per package);
  // excluding only the signal's own path leaves each declaration looking like the other's caller,
  // and both genuinely dead symbols vanish from the counts.
  const declarers = new Map<string, Set<string>>();
  for (const signal of relevant) {
    const symbol = symbolOf(signal);
    const path = filePathOf(repoPath, signal);
    if (!symbol || !path) continue;
    const paths = declarers.get(symbol);
    if (paths) paths.add(path);
    else declarers.set(symbol, new Set([path]));
  }
  const seen = new Map<string, string[]>();
  /** One read per file, however many symbols land in it. */
  const masked = new Map<string, MaskedFile | undefined>();
  const verdicts = new Map<ScanSignal, string>();
  let unavailable: string | undefined;
  let unchecked = 0;

  for (const [index, signal] of relevant.entries()) {
    // Before starting another symbol's grep, not just inside it: a cancelled job should not spend
    // the tree on findings nobody will read.
    abort?.throwIfAborted();
    const symbol = symbolOf(signal);
    const path = filePathOf(repoPath, signal);
    // No symbol or no file is nothing anton can check: a mention count needs both a name to look
    // for and the declaration to discount.
    if (!symbol || !path) continue;

    let files = seen.get(symbol);
    if (!files) {
      // Out of budget: this signal and everything after it is reported without a reference check,
      // so the count of what went unverified travels with the result.
      if (seen.size >= SYMBOL_BUDGET) {
        unchecked = relevant.length - index;
        break;
      }
      const found = await filesMentioning(repoPath, symbol, masked, pathspecs, abort);
      if (!Array.isArray(found)) {
        unavailable = found.unavailable;
        break;
      }
      files = found;
      seen.set(symbol, files);
    }

    const declaring = declarers.get(symbol) ?? new Set([path]);
    const callers = files.filter((file) => !declaring.has(file));
    if (callers.length === 0) continue;
    const shown = callers.slice(0, 3);
    const rest = callers.length - shown.length;
    verdicts.set(
      signal,
      `${symbol} is referenced in ${shown.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`,
    );
  }

  // Cancellation between the last grep and the verdict still cancels the pass: the loop only checks
  // on its way into a symbol, so without this an abort arriving during the final symbol's reads
  // would return a result the caller stopped waiting for and let the scan record itself.
  abort?.throwIfAborted();

  if (unavailable) return { kept: signals, deadcode: { dropped: [], unavailable } };

  const dropped: DroppedDeadcode[] = [];
  const kept = signals.filter((signal) => {
    const reason = verdicts.get(signal);
    if (reason === undefined) return true;
    dropped.push({
      path: filePathOf(repoPath, signal) ?? "",
      symbol: symbolOf(signal) ?? "",
      kind: kindOf(signal),
      reason,
    });
    return false;
  });
  return { kept, deadcode: unchecked > 0 ? { dropped, unchecked } : { dropped } };
}

/**
 * What the reference check did, for the session log; undefined when it changed nothing.
 *
 * Every drop names its callers: the log is the only place a filtered finding still exists, so
 * "a fixture helper its own suite calls" has to be distinguishable from "anton stopped reporting
 * code nobody calls" without re-running the scan.
 */
export function describeDeadcodeFilter(filter: DeadcodeFilter): string | undefined {
  if (filter.unavailable) {
    return (
      `the tree could not be searched for references (${filter.unavailable}) — dead-code findings ` +
      `are counted unverified this pass`
    );
  }
  const truncated =
    filter.unchecked && filter.unchecked > 0
      ? `${filter.unchecked} dead-code signal(s) were counted unchecked — the ${SYMBOL_BUDGET}-symbol ` +
        `search budget ran out this pass`
      : undefined;
  if (filter.dropped.length === 0) return truncated;
  const shown = filter.dropped.slice(0, 10);
  const rest = filter.dropped.length - shown.length;
  return (
    `dropped ${filter.dropped.length} dead-code signal(s) whose symbol has callers elsewhere in ` +
    `the tree: ${shown.map((d) => `${d.path} (${d.kind} — ${d.reason})`).join("; ")}` +
    `${rest > 0 ? ` (+${rest} more)` : ""}${truncated ? `; ${truncated}` : ""}`
  );
}
