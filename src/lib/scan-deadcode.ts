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
 * spends on it. Hitting it means "not checked" only for signals naming a symbol nothing searched
 * yet — a symbol already in hand is still answered, since its result costs nothing. The unchecked
 * ones keep their place: reported, not silently dropped, and counted in the filter's diagnostics
 * so a truncated pass can't be read as a verified one.
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
  /**
   * The characters a string literal opens with, for the languages that spell one unambiguously. A
   * marker quoted inside a literal opens no comment — `const url = "https://host"; Widget()` calls
   * the symbol beside the URL — and blanking from that `//` erases the call, leaving a signal
   * standing that the file had already disproved. Left unset where the quote means something else
   * as often: a lifetime in Rust, an apostrophe in MDX prose, anything at all in a language anton
   * tracks no grammar for.
   */
  quotes?: string;
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
    quotes: "\"'`",
  },
  {
    // Rust, Swift, Scala and Kotlin nest block comments: in `/* outer /* inner */ tail */` the
    // first `*/` closes only the inner one. Reading them with the C-like grammar ends the comment
    // early, so `tail` reads as code — a caller that isn't there, deleting a finding that was right.
    files: /\.(?:rs|swift|scala|kt|kts)$/i,
    line: ["//"],
    block: [["/*", "*/"]],
    nested: true,
    // Only the double quote: `'` opens a lifetime (`&'a str`) and a backtick an identifier as
    // often as either opens a literal, and skipping a span that isn't one hides a real comment.
    quotes: '"',
  },
  {
    // PHP takes `#` as well as `//`, so it can't ride with the C-like languages, where `#` opens a
    // preprocessor directive rather than a comment. A PHP 8 attribute (`#[Route]`) reads as a
    // comment under this — the conservative direction, which keeps a signal rather than deleting it.
    files: /\.(?:php|phtml)$/i,
    line: ["//", "#"],
    block: [["/*", "*/"]],
    quotes: "\"'",
  },
  {
    files: /\.(?:html?|xml|svg|vue|svelte|astro)$/i,
    line: ["//"],
    block: [
      ["<!--", "-->"],
      ["/*", "*/"],
    ],
    quotes: "\"'",
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
    // The triple-quoted forms are matched as blocks before this, so a docstring still opens where
    // it always did — only the one- and two-character literals are stepped over.
    quotes: "\"'",
  },
  {
    // Ruby's block comment is a pair of line-anchored markers rather than an inline delimiter, and
    // it is the only comment `#` cannot express: without it the continuation lines of a `=begin`
    // block read as code, and prose naming a symbol proves a caller that isn't there.
    files: /\.(?:rb|rake|gemspec)$/i,
    line: ["#"],
    block: [["=begin", "=end"]],
    anchored: true,
    quotes: "\"'",
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
    quotes: "\"'",
  },
  {
    // HCL comments with `#` as well as `//`, and the unknown-language fallback reads neither once
    // code precedes it: `ami = "ami-1" # Widget was removed` keeps its prose, which then proves a
    // caller and deletes a true finding. Terraform and the tools sharing its syntax are where a
    // repo actually carries that line.
    files: /\.(?:tf|tfvars|hcl)$/i,
    line: ["#", "//"],
    block: [["/*", "*/"]],
    quotes: '"',
  },
  {
    files: /\.(?:sh|bash|zsh|ya?ml|toml)$/i,
    line: ["#"],
    block: [],
    quotes: "\"'",
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

/** The first comment marker at or after `from`, whichever kind opens earliest. */
function commentAt(
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

/**
 * Where the string opened at `at` ends, or -1 when it runs off the end of the line. Escapes are
 * stepped over so `"a\"b"` ends on its third quote and not its second.
 */
function stringEnd(line: string, at: number, quote: string): number {
  for (let cursor = at + 1; cursor < line.length; cursor += 1) {
    if (line[cursor] === "\\") cursor += 1;
    else if (line[cursor] === quote) return cursor;
  }
  return -1;
}

/**
 * The first comment starting at or after `from`, with quoted text stepped over rather than read.
 * `const url = "https://host"; Widget()` holds no comment: blanking from the `//` inside that URL
 * erases the call beside it, and the file then proves no caller for a signal it had in fact
 * disproved. A marker that opens where the quote does wins — Python's `"""` is a block, not a
 * literal to skip.
 *
 * A quote that never closes on its line is not a literal worth trusting, so the scan resumes just
 * past it: a Rust `'a`, an apostrophe in a shell comment and a template literal spanning lines all
 * read as they did before, and a trailing comment behind any of them still gets blanked.
 */
function nextComment(
  line: string,
  from: number,
  syntax: CommentSyntax,
): { at: number; marker: string; closer?: string } | undefined {
  const quotes = syntax.quotes;
  let at = from;
  for (;;) {
    const found = commentAt(line, at, syntax);
    if (quotes === undefined) return found;
    let quoteAt = -1;
    let quote = "";
    for (let cursor = at; cursor < line.length; cursor += 1) {
      const char = line[cursor];
      if (char !== undefined && quotes.includes(char)) {
        quoteAt = cursor;
        quote = char;
        break;
      }
    }
    if (quoteAt < 0 || (found !== undefined && found.at <= quoteAt)) return found;
    const end = stringEnd(line, quoteAt, quote);
    at = end < 0 ? quoteAt + 1 : end + 1;
  }
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
 * on its line. The scan is textual, so it reads a line at a time and only steps over the literals
 * `syntax.quotes` names — a delimiter quoted in a language anton has no quote grammar for, or in a
 * string that wraps, still opens a block that isn't there. Every such mistake ends in "this hit is
 * prose", which leaves a signal standing rather than deleting one.
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

/**
 * MDX's ESM block: the only place an import or export can stand, spelled as JavaScript spells one
 * rather than as a paragraph opening with the word `export`. The keyword alone is not enough, in
 * either of the two places this is asked. Reading `export Widget from the old build` as code lets
 * a sentence prove its own caller and delete a true finding — and carries that down the paragraph,
 * since the block runs to the blank line. Leaving that line's backticks unmasked runs the same
 * way: the span in ``export the `Widget` helper`` would prove a caller too. So the keyword has to
 * be followed by something markdown prose does not put there.
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
 *
 * The depth is read past what an expression quotes, the way `punctuation` reads it: in
 * ``{ready ? "}" : `${Widget()}`}`` the quoted brace is text, and closing the expression on it
 * leaves the template literal beside it looking like a markdown code span, blanked along with the
 * caller it interpolates. A quote only delimits inside an expression — at depth 0 an apostrophe is
 * prose — and a backslash escapes what follows it either way, so markdown's `` \` `` opens no span.
 */
function maskMdxCodeSpans(line: string, depth = 0): { masked: string; depth: number } {
  const spans: [number, number][] = [];
  let quote: string | undefined;
  let at = 0;
  while (at < line.length) {
    const char = line[at];
    if (quote !== undefined) {
      if (char === "\\") at += 1;
      else if (char === quote) quote = undefined;
    } else if (char === "\\") at += 1;
    else if (depth > 0 && QUOTE.test(char)) quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
    else if (char === "`") {
      const openEnd = backtickRunEnd(line, at);
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
 *
 * A backslash escapes what follows it outside a string as well as inside one: markdown writes a
 * literal brace as `\{`, so `Use \{ before Widget in prose` opens no expression, and counting
 * that brace reads the sentence as code and deletes a true finding. Outside prose the escape costs
 * nothing — a bare backslash is not punctuation in any program this reads.
 */
function* punctuation(text: string, inCode: () => boolean): Generator<string> {
  let quote: string | undefined;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quote !== undefined) {
      if (char === "\\") at += 1;
      else if (char === quote) quote = undefined;
    } else if (char === "\\") at += 1;
    else if (inCode() && QUOTE.test(char)) quote = char;
    else yield char;
  }
}

/**
 * Whether the text before the symbol leaves a braced expression open, counting from the depth the
 * lines above left open. An expression closes on the line that opened it unless a caller tracked
 * that depth — `<p>{version} Widget was removed</p>` renders `Widget` as text once `}` has run —
 * so treating any earlier `{` on the line as still open reads that prose as code, calls the page a
 * caller, and deletes a true finding about a genuinely unused symbol.
 *
 * `flavor` is how the format spells an interpolation: one brace for Svelte, Astro and MDX, the
 * doubled `{{ count }}` for Vue.
 */
function insideExpression(head: string, depth = 0, flavor: MarkupFlavor = "brace"): boolean {
  return expressionDepth(head, depth, flavor) >= (flavor === "mustache" ? 2 : 1);
}

/**
 * The depth `head` leaves a braced expression at, counted from the depth the lines above left open.
 *
 * Vue's `{{` is a delimiter rather than a nesting: only the second brace of an adjacent pair opens
 * an interpolation, and a lone brace anywhere else in its template is a character the page shows.
 * Reading the depth instead lets ordinary prose reach two — `<p>Write {one {Widget} two}
 * literally</p>` interpolates nothing — and counting that as an expression makes the sentence a
 * caller, which deletes a true finding about a genuinely unused symbol. Inside an interpolation
 * every brace nests as usual, so an object literal in `{{ fn({ a: 1 }) }}` still holds it open.
 */
function expressionDepth(head: string, depth: number, flavor: MarkupFlavor): number {
  let previous: string | undefined;
  for (const char of punctuation(head, () => depth > 0)) {
    if (char === "{") {
      if (flavor !== "mustache" || depth > 0) depth += 1;
      else if (previous === "{") depth = 2;
    } else if (char === "}") depth = Math.max(0, depth - 1);
    previous = char;
  }
  return depth;
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
    if (depth === 0 && !esm && MDX_ESM_STATEMENT.test(line)) esm = true;
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
  if (line !== undefined && (open || MDX_ESM_STATEMENT.test(line))) return referencesWord(line, symbol);
  return referencesWord(line, symbol, (head) => TAG_HEAD.test(head) || insideExpression(head));
}

/**
 * Files read as markup — HTML and the single-file component formats built on it. Comment masking
 * blanks what `<!-- -->` hides and nothing else, so `<p>neverCalled was removed</p>` survives it
 * intact and reads as a call: a committed doc page or template would then delete a true finding
 * about a genuinely unused symbol. Their text is judged like MDX's markdown instead.
 */
const MARKUP_FILE = /\.(?:html?|xml|svg|vue|svelte|astro)$/i;

/**
 * Markup whose tag names resolve program bindings: a single-file component renders `<Widget />` by
 * the symbol it imported. Static HTML, XML and SVG have no such binding — `<Widget>` there is an
 * element name the document defines itself, and counting it as a caller deletes a true finding
 * about a genuinely unused symbol.
 */
const COMPONENT_FILE = /\.(?:vue|svelte|astro)$/i;

/** The component format whose interpolation is `{{ … }}`, where a single brace is shown text. */
const MUSTACHE_FILE = /\.vue$/i;

/**
 * How a markup file writes an interpolation: not at all in static HTML, XML and SVG, with one
 * brace in Svelte and Astro, with two in Vue.
 */
type MarkupFlavor = "static" | "brace" | "mustache";

/** Which of those a file is, read from its extension. */
function markupFlavorOf(file: string): MarkupFlavor {
  if (MUSTACHE_FILE.test(file)) return "mustache";
  return COMPONENT_FILE.test(file) ? "brace" : "static";
}

/** Astro puts its module in a `---` fence at the top of the file, above any markup. */
const ASTRO_FILE = /\.astro$/i;
const ASTRO_FENCE = /^---\s*$/;

/**
 * Where any tag begins, opening or closing, with the element it names — `<div`, `</script`. Every
 * tag is walked rather than only the one being looked for, because a tag name inside another tag's
 * quoted attribute is text a reader sees: `<div title="example <script>">` opens no script, and
 * recognizing one there reads the rendered lines under it as program, where the page's own prose
 * proves a caller and deletes a true finding.
 *
 * Only the start is matched, because the `>` that ends it may be lines away: an attribute list
 * wraps as ordinary formatting, and a whole-tag pattern would recognize no opener at all on
 * `<script` with `type="module">` under it, leaving the body it opens unread and the import inside
 * it uncounted.
 */
const MARKUP_TAG = /<(\/?)([a-zA-Z][^\s/>]*)/g;

/**
 * Where `name`'s closing tag begins. Only its own close ends an element's body, so the `<` in the
 * program it holds — `a < b`, `</` in a string — opens nothing while the body runs.
 */
function elementTagEnd(name: string): RegExp {
  return new RegExp(String.raw`<\/${name}\b`, "gi");
}

/**
 * Where the tag being read ends, scanning from `at`, and the attribute quote it still leaves open.
 * Quoted values are walked rather than scanned for, so the `>` inside one —
 * `<script title="> gone">` — doesn't end the tag early and hand the rest of the attribute back as
 * element body: text a reader sees would then read as program and prove its own caller. A value
 * that wraps is known to be still open on the line below, so its quote carries there too.
 */
function markupTagEnd(line: string, at: number, quote?: string): { at: number; quote?: string } {
  for (let index = at; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return { at: index };
  }
  return { at: -1, quote };
}

/** The element whose body is a program rather than markup. */
const SCRIPT_TAG = "script";

/**
 * The `type` a `<script>` declares. Only a whole attribute counts, so `data-type="ld+json"` is not
 * read as the element's own type.
 */
const SCRIPT_TYPE = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/**
 * The script types a browser executes: `module` and the JavaScript MIMEs, plus the ones a
 * transpiler claims. Anything else — `application/ld+json`, `importmap`, `speculationrules`, a
 * templating engine's block — is data the page never runs.
 */
const EXECUTABLE_SCRIPT_TYPE =
  /^(?:module|(?:text|application)\/(?:java|ecma)script|text\/(?:babel|jsx|typescript)|application\/typescript)$/i;

/**
 * Whether the body this `<script>` opens is a program. A data block names a symbol the way rendered
 * text does — `<script type="application/ld+json">{"name":"Widget"}</script>` shows it, it doesn't
 * call it — so reading every script body as code lets a committed page prove its own caller.
 *
 * A script with no `type` runs, as does one whose MIME carries parameters
 * (`text/javascript;charset=utf-8`).
 */
function runsJavaScript(opener: string): boolean {
  const declared = SCRIPT_TYPE.exec(opener);
  if (!declared) return true;
  const type = (declared[1] ?? declared[2] ?? declared[3] ?? "").split(";")[0]?.trim() ?? "";
  return type === "" || EXECUTABLE_SCRIPT_TYPE.test(type);
}

/** The same for `<style>`, whose braces are CSS rather than the template's interpolations. */
const STYLE_TAG = "style";

/**
 * The framework directive prefixes that introduce a binding: Svelte's `use:enhance`, Vue's
 * `v-on:click`. Only the known prefixes count — accepting any `word:` would read `the helper:
 * neverCalled ran nightly` as a call.
 */
const DIRECTIVE = String.raw`(?:use|on|bind|transition|in|out|animate|class|style|slot|v-[\w-]+)`;

/**
 * A directive taking a bare binding rather than a braced one: `<form use:enhance>` and
 * `<b v-on:click=go>` name a real caller with no other code around them. Matched against the head
 * of the tag the symbol sits in, never the whole line — see `openTagHead`.
 */
const DIRECTIVE_HEAD = new RegExp(String.raw`(?:^|[\s"'])${DIRECTIVE}:\s*$`);

/**
 * The head of the tag the text ends inside, or undefined when it ends in rendered text. A
 * directive binds within a tag, so the sentence `<p>The old use: Widget was removed</p>` names
 * nothing: the tag it follows has already closed, and reading its prefix as a binding calls the
 * page a caller and deletes a true finding about a genuinely unused symbol.
 *
 * A line carrying no `<` at all is left as a tag head. A tag whose attributes wrap onto lines of
 * their own — `<form` with `use:enhance` under it — is the shape the binding really takes, and
 * telling that continuation from a wrapped paragraph would need the file's tag nesting carried
 * across lines. The bound is kept deliberately: it costs only prose that both wraps and spells a
 * directive prefix right before the symbol.
 *
 * Quoted values are walked rather than scanned past, the way `markupOpenAttrs` walks them: the `>`
 * in `<button onclick="a > b && Widget()"` is part of the handler, and ending the tag there reads
 * a running attribute as rendered text and leaves a finding standing about a symbol the page calls.
 */
function openTagHead(markup: string): string | undefined {
  if (!markup.includes("<")) return markup;
  let open = -1;
  let quote: string | undefined;
  for (let at = 0; at < markup.length; at += 1) {
    const char = markup[at];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (open < 0) {
      if (char === "<") open = at;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ">") open = -1;
  }
  return open < 0 ? undefined : markup.slice(open);
}

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
 *
 * The value runs to the quote that opened it, so the other quote inside it is code like the rest:
 * `onclick="log('x'); Widget()"` invokes the symbol, and ending the value at that apostrophe reads
 * a live handler as text and leaves a finding standing about a function the page still calls.
 */
const ATTR_VALUE = new RegExp(
  String.raw`(?:^|[\s"'])${CODE_ATTR}\s*=\s*(?:"[^"]*|'[^']*)$`,
  "i",
);

/**
 * The same attribute with its value left unquoted — `<button onclick=Widget()>` is HTML a browser
 * runs, and the symbol starts right at the `=`. Only whitespace may precede the name: inside a
 * quoted value an `onclick=` is text a reader sees rather than a binding the page carries.
 */
const ATTR_VALUE_BARE = new RegExp(String.raw`(?:^|\s)${CODE_ATTR}\s*=\s*$`, "i");

/**
 * A code-carrying attribute whose quote opens exactly at the end of the text — the test
 * `markupOpenAttrs` asks at each quote it walks past inside a tag, so a value that wraps is known
 * to be a binding rather than the content an ordinary attribute holds.
 */
const ATTR_OPENS_CODE = new RegExp(String.raw`(?:^|\s)${CODE_ATTR}\s*=\s*["']$`, "i");

/** Where a line is program text rather than markup, as `[start, end)` offsets into that line. */
type CodeSpans = [number, number][];

/** What a markup line starts inside — the state the lines above it leave open. */
interface MarkupLine {
  /** Where this line is program text rather than markup. */
  code?: CodeSpans;
  /** How many braced expressions the lines above leave open. */
  depth?: number;
  /** The quote holding a code-carrying attribute's value open, when one is. */
  attr?: string;
}

/** A markup file as this filter reads it: the text to judge, and which of it is program. */
interface MarkupProgram {
  /** The masked lines, with every data-only `<script>` body and every `<style>` body blanked out. */
  code: string[];
  /** Where each line is program text rather than markup. */
  script: CodeSpans[];
}

/**
 * Which spans of a markup file are program text rather than markup: the body of an executable
 * `<script>` element, or an Astro frontmatter block. Those are where a component gets imported, so
 * judging them by markup's rules would miss the import that proves the symbol live.
 *
 * Spans rather than whole lines, because an element can share its line with rendered text:
 * `<p>Widget was removed</p><script>go()</script>` runs only between the tags, and calling the
 * whole line executable lets the prose beside the script prove a caller and delete a true finding.
 *
 * A data script's body is blanked rather than handed back as markup, because it is neither: the
 * `{` opening `{"name":"Widget"}` is JSON punctuation, and reading it as a template interpolation
 * would count the block as a caller by the other route. A `<style>` body is blanked for the same
 * reason: the `{` opening `.notice::after { content: "Widget was removed"; }` is a CSS rule's own
 * punctuation, and left visible it reads as an interpolation holding the name a stylesheet only
 * shows a reader — which deletes a true finding. Blanking answers both routes at once, since the
 * rule can open on the very line the name sits on, where no cross-line depth is consulted.
 *
 * A CSS-only reference — Vue's `v-bind(widget)` — goes uncounted with the rest of the body. That
 * leaves its signal standing rather than deleting one, the direction this filter errs in.
 *
 * Read from the masked lines, so a `<script>` shown inside a comment opens nothing.
 */
function markupProgram(code: string[], file: string): MarkupProgram {
  const frontmatterEnd = ASTRO_FILE.test(file) ? astroFrontmatterEnd(code) : -1;
  const from = frontmatterEnd + 1;
  const data = elementBodySpans(code, SCRIPT_TAG, from, (opener) => !runsJavaScript(opener));
  const blanked = code.map((line, index) => blankSpans(line, data[index] ?? []));
  const scripts = elementBodySpans(blanked, SCRIPT_TAG, from, runsJavaScript);
  const style = elementBodySpans(blanked, STYLE_TAG, from);
  const masked = blanked.map((line, index) => blankSpans(line, style[index] ?? []));
  const script: CodeSpans[] = masked.map((line, index) =>
    index <= frontmatterEnd ? [[0, line.length]] : (scripts[index] ?? []),
  );
  return { code: masked, script };
}

/**
 * Where each line sits inside the body of the element `name` — the program a `<script>` holds, the
 * CSS a `<style>` holds. Both are the element's own language rather than the template's, so the
 * markup rules stop at their tags.
 *
 * `opens` selects which bodies are reported: an element it rejects still runs to its closing tag,
 * so the ones after it are found where they are, but its own body is left out.
 *
 * Outside a body every tag is walked, not just `name`'s, because only walking one leaves its name
 * recognized wherever it is spelled — including inside another tag's quoted attribute, where
 * `<div title="example <script>">` is text rather than an element. Inside a body only `name`'s own
 * close is looked for, the way a browser reads raw text: a `<` in the program it holds opens
 * nothing.
 *
 * A tag is read across lines, because an attribute list wraps as ordinary formatting: `<script`
 * with `type="module">` under it opens the body its import sits in, and stopping at the line's end
 * would read that import as markup and leave a live component reported dead. The opener's own text
 * is joined with newlines so `opens` reads the attributes it wrapped as the whitespace-separated
 * list they are.
 */
function elementBodySpans(
  code: string[],
  name: string,
  from = 0,
  opens: (opener: string) => boolean = () => true,
): CodeSpans[] {
  const closeTag = elementTagEnd(name);
  const lines: CodeSpans[] = [];
  let open = false;
  let selected = true;
  /** A tag whose `>` has not arrived yet: what it has spelled, and the attribute quote it leaves open. */
  let pending: { body: boolean; closing: boolean; text: string; quote?: string } | undefined;
  for (const [index, line] of code.entries()) {
    if (index < from) {
      lines.push([]);
      continue;
    }
    const spans: CodeSpans = [];
    // A body an earlier line left open runs from the start of this one; a body this line opens
    // runs from the end of its tag, and an unclosed one carries on into the line below.
    let start: number | undefined = open ? 0 : undefined;
    let at = 0;
    while (at <= line.length) {
      if (pending === undefined) {
        if (start === undefined) {
          MARKUP_TAG.lastIndex = at;
          const match = MARKUP_TAG.exec(line);
          if (!match) break;
          pending = {
            body: match[2]?.toLowerCase() === name,
            closing: match[1] === "/",
            text: match[0],
          };
          at = match.index + match[0].length;
        } else {
          closeTag.lastIndex = at;
          const match = closeTag.exec(line);
          if (!match) break;
          // A closing tag ends the body where it starts, whatever line its `>` lands on.
          if (selected) spans.push([start, match.index]);
          start = undefined;
          selected = true;
          pending = { body: true, closing: true, text: match[0] };
          at = match.index + match[0].length;
        }
      }
      const end = markupTagEnd(line, at, pending.quote);
      if (end.at < 0) {
        pending.text += `${line.slice(at)}\n`;
        pending.quote = end.quote;
        break;
      }
      const { body, closing } = pending;
      const opener = pending.text + line.slice(at, end.at + 1);
      pending = undefined;
      at = end.at + 1;
      if (body && !closing && start === undefined && !opener.endsWith("/>")) {
        start = at;
        selected = opens(opener);
      }
    }
    if (start !== undefined && selected) spans.push([start, line.length]);
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
 * Braces inside a `<script>` body don't count: an object literal is the element's own punctuation,
 * not an interpolation, and letting one open an expression would read every line below it as code.
 * A `<style>` body needs no skipping here — `markupProgram` has already blanked it, so its CSS
 * braces are gone from `code` before this runs.
 *
 * A blank line closes whatever is open, and blankness is read from `raw` — the file before masking
 * — so a line a comment emptied is not mistaken for the break. That bound is deliberate, as it is
 * in MDX: an unbalanced `{` in rendered text can then only mislead its own block instead of every
 * line after it, and reading prose as code is the direction that deletes a true finding.
 *
 * The depth is counted the way `flavor` opens an expression, so a Vue template that never doubles
 * its braces carries none of them into the lines below.
 */
function markupOpenDepths(
  code: string[],
  script: CodeSpans[],
  raw: string[],
  flavor: MarkupFlavor,
): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (const [index, line] of code.entries()) {
    depths.push(depth);
    if (!raw[index]?.trim()) {
      depth = 0;
      continue;
    }
    const skip = script[index] ?? [];
    let template = "";
    for (let at = 0; at < line.length; at += 1)
      template += skip.some(([start, end]) => at >= start && at < end) ? " " : line[at];
    depth = expressionDepth(template, depth, flavor);
  }
  return depths;
}

/**
 * The quote holding a code-carrying attribute's value open at the start of each markup line, or
 * undefined when none is. A handler wraps — `<button onclick="` with `Widget()` under it — and the
 * browser runs it all the same, so judging that line alone finds no attribute before the symbol:
 * the caller goes uncounted and a false dead-code signal keeps costing the health record a debt
 * point. `markupOpenDepths` carries its own state across lines for the same reason.
 *
 * Quotes only delimit inside a tag, so the apostrophe in `<p>It's gone</p>` opens nothing — reading
 * rendered text as an attribute value would hide the real handler under it. Every quoted value is
 * walked, not just the code-carrying ones, so a static `title="see onclick="` cannot hand its own
 * text back as a binding; only a value `ATTR_OPENS_CODE` recognizes is reported.
 *
 * A blank line closes whatever is open, read from `raw` for the reason `markupOpenDepths` reads it
 * there: an unbalanced quote can then only mislead its own block rather than the rest of the file.
 */
function markupOpenAttrs(
  code: string[],
  script: CodeSpans[],
  raw: string[],
): (string | undefined)[] {
  const opens: (string | undefined)[] = [];
  let quote: string | undefined;
  let isCode = false;
  let inTag = false;
  for (const [index, line] of code.entries()) {
    opens.push(isCode ? quote : undefined);
    if (!raw[index]?.trim()) {
      quote = undefined;
      isCode = false;
      inTag = false;
      continue;
    }
    const template = blankSpans(line, script[index] ?? []);
    for (let at = 0; at < template.length; at += 1) {
      const char = template[at];
      if (quote !== undefined) {
        if (char === quote) {
          quote = undefined;
          isCode = false;
        }
      } else if (!inTag) {
        if (char === "<") inTag = true;
      } else if (char === ">") inTag = false;
      else if (char === '"' || char === "'") {
        quote = char;
        isCode = ATTR_OPENS_CODE.test(template.slice(0, at + 1));
      }
    }
  }
  return opens;
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
 * `state` is what the lines above left open: how many expressions, so an interpolation that wraps
 * still reads as one on the line the call actually sits on, and the quote of a handler whose value
 * wrapped, so the code inside it still reads as code.
 *
 * A tag name and a braced expression only count in a component `flavor`, where `<Widget />`
 * renders the imported symbol and `{Widget()}` invokes it. In static HTML, XML or SVG the same
 * element is the document's own vocabulary and a brace is a character the page shows — `<p>Write
 * {Widget} literally</p>` names the symbol the way the prose around it does, and reading that as a
 * call deletes a true finding about a genuinely unused symbol. Vue is a component format that
 * still shows that brace: it interpolates with `{{ … }}`, so only the doubled brace runs there.
 *
 * An attribute binds inside the tag that declares it, so both attribute shapes are matched against
 * the head of the open tag rather than the whole line — the same bound `DIRECTIVE_HEAD` keeps.
 * `<p>Write onclick=Widget in docs</p>` closed its tag before the symbol, and reading that
 * sentence as a handler lets a doc page prove its own caller.
 */
function referencesMarkup(
  line: string | undefined,
  symbol: string,
  state: MarkupLine = {},
  flavor: MarkupFlavor = "static",
): boolean {
  const { code = [], depth = 0, attr } = state;
  return referencesWord(line, symbol, (head) => {
    const at = head.length;
    if (code.some(([start, end]) => at >= start && at < end)) return true;
    // Only the markup since the last script body is template: a brace left in the JavaScript
    // beside it is not the `{count}` that would make the text after it an expression. A script
    // between the line's start and the symbol restarts that reading, so the depth carried from
    // above stops there too.
    const from = code.reduce((last, [, end]) => (end <= at ? end : last), 0);
    const markup = head.slice(from);
    // A handler that wrapped runs to the quote that opened it, so everything before that quote is
    // still the code the browser executes.
    if (attr !== undefined && from === 0 && !markup.includes(attr)) return true;
    const tag = openTagHead(markup);
    return (
      (tag !== undefined &&
        (ATTR_VALUE.test(tag) || ATTR_VALUE_BARE.test(tag) || DIRECTIVE_HEAD.test(tag))) ||
      (flavor !== "static" &&
        (TAG_HEAD.test(markup) ||
          insideExpression(markup, from === 0 ? depth : 0, flavor)))
    );
  });
}

/** Files whose program also renders text: the JSX a `.jsx`/`.tsx` module carries. */
const JSX_FILE = /\.[jt]sx$/i;

/**
 * The attributes between a tag's name and the `>` that ends it, with each quoted value taken as a
 * unit the way `openTagHead` walks one. A value shows the angle bracket it holds — `<p title="a >
 * b">Widget was removed</p>` — so reading that `>` as the end of the tag leaves the element
 * unopened and the prose behind it program, which lets a paragraph naming a removed component
 * prove its own caller. A value left unterminated closes no tag on this line at all, which is the
 * wrapped opener `JSX_TAG_OPEN` carries onto the lines under it.
 */
const JSX_ATTRS = String.raw`(?:"[^"]*"|'[^']*'|[^<>"'])*`;

/**
 * A tag this line opens and leaves open — `<p>`, `<Panel tone="warn">`, the fragment `<>` — so what
 * follows it is rendered. A fragment counts because prose is written straight inside one, and
 * reading `<>` with `Widget was removed` under it as program text deletes a true finding. Not a
 * self-closing `<Icon />`, which renders nothing after itself and leaves the code beside it code,
 * and not a closing `</p>` or `</>`, which ends the text rather than starting it.
 */
const JSX_OPEN_TAG = String.raw`(?:<>|<[A-Za-z][\w.$:-]*(?:\s${JSX_ATTRS})?(?<![/])>)`;

/**
 * The delimiters JSX spells its own syntax with — the only punctuation that means anything between
 * a tag and its children, since code stands there solely inside a `{…}`.
 */
const JSX_CHILD_DELIMITERS = String.raw`<>{}[\]=\\|\``;

/**
 * The brackets a call is spelled with, which are the program's outside every element —
 * `render(Widget)` — and a sentence's inside one: `<p>(Widget was removed)</p>` shows the symbol to
 * a reader the way a doc page does, and reading that aside as program lets a prose-only page prove
 * its own caller and delete a true finding.
 */
const JSX_PARENS = String.raw`()`;

/**
 * The statement terminator, which ends a line of program — `const half = total / 2;` — and joins
 * two clauses inside an element: `<p>Deprecated; Widget was removed</p>` shows the symbol to a
 * reader the way a doc page does, and reading that semicolon as program lets a prose-only page
 * prove its own caller and delete a true finding.
 */
const JSX_STATEMENT = String.raw`;`;

/**
 * Every delimiter that means something on a line standing outside an element. A generic closes with
 * the same `>` a tag does — `new Map<Widget>()` — so text that claims to be rendered has to read as
 * a sentence before it is believed, or a real call goes uncounted.
 */
const JSX_DELIMITERS = `${JSX_CHILD_DELIMITERS}${JSX_PARENS}${JSX_STATEMENT}`;

/**
 * Arithmetic, which is program text on a line standing outside every element — `const half =
 * total / 2` — and ordinary punctuation inside one. `<p>A/B Widget documentation</p>` shows the
 * symbol to a reader, and reading that slash as program lets a prose-only page prove its own
 * caller and delete a true finding.
 */
const JSX_OPERATORS = String.raw`&+*/`;

/** Anything that makes a line outside an element program — an interpolation, a call, arithmetic. */
const JSX_CODE = new RegExp(String.raw`[${JSX_DELIMITERS}${JSX_OPERATORS}]`);

/**
 * That same test for text a tag has opened, where an operator, an aside and the semicolon between
 * two clauses are punctuation the page shows.
 */
const JSX_CHILD_CODE = new RegExp(String.raw`[${JSX_CHILD_DELIMITERS}]`);

/** What a reader sees: a tag this line leaves open, with only prose behind it. */
const JSX_TEXT = new RegExp(String.raw`${JSX_OPEN_TAG}[^${JSX_DELIMITERS}]*$`);

/**
 * The tail of a static prop — `title="Widget was removed`: the value a reader sees, not code.
 *
 * Only the quote decides. JSX interpolates a braced value the attribute writes bare (`body={…}`),
 * which the quote after `=` already excludes; a brace inside the quotes is a character the prop
 * shows — `title="Use {Widget} here"` renders that text — so rejecting the value over its own
 * punctuation reads a rendered prop as program and deletes a true finding.
 */
const JSX_PROP_VALUE = String.raw`[\w-]\s*=\s*(?:"[^"<>]*|'[^'<>]*)$`;

/** The symbol inside a plain string prop — `<p title="Widget was removed">` renders that too. */
const JSX_PROP_TEXT = new RegExp(String.raw`<[A-Za-z][\w.$:-]*\s${JSX_ATTRS}${JSX_PROP_VALUE}`);

/**
 * That same prop on a line the tag opened above. An attribute list wraps onto lines of its own as
 * ordinary formatting, so the opener the whole-tag test needs is a line away — and a static value
 * judged without it reads as program, which lets a prop that merely names the symbol prove its own
 * caller.
 */
const JSX_PROP_LINE = new RegExp(JSX_PROP_VALUE);

/** Every tag a line finishes: one it opens, the `</p>` that ends one, the self-closing `<Icon />`. */
const JSX_TAGS = new RegExp(
  String.raw`${JSX_OPEN_TAG}|</(?:[A-Za-z][\w.$:-]*\s*)?>|<[A-Za-z][\w.$:-]*(?:\s${JSX_ATTRS})?/>`,
  "g",
);

/**
 * A tag this line opens and leaves unfinished — `<Empty` with its props on the lines below, or an
 * attribute whose quoted value wraps. The value that wraps is matched unterminated so `jsxTagEnd`
 * can name the quote still open, and so a `>` a closed value shows does not pass for the end of a
 * tag that in fact runs on.
 */
const JSX_TAG_OPEN = new RegExp(
  String.raw`<[A-Za-z][\w.$:-]*(?:\s${JSX_ATTRS}(?:"[^"]*|'[^']*)?)?$`,
);

/**
 * The line with every `{…}` it closes blanked out, so what follows one reads as the prose it is.
 * `<p>{version} Widget was removed</p>` renders the symbol as text once `}` has run, but the braces
 * are punctuation both text tests reject, so leaving them in makes any interpolated line program
 * again — a paragraph naming a removed component then proves its own caller and deletes a true
 * finding. A span still open keeps its brace: the symbol behind it really is inside an expression.
 *
 * Spaces stand in for the span so offsets keep their meaning, and a quoted brace is skipped the way
 * `punctuation` skips one — `{label ?? "}"}` closes on its own brace, not the quoted one.
 *
 * The depth the line ends at comes back with it: an expression that wrapped is what the lines under
 * it are reading, and its caller has to know how far it still has to run.
 */
function maskJsxExpressions(line: string): { masked: string; depth: number } {
  const out = line.split("");
  let depth = 0;
  let start = 0;
  let quote: string | undefined;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (char === "\\") at += 1;
    else if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (depth > 0 && QUOTE.test(char)) quote = char;
    else if (char === "{") {
      if (depth === 0) start = at;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) out.fill(" ", start, at + 1);
    }
  }
  return { masked: out.join(""), depth };
}

/**
 * A character entity — `&mdash;`, `&#8212;`, `&#x2014;`. JSX writes one wherever the text it renders
 * needs a character its syntax would otherwise take, so the `&` and `;` an entity spells are the
 * page's punctuation rather than the program's: leaving them in makes `<p>&mdash; Widget was
 * removed</p>` read as code, and a paragraph naming a removed component then proves its own caller.
 */
const JSX_ENTITY = /&(?:#\d+|#[Xx][\dA-Fa-f]+|[A-Za-z][A-Za-z\d]*);/g;

/** The line with its entities blanked, spaces standing in so offsets keep their meaning. */
function maskJsxEntities(line: string): string {
  return line.replace(JSX_ENTITY, (entity) => " ".repeat(entity.length));
}

/**
 * What a reader sees of a line: its closed interpolations and its entities both blanked out, with
 * the expression depth the line leaves open behind them.
 */
function maskJsxRendered(line: string): { masked: string; depth: number } {
  const { masked, depth } = maskJsxExpressions(line);
  return { masked: maskJsxEntities(masked), depth };
}

/** What the line above leaves open, which is what the line under it is reading. */
type JsxLine =
  /** Program — nothing above it renders. */
  | "code"
  /** The attribute list of a tag whose `>` has not arrived yet. */
  | "tag"
  /** A static prop's quoted value, still unterminated, and the quote that opened it. */
  | { prop: string }
  /**
   * The rendered children of the tags still open above, and how many of them there are. The count
   * is what a closing tag on the line is subtracted from: collapsing every depth to one parent
   * ends the outer element's text on a child's `</span>`, and the prose behind it reads as program.
   */
  | { text: number }
  /**
   * An interpolation the lines above left open, at the brace depth it still stands at, inside the
   * elements holding it. The depth is carried because the expression can close on the line that
   * names the symbol — `<span />} Widget was removed` — and past that brace the parent's children
   * resume, so a line inside an expression is not program all the way across.
   */
  | { expression: number; text: number };

/**
 * The line with every tag it finishes blanked out, how many elements those tags leave open, and
 * where the last of them ended — the point rendered text resumes from.
 * A sibling closes only itself: `<span>hello</span>` under a `<div>` ends its own text and not the
 * paragraph beside it, so counting its `</span>` as the end of the parent makes the prose under it
 * program again — and a line naming a removed component then proves its own caller.
 */
function jsxTags(line: string): { net: number; remainder: string; after: number } {
  let net = 0;
  let after = 0;
  const remainder = line.replace(JSX_TAGS, (tag, at: number) => {
    if (tag.startsWith("</")) net -= 1;
    // A self-closing element renders nothing after itself, so it opens nothing either.
    else if (!tag.endsWith("/>")) net += 1;
    after = at + tag.length;
    return " ".repeat(tag.length);
  });
  return { net, remainder, after };
}

/**
 * Where the tag open above ends on this line, and the attribute quote it still leaves open. Quoted
 * values are walked rather than scanned for, so `title="a > b"` does not close the tag on the `>`
 * it shows a reader, and a value that wraps is known to be still open on the line under it.
 */
function jsxTagEnd(text: string, quote?: string): { at: number; quote?: string } {
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\\") at += 1;
    else if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (QUOTE.test(char)) quote = char;
    else if (char === ">") return { at };
  }
  return { at: -1, quote };
}

/**
 * Where the expression a line above left open finishes on this line, and the depth it still stands
 * at when it doesn't. An interpolation wraps as ordinary formatting — `{ready &&` with the child it
 * renders under it — and its braces are the element's own child rather than the end of the element:
 * the text after the closing brace is what the tag still open above renders. Quotes are walked the
 * way `maskJsxExpressions` walks them, since inside an expression a brace a string holds is a
 * character rather than a delimiter.
 */
function jsxExpressionEnd(text: string, depth: number): { at: number; depth: number } {
  let quote: string | undefined;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\\") at += 1;
    else if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (QUOTE.test(char)) quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { at, depth };
    }
  }
  return { at: -1, depth: Math.max(0, depth) };
}

/**
 * What each line of a JSX file starts inside — the rendered text a tag left open above (`<p>` with
 * `Widget was removed` under it), or the attribute list of a tag whose props wrapped onto lines of
 * their own. Both wrap as ordinary formatting, and judging such a line alone finds no tag before
 * the symbol, so a paragraph or a `title=` naming a removed component reads as program text and
 * deletes a true finding about a genuinely unused one. MDX and markup carry the same state across
 * their lines for the same reason.
 *
 * The run ends at the first line that reads as program once its tags are blanked — a call, an
 * assignment — and at a blank line, read from `raw` so a line masking emptied is not mistaken for
 * the break. An interpolation the line leaves open inside an element ends nothing: it is a child
 * of the tag still open above, so its own lines read as the program they are and the parent's text
 * resumes on the brace that closes it. Ending the run there instead reads the prose under a
 * wrapped `{ready &&` as program, and a paragraph naming a removed component proves its own
 * caller. Within a run the open elements are counted rather than remembered as
 * one flag, so a nested sibling ends its own text and not its parent's. A module's generics and
 * comparisons cannot be told from tags without a parser, so a line the tag test misreads
 * (`Map<string, Widget>` closes with the same `>`) can only carry prose into the lines under it
 * until the next program line rather than into the rest of the file: misreading a program as
 * rendered text drops real callers wholesale, which is the costlier direction in the language this
 * repo is mostly written in. For the same reason a wrapped tag is only entered from a line that
 * already reads as markup — `a<b` at the end of a statement opens nothing.
 */
function jsxLineStates(code: string[], raw: string[]): JsxLine[] {
  const states: JsxLine[] = [];
  let depth = 0;
  let tag = false;
  let quote: string | undefined;
  let expression = 0;
  for (const [index, line] of code.entries()) {
    states.push(
      expression > 0
        ? { expression, text: depth }
        : tag
          ? quote === undefined
            ? "tag"
            : { prop: quote }
          : depth > 0
            ? { text: depth }
            : "code",
    );
    if (!raw[index]?.trim()) {
      depth = 0;
      tag = false;
      quote = undefined;
      expression = 0;
      continue;
    }
    let text = line;
    if (expression > 0) {
      const end = jsxExpressionEnd(text, expression);
      expression = end.at < 0 ? end.depth : 0;
      if (end.at < 0) continue;
      // Past the brace that closed it the line is the parent's children again.
      text = text.slice(end.at + 1);
    }
    const { masked: rendered, depth: open } = maskJsxRendered(text);
    let rest = rendered;
    if (tag) {
      const end = jsxTagEnd(rest, quote);
      if (end.at < 0) {
        quote = end.quote;
        continue;
      }
      if (rest[end.at - 1] !== "/") depth += 1;
      rest = rest.slice(end.at + 1);
      tag = false;
      quote = undefined;
    }
    const opener = JSX_TAG_OPEN.exec(rest);
    const { net, remainder } = jsxTags(opener ? rest.slice(0, opener.index) : rest);
    // Inside an element the line is that element's children, where arithmetic and the brackets of
    // an aside are punctuation the page shows rather than the program text that ends the run —
    // `<div>` with `A/B testing (soon)` under it still renders the paragraph written below that.
    if ((depth > 0 ? JSX_CHILD_CODE : JSX_CODE).test(remainder)) {
      // An interpolation inside an element is that element's child, not the end of it: `<div>` with
      // `{ready &&` under it still renders the prose written after the brace closes. Dropping the
      // parent here reads that text as program and lets it prove its own caller.
      if (open > 0 && depth > 0) {
        expression = open;
        continue;
      }
      depth = JSX_TEXT.test(rendered) ? 1 : 0;
      continue;
    }
    depth = Math.max(0, depth + net);
    tag = opener !== null;
    quote = opener ? jsxTagEnd(opener[0]).quote : undefined;
  }
  return states;
}

/**
 * Whether a JSX line uses the symbol or merely renders it. A `.jsx`/`.tsx` file is a program, so
 * everything on it is code except what it shows a reader: the text a tag opens, and the value of a
 * plain string prop. `<p>Widget was removed</p>` names the symbol the way a doc page does, and
 * counting that page as a caller deletes a true finding about a genuinely unused symbol.
 *
 * `state` is what the lines above left open — see `jsxLineStates` for why that bound is kept tight.
 * It carries how many elements stand open, not merely that one does: a `</span>` closed two levels
 * deep ends the child it names and leaves the `<div>` around it rendering, so reading any depth as
 * a single parent makes the prose behind that tag program again. An open interpolation carries its
 * brace depth for the same reason — it can close on this very line, and what follows the brace is
 * the parent's children rather than more program.
 *
 * The tags the head finishes are counted the way `jsxLineStates` counts a whole line, so a child
 * element rendered before the prose leaves its parent open rather than ending it:
 * `<p><strong>Note:</strong> Widget was removed</p>` shows the symbol to a reader, and reading the
 * `</strong>` as program would let that paragraph prove its own caller. Rendered text then carries
 * only as far as the prose does — past the last tag the head has to be free of JSX's own
 * delimiters, or the symbol sits inside an expression and the line is program again. Inside a
 * wrapped tag only a static value is prose, so `body={Widget()}` on its own line still counts as
 * the call it is.
 *
 * A value that wrapped ends at the quote that opened it, not at any quote: a double-quoted
 * `title` continued with `It's Widget documentation` holds an apostrophe, and ending the value
 * there reads the prose behind it as program — which lets a page that only names the symbol prove
 * its own caller and delete a true finding. Past that closing quote the line is the tag's
 * attribute list again, so the static prop after it is still what a reader sees.
 *
 * The interpolations the line already closed are blanked first, along with the entities it renders,
 * so the child text resumes after a `{…}` or an `&mdash;` instead of reading as program.
 */
function referencesJsx(line: string | undefined, symbol: string, state: JsxLine = "code"): boolean {
  const wrapped = typeof state === "object" && "prop" in state ? state.prop : undefined;
  const parents = typeof state === "object" && "text" in state ? state.text : 0;
  const opened = typeof state === "object" && "expression" in state ? state.expression : 0;
  return referencesWord(line, symbol, (raw) => {
    let before = raw;
    if (opened > 0) {
      const end = jsxExpressionEnd(before, opened);
      // The expression still runs where the symbol stands, so the symbol is inside the program it
      // holds; only past the brace that closes it is the parent rendering text again.
      if (end.at < 0) return true;
      before = before.slice(end.at + 1);
    }
    const { masked: head } = maskJsxRendered(before);
    if (wrapped !== undefined && !head.includes(wrapped)) return false;
    const inTag = wrapped !== undefined || state === "tag";
    if (inTag && JSX_PROP_LINE.test(head)) return false;
    if (JSX_PROP_TEXT.test(head)) return false;
    const { net, remainder, after } = jsxTags(head);
    const open = (inTag ? 0 : parents) + net;
    return open <= 0 || JSX_CHILD_CODE.test(remainder.slice(after));
  });
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
   * How many signals went without a reference check, because the symbol budget ran out mid-scan
   * and theirs would have needed a search of its own. They ride through counted — but a truncated
   * pass otherwise reads exactly like a fully verified one, so the diagnostics say how much of the
   * scan the check never saw.
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

/** A file read once and reused across symbols: its comments blanked, plus its cross-line state. */
interface MaskedFile {
  code: string[];
  /** For MDX, which lines start inside a block — an expression or ESM statement — left open above. */
  open?: boolean[];
  /** For JSX, what each line starts inside: rendered text, a wrapped tag, or its quoted value. */
  jsx?: JsxLine[];
  /** For markup, where each line is program text: an executable `<script>` body or Astro frontmatter. */
  script?: CodeSpans[];
  /** For markup, how many braced expressions the lines above leave open at each line's start. */
  depth?: number[];
  /** For markup, the quote holding a code-carrying attribute open at each line's start. */
  attr?: (string | undefined)[];
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
 * An import declaration's keyword, at the head of a statement — the start of a line, or after the
 * `;` that closed the one before it. The lookahead keeps the two `import` expressions out:
 * `import('./widget')` loads a module at runtime and `import.meta` reads the module's own record,
 * and blanking either would swallow the code written around it on the same line.
 */
const IMPORT_HEAD = /(?:^|;)[ \t]*import\b(?![ \t]*[(.])/g;

/**
 * How far an import declaration may wrap before the mask gives up on it. A real one runs a few
 * lines; a sentence opening with the word `import` never reaches a module specifier at all, and
 * bounding the search stops that line from blanking the page below it.
 */
const IMPORT_SPAN_LINES = 40;

/** A line an import declaration is plainly unfinished on: broken after `from`, or mid-list. */
const IMPORT_CONTINUES = /(?:,|\bfrom)[ \t]*$/;

/**
 * Where the import declaration opened at `at` on line `from` ends: just past the closing quote of
 * its module specifier, which is the last thing a declaration writes. Undefined when no specifier
 * turns up.
 *
 * The search only follows the statement onto another line while it is visibly unfinished — a
 * binding list still open, or a break after `from` or a comma. `import com.example.Helper;` ends
 * where it stands, so a language that spells its imports without a string never drags the mask
 * over the program below it.
 */
function importEnd(
  code: string[],
  from: number,
  at: number,
): { line: number; at: number } | undefined {
  let depth = 0;
  for (let line = from; line < code.length && line - from <= IMPORT_SPAN_LINES; line += 1) {
    const text = code[line] ?? "";
    const start = line === from ? at : 0;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (char === "'" || char === '"') {
        const close = text.indexOf(char, index + 1);
        return close < 0 ? undefined : { line, at: close + 1 };
      }
      if (char === "{" || char === "(" || char === "[") depth += 1;
      else if (char === "}" || char === ")" || char === "]") depth -= 1;
    }
    if (depth <= 0 && !IMPORT_CONTINUES.test(text.slice(start))) return undefined;
  }
  return undefined;
}

/**
 * A declaration keyword at the head of a statement — the start of a line, or after the `;` that
 * closed the one before it. CommonJS spells an import as a binding, so its stale half hides behind
 * `const`, `let` or `var` rather than behind `import`.
 */
const REQUIRE_HEAD = /(?:^|;)[ \t]*(?:const|let|var)\b/g;

/** A `require` of a quoted module specifier, where an initializer starts. */
const REQUIRE_CALL = /^[ \t]*require[ \t]*\([ \t]*['"]/;

/**
 * Where the binding of the declaration opened at `at` on line `from` ends: at the `=` that starts
 * its initializer, and only when that initializer is a `require` of a quoted module specifier.
 * Undefined for every other declaration — `const total = count + 1` binds a value, not a module,
 * and blanking its pattern would swallow a name the program computes with.
 *
 * The search follows the binding onto another line only while a destructuring pattern is still
 * open, so a `const` that never reaches an `=` cannot drag the mask over the code below it.
 */
function requireBindingEnd(
  code: string[],
  from: number,
  at: number,
): { line: number; at: number } | undefined {
  let depth = 0;
  for (let line = from; line < code.length && line - from <= IMPORT_SPAN_LINES; line += 1) {
    const text = code[line] ?? "";
    const start = line === from ? at : 0;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (char === "{" || char === "(" || char === "[") depth += 1;
      else if (char === "}" || char === ")" || char === "]") depth -= 1;
      else if (char === ";") return undefined;
      else if (char === "=" && depth <= 0)
        return REQUIRE_CALL.test(text.slice(index + 1)) ? { line, at: index } : undefined;
    }
    if (depth <= 0) return undefined;
  }
  return undefined;
}

/**
 * The code with its CommonJS binding lists blanked out. `const { Widget } = require('./widget')`
 * takes a binding exactly as `import { Widget } from './widget'` does, so a module that still
 * requires a symbol it stopped calling would otherwise read as its own caller and erase a true
 * finding — the same stale half the ESM mask exists to discount.
 *
 * Only the pattern between the declaration keyword and its `=` is blanked, never the initializer:
 * `const html = require('./widget').Widget()` calls the symbol on the right of that `=`, and a
 * mask that reached across it would report a live symbol dead.
 */
function maskRequireBindings(code: readonly string[]): string[] {
  const masked = [...code];
  for (let index = 0; index < masked.length; index += 1) {
    let at = 0;
    for (;;) {
      REQUIRE_HEAD.lastIndex = at;
      const head = REQUIRE_HEAD.exec(masked[index] ?? "");
      if (!head) break;
      const opened = head.index + head[0].length;
      const end = requireBindingEnd(masked, index, opened);
      if (!end) {
        at = opened;
        continue;
      }
      if (end.line === index) {
        masked[index] = blankSpans(masked[index], [[opened, end.at]]);
      } else {
        masked[index] = blankSpans(masked[index], [[opened, masked[index].length]]);
        for (let line = index + 1; line < end.line; line += 1) masked[line] = blankAll(masked[line]);
        masked[end.line] = blankSpans(masked[end.line], [[0, end.at]]);
        index = end.line;
      }
      at = end.at;
    }
  }
  return masked;
}

/**
 * The code with its import declarations blanked out. A binding a file imports and never uses is not
 * a caller: `import { Widget } from './widget'` names the symbol as plainly as a call does, so
 * counting it lets one stale import erase a true finding about a symbol nothing invokes. A file
 * that uses what it imports writes the name again somewhere else, and that mention still counts.
 *
 * The statement is blanked through its module specifier, across however many lines it wraps over,
 * so a binding list on lines of its own goes with it — and the code after the `;` on a shared line
 * stays, because it is a statement of its own. An `export … from` is left alone: republishing a
 * symbol under another module's name is a use of it, not a mention.
 *
 * An `import` that reaches no quoted specifier is left standing rather than guessed at, so a
 * language that spells its imports without one (Python, Java) keeps exactly the check it had.
 *
 * CommonJS `require` bindings are masked first, by `maskRequireBindings`, since a repo can spell
 * the same stale binding either way.
 */
function maskImports(code: string[]): string[] {
  const masked = maskRequireBindings(code);
  for (let index = 0; index < masked.length; index += 1) {
    IMPORT_HEAD.lastIndex = 0;
    let at = 0;
    for (;;) {
      IMPORT_HEAD.lastIndex = at;
      const head = IMPORT_HEAD.exec(masked[index] ?? "");
      if (!head) break;
      const opened = head.index + head[0].length - "import".length;
      const end = importEnd(masked, index, head.index + head[0].length);
      if (!end) {
        at = head.index + head[0].length;
        continue;
      }
      if (end.line === index) {
        masked[index] = blankSpans(masked[index], [[opened, end.at]]);
      } else {
        masked[index] = blankSpans(masked[index], [[opened, masked[index].length]]);
        for (let line = index + 1; line < end.line; line += 1) masked[line] = blankAll(masked[line]);
        masked[end.line] = blankSpans(masked[end.line], [[0, end.at]]);
        index = end.line;
      }
      at = end.at;
    }
  }
  return masked;
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
    const flavor: MarkupFlavor = isMarkup ? markupFlavorOf(file) : "static";
    const isJsx = !isMdx && !isMarkup && JSX_FILE.test(file);
    if (!masked.has(file)) {
      try {
        const text = await readFile(join(repoPath, file), { encoding: "utf8", signal: abort });
        // MDX's markdown — its fences and code spans — is blanked before the JSX comment grammar
        // runs, so a `/*` or `//` shown inside an example can't open a comment across the program.
        const code = maskComments(isMdx ? maskMdxProse(text) : text, syntax);
        const raw = text.split("\n");
        const markup = isMarkup ? markupProgram(code, file) : undefined;
        masked.set(file, {
          // Imports are blanked last, off the program text every state below was tracked through:
          // an `import` is what opens MDX's ESM block and what a wrapped specifier list continues,
          // so masking it before those are read would close the block over the lines under it.
          code: maskImports(markup?.code ?? code),
          open: isMdx ? mdxOpenLines(code, raw) : undefined,
          jsx: isJsx ? jsxLineStates(code, raw) : undefined,
          script: markup?.script,
          depth: markup && markupOpenDepths(markup.code, markup.script, raw, flavor),
          attr: markup && markupOpenAttrs(markup.code, markup.script, raw),
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
        return referencesMarkup(
          text,
          symbol,
          {
            code: entry.script?.[line - 1],
            depth: entry.depth?.[line - 1],
            attr: entry.attr?.[line - 1],
          },
          flavor,
        );
      if (isJsx) return referencesJsx(text, symbol, entry.jsx?.[line - 1]);
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
 * falsifies exactly that — a line that imports the symbol excepted, since a binding a file took and
 * never used is the stale half of the same finding.
 *
 * Every file this scan reports as declaring the symbol is excluded, because
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

  for (const signal of relevant) {
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
      // Out of budget: this signal is reported without a reference check, and the count of what
      // went unverified travels with the result. The pass keeps going rather than stopping here —
      // a signal whose symbol was already searched is answered from `seen` for free, so only the
      // ones that would need a new grep go unchecked.
      if (seen.size >= SYMBOL_BUDGET) {
        unchecked += 1;
        continue;
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
