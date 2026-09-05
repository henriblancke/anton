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
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { promisify } from "node:util";
import { aliasTarget, claimingRules, readDirAliases, type AliasRule } from "./scan-coupling";
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
 * Files that are DATA by construction. JSON has no call syntax at all: a `"Widget"` in a fixture, a
 * snapshot, a locale bundle or a lockfile is a string, and reading it as a caller deletes a true
 * finding (anton-23xe). The unknown-language path cannot save it — that grammar leaves quoted
 * strings intact on purpose, since in a language anton tracks no rules for a quote means something
 * else as often.
 *
 * A manifest naming a symbol some loader resolves at runtime is the case this gives up: it is no
 * longer credited as a caller, so the signal stands and gets triaged. That is the direction this
 * filter errs in, and the direction the current reading gets backwards.
 */
const DATA_FILE = /\.(?:json|jsonc|json5)$/i;

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
  /**
   * What has to precede a block opener for the span it opens to be an expression rather than a
   * comment. Python's `"""` opens a docstring, but `f"""` opens an f-string: the text between its
   * braces is a program, and `f"""{Widget()}"""` calls the symbol as plainly as bare code does.
   * Blanking that span erases the call and reports a live symbol dead, so the prefix is read and
   * only the literal text around each `{…}` is masked.
   */
  interpolated?: RegExp;
  /**
   * Whether the language writes regex literals, whose body is punctuation rather than syntax.
   * `s.split(/\//).map(Widget)` opens no comment: blanking from the `//` inside that literal erases
   * the call behind it, and the file then proves no caller for a signal it had in fact disproved.
   * Only where a `/` can BEGIN a literal is one stepped over — after a value the same `/` divides,
   * and skipping `a / b(c) / d` as a literal would swallow a comment that really did open past it.
   */
  regex?: boolean;
}

/**
 * The Python string prefix that makes the triple-quoted literal after it an f-string. Only `f`
 * decides it; `r`, `b` and `u` may ride along in any order. The prefix has to start on a word
 * boundary, so a name that merely ends in one of those letters — `conf"""` — still opens the
 * docstring it always did.
 */
const F_STRING_PREFIX = /(?:^|[^\w])[rRbBuU]*[fF][rRbBuU]*$/;

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
    // Held apart from the C-like grammar below for the one thing only JavaScript writes: a regex
    // literal, whose body carries comment delimiters that delimit nothing (`/\//`, `/[/*]/`).
    // Matched first, so a `.ts` file never reaches the entry that would read those as comments.
    files: /\.[cm]?[jt]sx?$/i,
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: "\"'`",
    regex: true,
  },
  {
    files: /\.(?:go|java|c|h|cc|cpp|hpp|cs|css|scss|less|dart|proto)$/i,
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
    interpolated: F_STRING_PREFIX,
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
 * The prefixes a `/` can only OPEN a regex literal after: the start of the text, an opener, a
 * separator, an operator, or a keyword that expects an expression next. After a value — a `)`, a
 * `]`, an identifier — the same `/` divides, and stepping over `a / b(c) / d` as a literal hides a
 * comment that opened past it. `++`/`--` are excluded because `i++ / 2` divides: the trailing `+`
 * there is a postfix operator that does yield a value.
 *
 * `<` and `>` are left out although they lead an expression too, because the same characters are
 * JSX punctuation: `</div>` closes a tag, and reading its slash as an opener would run an invented
 * literal over the braced JSX comment beside it and leave that comment unmasked — prose as code,
 * which is the one direction this filter never errs in. A comparison against a regex's source is
 * rare enough to pay for that; missing one only over-masks.
 */
const REGEX_PREFIX =
  /(?:^|=>|\.\.\.|[([{,;:=!&|?*%^~/]|(?<!\+)\+|(?<!-)-|\b(?:return|case|typeof|throw|instanceof|delete|void|yield|await|new|in|of|else|do))\s*$/;

/**
 * Where a regex literal opens at or after `from`, or -1 when nothing on the line does. A `/` before
 * a `*` or another `/` is the comment opener itself — neither spells a legal empty literal — so the
 * markers this scan exists to find can never be mistaken for one.
 */
function regexAt(line: string, from: number): number {
  for (let at = line.indexOf("/", from); at >= 0; at = line.indexOf("/", at + 1)) {
    const next = line[at + 1];
    if (next === "/" || next === "*") continue;
    if (REGEX_PREFIX.test(line.slice(0, at))) return at;
  }
  return -1;
}

/**
 * Where the regex literal opened at `at` ends, or -1 when it never closes on the line — which
 * proves the slash was not one, since the grammar forbids the break. An escape and a character
 * class are stepped over, so `/\//` and `/[/*]/` both close where they actually close.
 */
function regexEnd(line: string, at: number): number {
  let inClass = false;
  for (let cursor = at + 1; cursor < line.length; cursor += 1) {
    const char = line[cursor];
    if (char === "\\") cursor += 1;
    else if (inClass) inClass = char !== "]";
    else if (char === "[") inClass = true;
    else if (char === "/") return cursor + 1;
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
 *
 * A regex literal is stepped over the same way where the language writes one, since its body holds
 * punctuation rather than syntax: `s.split(/\//).map(Widget)` carries a `//` that opens nothing,
 * and blanking from it erases the call behind it. A literal that never closes on its line is not
 * one either, so that scan resumes just past its slash as the quote scan does.
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
    let quoteAt = -1;
    let quote = "";
    if (quotes !== undefined) {
      for (let cursor = at; cursor < line.length; cursor += 1) {
        const char = line[cursor];
        if (char !== undefined && quotes.includes(char)) {
          quoteAt = cursor;
          quote = char;
          break;
        }
      }
    }
    const literalAt = syntax.regex === true ? regexAt(line, at) : -1;
    // Whichever literal opens FIRST is the one the marker might be sitting inside; a marker ahead of
    // both is a comment, and nothing past it on the line is read at all.
    if (quoteAt >= 0 && (literalAt < 0 || quoteAt < literalAt)) {
      if (found !== undefined && found.at <= quoteAt) return found;
      const end = stringEnd(line, quoteAt, quote);
      at = end < 0 ? quoteAt + 1 : end + 1;
      continue;
    }
    if (literalAt < 0) return found;
    if (found !== undefined && found.at <= literalAt) return found;
    const end = regexEnd(line, literalAt);
    // A literal that closes on the marker's OWN slash never was one: `a! / b // note` divides on a
    // postfix assertion the prefix rule reads as an operator, and the `//` it ran to is the comment.
    // A real literal closes past its delimiters — `/[/*]/` ends on a slash the marker doesn't own.
    if (found !== undefined && end - 1 === found.at) return found;
    at = end < 0 ? literalAt + 1 : end;
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
 * An interpolated literal open across lines: what closes it, how deep braces are stacked, and the
 * quote of a string still open inside the interpolation.
 */
interface OpenFString {
  closer: string;
  depth: number;
  quote?: string;
}

/** The quotes Python writes a string with inside an interpolation. */
const PY_QUOTE = /["']/;

/**
 * Where the string opened by `quote` ends, and whether it ended on this line. A backslash escapes
 * the character behind it, so `'\''` runs past its own quote rather than closing on it.
 */
function closePyString(line: string, from: number, quote: string): { at: number; closed: boolean } {
  let at = from;
  while (at < line.length) {
    if (line[at] === "\\") {
      at += 2;
      continue;
    }
    if (line.startsWith(quote, at)) return { at: at + quote.length, closed: true };
    at += 1;
  }
  return { at: line.length, closed: false };
}

/**
 * Where the open f-string ends on this line, and which spans of it are literal text. An
 * interpolation is a program, not prose: `f"""{Widget()}"""` calls the symbol, so only the text
 * around each `{…}` is blanked. `{{` and `}}` escape a brace rather than opening or closing one,
 * and a brace still open at the end of the line carries its depth onto the next.
 *
 * A brace inside a string the interpolation holds is a character rather than a delimiter:
 * `f"""{ {'}}': Widget()} }"""` closes on the brace its punctuation matches, and counting the
 * quoted one ends the expression early — which blanks the call behind it and reports a live symbol
 * dead. Only a triple-quoted string carries onto the next line; a single-quoted one ends with it.
 */
function scanFString(
  line: string,
  from: number,
  open: OpenFString,
): { at: number; closed: boolean; spans: [number, number][] } {
  const spans: [number, number][] = [];
  let literal = open.depth === 0 ? from : -1;
  const blankTo = (end: number): void => {
    if (literal >= 0 && end > literal) spans.push([literal, end]);
    literal = -1;
  };
  let at = from;
  while (at < line.length) {
    if (open.depth > 0) {
      if (open.quote !== undefined) {
        const quoted = closePyString(line, at, open.quote);
        at = quoted.at;
        if (quoted.closed) open.quote = undefined;
        continue;
      }
      if (PY_QUOTE.test(line[at])) {
        const triple = line[at].repeat(3);
        const quote = line.startsWith(triple, at) ? triple : line[at];
        const quoted = closePyString(line, at + quote.length, quote);
        at = quoted.at;
        if (!quoted.closed && quote.length === 3) open.quote = quote;
        continue;
      }
      if (line[at] === "{") open.depth += 1;
      else if (line[at] === "}") {
        open.depth -= 1;
        if (open.depth === 0) literal = at + 1;
      }
      at += 1;
      continue;
    }
    if (line.startsWith(open.closer, at)) {
      const end = at + open.closer.length;
      blankTo(end);
      return { at: end, closed: true, spans };
    }
    if (line.startsWith("{{", at) || line.startsWith("}}", at)) {
      at += 2;
      continue;
    }
    if (line[at] === "{") {
      blankTo(at);
      open.depth = 1;
    }
    at += 1;
  }
  blankTo(line.length);
  return { at: line.length, closed: false, spans };
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
  let openF: OpenFString | undefined;
  return text.split("\n").map((line) => {
    const spans: [number, number][] = [];
    let at = 0;
    while (at < line.length) {
      if (openF) {
        const scan = scanFString(line, at, openF);
        spans.push(...scan.spans);
        at = scan.at;
        if (scan.closed) openF = undefined;
        continue;
      }
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
      if (syntax.interpolated?.test(line.slice(0, opened.at))) {
        openF = { closer: opened.closer, depth: 0 };
        continue;
      }
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

/** Shell scripts, whose heredoc payloads are data the interpreter never runs as code. */
const SHELL_FILE = /\.(?:sh|bash|zsh)$/i;

/** What ends a shell word: whitespace, a redirection, or an operator. */
const WORD_END = /[\s;&|<>()]/;

/**
 * The delimiter word a heredoc opener names, read the way the shell reads it, and whether any part
 * of it was quoted.
 *
 * A delimiter is an ordinary shell WORD, so it may be assembled from quoted and unquoted pieces:
 * `<<'E'OF`, `<<"E"OF` and `<<\EOF` all end at a line reading `EOF` (anton-23xe). Reading only the
 * first piece leaves a terminator that never matches, which blanks the rest of the script; and a
 * spelling matched not at all leaves the payload read as executable, which invents a caller and
 * deletes a true finding — the worse of the two.
 *
 * Quoting ANY piece makes the whole payload literal, which is why one flag covers the word.
 */
function heredocWord(line: string, from: number): { word: string; quoted: boolean; end: number } {
  let word = "";
  let quoted = false;
  let at = from;
  while (at < line.length && !WORD_END.test(line[at] as string)) {
    const char = line[at];
    if (char === "'" || char === '"') {
      let close = at + 1;
      while (close < line.length && line[close] !== char) close += char === '"' && line[close] === "\\" ? 2 : 1;
      // An unclosed quote is not a delimiter anton can trust; naming none leaves the payload read
      // as code, which is what every line of this script already is.
      if (close >= line.length) return { word: "", quoted, end: line.length };
      word += line.slice(at + 1, close);
      quoted = true;
      at = close + 1;
    } else if (char === "\\") {
      if (at + 1 >= line.length) return { word: "", quoted, end: line.length };
      word += line[at + 1];
      quoted = true;
      at += 2;
    } else {
      word += char;
      at += 1;
    }
  }
  return { word, quoted, end: at };
}

/**
 * The part of a shell line before its comment. `#` opens one only at the start of a word and only
 * outside quotes, so `echo "a # b"` carries none and `a#b` is one word (anton-23xe).
 *
 * Reading a comment as code queues a delimiter no later line answers, which blanks the rest of the
 * script; reading code as a comment loses an opener and leaves its payload read as executable,
 * which invents a caller. Tracking the quotes is what keeps both out.
 *
 * The quoted text itself is left ALONE. A delimiter is quoted to make its payload literal, so
 * blanking the spans here would erase the quotes on `<<'EOF'` and lose the opener entirely; the
 * `<<` operator's own quoting is judged in `heredocOpeners`, where the two can be told apart.
 */
function shellCode(line: string): string {
  let quote: string | undefined;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (char === "\\" && quote !== "'") {
      at += 1;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    // A `#` opens a comment where a WORD may start, which is after a metacharacter as surely as
    // after a space: `true;# cat <<EOF` is a comment, and reading it as code queues an `EOF` no
    // later line answers and blanks the rest of the script (PR #190 review). Redirection operators
    // are left out — `heredocOpeners` reads `<<` off this same text, and a `#` behind one is not a
    // shape worth risking that on.
    if (char === "#" && (at === 0 || /[\s;&|()]/.test(line[at - 1] as string))) {
      return line.slice(0, at);
    }
  }
  return line;
}

/** Every heredoc a line opens, in the order their payloads follow. */
function heredocOpeners(line: string): { word: string; dash: boolean; quoted: boolean }[] {
  const found: { word: string; dash: boolean; quoted: boolean }[] = [];
  let quote: string | undefined;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (char === "\\" && quote !== "'") {
      at += 1;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    // A `<<` inside a literal redirects nothing: `echo "example <<EOF here"` is one argument, and
    // queueing `EOF` off it waits for a terminator no later line answers (anton-23xe).
    if (char !== "<" || line[at + 1] !== "<") continue;
    // `<<<` is a here-string and `<<=` a shift-assign; neither opens a payload.
    if (line[at - 1] === "<" || line[at + 2] === "<" || line[at + 2] === "=") continue;
    let cursor = at + 2;
    const dash = line[cursor] === "-";
    if (dash) cursor += 1;
    while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
    const { word, quoted, end } = heredocWord(line, cursor);
    if (word) found.push({ word, dash, quoted });
    at = Math.max(end - 1, at + 1);
  }
  return found;
}

/**
 * One payload line of an EXPANDING heredoc, with everything but its command substitutions blanked.
 * A bare-delimiter heredoc is not inert: the shell runs `$(…)` and a backquoted span while it
 * writes the payload out, so `cat <<EOF` over `$(Widget)` really does call the symbol, and blanking
 * the line wholesale hides that caller and leaves a false finding standing (anton-23xe).
 *
 * Everything outside a substitution is text the shell only copies, so it is blanked exactly as a
 * quoted payload is. `\$(` is escaped and expands to nothing, and `${name}` is a parameter — a
 * value, not a call — so neither opens a span. Nesting is counted, because `$(a $(b))` closes on
 * its second `)` and stopping at the first would blank the tail of the outer command.
 *
 * Both span shapes are carried out to the caller in `SubstitutionState`, because both can run past
 * the end of a payload line. `$(` had its depth carried already; a backquoted span opened on one
 * line and closed on a later one used to run to the end of its opener and leave NOTHING behind, so
 * every line under it was blanked as inert data and a `Widget` call between the two backticks went
 * unseen — the live symbol then stayed reported dead (PR #190 review).
 *
 * A backquoted span does not nest, so it ends at the next unescaped backquote; while one is open
 * the `$(` grammar is not read, which is the mutual exclusion this already assumed on one line.
 */
interface SubstitutionState {
  /** How many `$(` are open. */
  depth: number;
  /** Whether a backquoted span is open. */
  backtick: boolean;
}

const NO_SUBSTITUTION: SubstitutionState = { depth: 0, backtick: false };

function unmaskedSubstitutions(
  line: string,
  from: SubstitutionState = NO_SUBSTITUTION,
): { text: string } & SubstitutionState {
  const out = blankAll(line).split("");
  let { depth, backtick } = from;
  for (let at = 0; at < line.length; at += 1) {
    const inside = depth > 0 || backtick;
    if (line[at] === "\\") {
      if (inside) out[at] = line[at];
      at += 1;
      if (inside && at < line.length) out[at] = line[at];
      continue;
    }
    if (backtick) {
      // The closing backquote is punctuation, not code, so it stays blank like the opening one.
      if (line[at] === "`") backtick = false;
      else out[at] = line[at];
      continue;
    }
    if (depth === 0 && line[at] === "$" && line[at + 1] === "(") {
      depth = 1;
      at += 1;
      continue;
    }
    if (depth === 0 && line[at] === "`") {
      backtick = true;
      continue;
    }
    if (depth === 0) continue;
    if (line[at] === "(") depth += 1;
    else if (line[at] === ")") {
      depth -= 1;
      if (depth === 0) continue;
    }
    out[at] = line[at];
  }
  return { text: out.join(""), depth, backtick };
}

/**
 * A shell script with its heredoc payloads blanked. `cat <<'EOF'` followed by `Widget()` writes a
 * file; it does not call the symbol, and reading that payload as code invents a caller and deletes
 * a true finding (anton-23xe). Scripts that scaffold source or emit documentation are exactly where
 * a symbol's name shows up inside one.
 *
 * The opener's own line stays code — it is a real command, and a call beside the `<<` runs. Only
 * the payload and its terminator are blanked, and blanking preserves the line count because every
 * reference here is judged by line index against the raw text.
 *
 * A script may open more than one heredoc on a line (`cmd <<A <<B`), and their payloads follow in
 * the order the openers were written, so the pending words are held as a queue. `<<-` strips
 * leading TABS from the terminator, which is the only indentation the form allows.
 */
function maskHeredocs(text: string): string {
  const pending: { word: string; dash: boolean; quoted: boolean }[] = [];
  // Where the payload's command substitution stands as the next line begins. A `$(` opened on one
  // payload line closes on a later one — `$(\n  Widget\n)` is one command — so the state is carried
  // rather than reset per line, which would blank the call inside it (anton-23xe). A backquoted
  // span spreads over lines the same way and is carried with it (PR #190 review).
  let substitution: SubstitutionState = NO_SUBSTITUTION;
  return text
    .split("\n")
    .map((line) => {
      const open = pending[0];
      if (open) {
        const terminator = open.dash ? line.replace(/^\t+/, "") : line;
        if (terminator === open.word) {
          pending.shift();
          substitution = NO_SUBSTITUTION;
          return blankAll(line);
        }
        // A quoted delimiter makes the whole payload literal; a bare one leaves its command
        // substitutions running, and those are code however the rest of the payload reads.
        if (open.quoted) return blankAll(line);
        const masked = unmaskedSubstitutions(line, substitution);
        substitution = { depth: masked.depth, backtick: masked.backtick };
        return masked.text;
      }
      // Openers are read off the CODE part only. This pass runs before the comment grammar, so a
      // `# cat <<EOF` shown in a comment would otherwise queue a terminator that never arrives and
      // blank every line below it.
      const opened = heredocOpeners(shellCode(line));
      if (opened.length > 0) substitution = NO_SUBSTITUTION;
      pending.push(...opened);
      return line;
    })
    .join("\n");
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
 * A tag's name, spelled the way a JSX binding is: `<_Panel>` and `<$Panel>` resolve to a symbol
 * exactly as `<Panel>` does. Reading only a letter as the start leaves their tag unopened, which
 * hands the text behind it back as program and lets `<_Panel>Widget was removed</_Panel>` prove
 * its own caller.
 */
const JSX_NAME = String.raw`[A-Za-z_$][\w.$:-]*`;

/**
 * A tag this line opens and leaves open — `<p>`, `<Panel tone="warn">`, the fragment `<>` — so what
 * follows it is rendered. A fragment counts because prose is written straight inside one, and
 * reading `<>` with `Widget was removed` under it as program text deletes a true finding. Not a
 * self-closing `<Icon />`, which renders nothing after itself and leaves the code beside it code,
 * and not a closing `</p>` or `</>`, which ends the text rather than starting it.
 */
const JSX_OPEN_TAG = String.raw`(?:<>|<${JSX_NAME}(?:\s${JSX_ATTRS})?(?<![/])>)`;

/**
 * The delimiters JSX spells its own syntax with — a tag's angle brackets and the braces of an
 * interpolation. They are the only punctuation that can open program between a tag and its
 * children, since code stands there solely inside a `{…}`.
 */
const JSX_CHILD_DELIMITERS = String.raw`<>{}`;

/**
 * The backtick a template literal opens with, the backslash that escapes a character inside one,
 * and the `|` of a union or an `||` — program on a line standing outside every element, and marks a
 * sentence shows inside one: ``<p>Use `Widget` instead | see the changelog</p>`` renders that
 * punctuation to a reader, and reading it as program lets a prose-only page prove its own caller
 * and delete a true finding. None of them opens code between a tag and its children, where a
 * template literal or an `||` stands inside a `{…}`, which is a delimiter of its own.
 */
const JSX_LITERALS = String.raw`\\|\``;

/**
 * The square brackets, which index and list outside every element — `const [first] = items` — and
 * are the marks a sentence names a thing with inside one: `<p>[Widget] was removed</p>` shows the
 * symbol to a reader the way a doc page does, and reading that label as program lets a prose-only
 * page prove its own caller and delete a true finding. An array written between a tag and its
 * children stands inside a `{…}`, which is a delimiter of its own.
 */
const JSX_BRACKETS = String.raw`[\]`;

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
 * The equals sign, which binds a name outside an element — `const label = title` — and is a
 * character a sentence shows inside one: `<p>Status = Widget was removed</p>` names the symbol the
 * way a doc page does, and reading that equals as program lets a prose-only page prove its own
 * caller and delete a true finding. A prop's `=` is not this one — an attribute list is read as a
 * tag rather than as children.
 */
const JSX_ASSIGNMENT = String.raw`=`;

/**
 * Every delimiter that means something on a line standing outside an element. A generic closes with
 * the same `>` a tag does — `new Map<Widget>()` — so text that claims to be rendered has to read as
 * a sentence before it is believed, or a real call goes uncounted.
 */
const JSX_DELIMITERS = `${JSX_CHILD_DELIMITERS}${JSX_LITERALS}${JSX_BRACKETS}${JSX_PARENS}${JSX_STATEMENT}${JSX_ASSIGNMENT}`;

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
 * That same test for text a tag has opened, where an operator, an aside, a bracketed label, the
 * semicolon between two clauses, the equals sign in a sentence, a backticked name and the `|`
 * between two labels are punctuation the page shows.
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
const JSX_PROP_TEXT = new RegExp(String.raw`<${JSX_NAME}\s${JSX_ATTRS}${JSX_PROP_VALUE}`);

/**
 * That same prop on a line the tag opened above. An attribute list wraps onto lines of its own as
 * ordinary formatting, so the opener the whole-tag test needs is a line away — and a static value
 * judged without it reads as program, which lets a prop that merely names the symbol prove its own
 * caller.
 */
const JSX_PROP_LINE = new RegExp(JSX_PROP_VALUE);

/** Every tag a line finishes: one it opens, the `</p>` that ends one, the self-closing `<Icon />`. */
const JSX_TAGS = new RegExp(
  String.raw`${JSX_OPEN_TAG}|</(?:${JSX_NAME}\s*)?>|<${JSX_NAME}(?:\s${JSX_ATTRS})?/>`,
  "g",
);

/**
 * A tag this line opens and leaves unfinished — `<Empty` with its props on the lines below, or an
 * attribute whose quoted value wraps. The value that wraps is matched unterminated so `jsxTagEnd`
 * can name the quote still open, and so a `>` a closed value shows does not pass for the end of a
 * tag that in fact runs on.
 */
const JSX_TAG_OPEN = new RegExp(
  String.raw`<${JSX_NAME}(?:\s${JSX_ATTRS}(?:"[^"]*|'[^']*)?)?$`,
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
 *
 * A backslash is an ordinary character here. A static prop's value is quoted the way HTML quotes
 * one — JSX gives it no escapes at all — so reading `title="C:\"` as an escaped quote leaves the
 * attribute open, hands the rest of the line to it as rendered text, and the call standing there
 * stops counting as a caller, leaving a false finding (anton-23xe). The interpolations, where a
 * backslash IS an escape, are blanked before this runs.
 */
function jsxTagEnd(text: string, quote?: string): { at: number; quote?: string } {
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quote !== undefined) {
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
 * assignment. A blank line ends nothing, unlike in MDX and markup: JSX gives one no meaning, and a
 * component that spaces its children apart — `<div>` with an empty line above `Widget was removed`
 * — still renders the paragraph under the gap, so closing the element there reads that prose as
 * program and lets it prove its own caller. An interpolation the line leaves open inside an element
 * ends nothing either: it is a child of the tag still open above, so its own lines read as the
 * program they are and the parent's text
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
function jsxLineStates(code: string[]): JsxLine[] {
  const states: JsxLine[] = [];
  let depth = 0;
  let tag = false;
  let quote: string | undefined;
  let expression = 0;
  for (const line of code) {
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
    // An empty line carries no tag and no brace, so it leaves every run exactly as it found it —
    // a comment masking emptied no more ends the element above it than a blank one does.
    if (!line.trim()) continue;
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
 * A wrapped tag also ENDS on the line that names the symbol — `<div` with its props above and
 * `>Widget was removed</div>` here — and past that `>` the line is the element's children rather
 * than more of the attribute list. Reading the tail as attributes leaves no element open, so the
 * prose behind the bracket reads as program and a paragraph naming a removed component proves its
 * own caller. Only a `/>` opens nothing, having rendered nothing after itself.
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
    // The bracket that finishes the tag carried from above hands the rest of the line to that
    // element's children, so the symbol behind it is read against the element the bracket opened.
    const ended = inTag ? jsxTagEnd(head, wrapped) : undefined;
    if (ended && ended.at >= 0)
      return jsxHeadIsCode(head.slice(ended.at + 1), head[ended.at - 1] === "/" ? 0 : 1);
    if (inTag && JSX_PROP_LINE.test(head)) return false;
    if (JSX_PROP_TEXT.test(head)) return false;
    return jsxHeadIsCode(head, inTag ? 0 : parents);
  });
}

/**
 * Whether the symbol standing behind `head` is program, given the `parents` elements open above it.
 * Rendered text carries only as far as the prose does: past the last tag the head finishes, JSX's
 * own delimiters mean the symbol sits inside an expression rather than in what a reader sees.
 */
function jsxHeadIsCode(head: string, parents: number): boolean {
  const { net, remainder, after } = jsxTags(head);
  const open = parents + net;
  return open <= 0 || JSX_CHILD_CODE.test(remainder.slice(after));
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

/**
 * Whether a masked line of one file writes a name as code, judged by that file's own grammar and
 * closed over the cross-line state read from its text. `index` is the line's 0-based position, so
 * the state the lines above leave open can be looked up.
 *
 * One predicate answers for the whole file, so the hit check and the alias unmasking below it ask
 * the same question: `<p>Panel was removed</p>` is prose in a `.tsx` file whichever of them is
 * looking at it.
 */
type LineReference = (line: string | undefined, symbol: string, index: number) => boolean;

/** A file read once and reused across symbols: its comments and imports blanked, and how to read it. */
interface MaskedFile {
  code: string[];
  /**
   * The same lines with the import declarations still standing. What a file binds a module to is
   * written only inside the statement `code` blanks, so the default-import search below reads this
   * instead — and reads it with the comments and non-program markup already gone.
   */
  program: string[];
  references: LineReference;
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
    if (PROSE_FILE.test(file) || DATA_FILE.test(file)) continue;
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
 * A binding an import takes under another name: where the imported symbol is written, and the local
 * name it lands under. The mask exists to discount a binding nothing uses, but a renamed one is the
 * opposite case — `import { Widget as Renamed } from './widget'; Renamed()` writes `Widget` just
 * once, inside the statement being blanked, and the call beside it is spelled `Renamed`, which the
 * searched symbol can never match. Blanking that leaves a live symbol with no caller anywhere.
 */
interface AliasBinding {
  /** The line the imported name is written on. */
  line: number;
  /** Where the imported name starts on it. */
  at: number;
  /** The imported name — what a hit for the symbol matched. */
  name: string;
  /** The local name the binding lands under, and the only spelling the rest of the file can use. */
  local: string;
}

/** Code with one flavour of binding blanked out, and the renamed bindings that went out with it. */
interface MaskedCode {
  code: string[];
  aliases: AliasBinding[];
}

/**
 * `X as Y` — how ESM and Python both spell a renamed binding. The separators admit a line break
 * because a formatter wraps a long binding list wherever it fits, `Widget` on one line and `as
 * Renamed` on the next; matching a line at a time blanks the imported name without putting it
 * back, and the call spelled `Renamed` beside it then matches nothing, leaving a live symbol
 * reported dead (anton-23xe). Only the statement's own span is ever searched, so the break crossed
 * is always one inside it.
 */
const AS_ALIAS = /\b([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g;

/** `{ X: Y }` — how a CommonJS destructuring pattern spells the same rename. */
const KEY_ALIAS = /\b([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/g;

/**
 * The renamed bindings written between `from` and `to`, read off the statement before it is
 * blanked. The span is joined before it is matched so a binding wrapped across lines is read
 * whole, and each name is recorded where it sits — offsets the mask preserves, so the name can be
 * put back exactly where a hit found it.
 */
function aliasBindings(
  code: readonly string[],
  from: { line: number; at: number },
  to: { line: number; at: number },
  pattern: RegExp,
): AliasBinding[] {
  // Each line's segment, with where it begins in the joined span and the column it begins at in
  // the source — the two offsets a match index is read back through.
  const lines: { line: number; offset: number; start: number }[] = [];
  let span = "";
  for (let line = from.line; line <= to.line; line += 1) {
    const text = code[line] ?? "";
    const start = line === from.line ? from.at : 0;
    lines.push({ line, offset: span.length, start });
    span += `${text.slice(start, line === to.line ? to.at : text.length)}\n`;
  }
  const found: AliasBinding[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(span); match; match = pattern.exec(span)) {
    const [, name, local] = match;
    const index = match.index;
    if (name === undefined || local === undefined) continue;
    // An identifier never spans a break, so the name sits whole on the line its match opened.
    const at = lines.findLast((entry) => entry.offset <= index);
    if (!at) continue;
    found.push({ line: at.line, at: at.start + index - at.offset, name, local });
  }
  return found;
}

/**
 * The masked code with the imported name written back for every alias whose local name the file
 * still uses somewhere. The local name inside the binding went out with the mask, so any mention of
 * it left over is a real use — and a binding nothing uses stays blanked, which is the stale half
 * the mask exists to discount.
 *
 * "Uses" is the file's own reading of its lines, not a bare word match: in `import { Widget as
 * Panel } from './widget'` followed by `<p>Panel was removed</p>`, the only mention left is
 * rendered prose, and restoring `Widget` on the strength of it would make a stale import read as a
 * caller and delete the true finding about `Widget`. So an alias is put back on exactly the
 * evidence a hit for the symbol itself would need.
 */
function unmaskUsedAliases(
  source: readonly string[],
  masked: string[],
  aliases: readonly AliasBinding[],
  references: LineReference = (line, symbol) => referencesWord(line, symbol),
): string[] {
  if (aliases.length === 0) return masked;
  const used = aliases.filter((alias) =>
    masked.some((line, index) => references(line, alias.local, index)),
  );
  for (const alias of used) {
    const text = source[alias.line];
    const line = masked[alias.line];
    if (text === undefined || line === undefined) continue;
    const end = alias.at + alias.name.length;
    masked[alias.line] = line.slice(0, alias.at) + text.slice(alias.at, end) + line.slice(end);
  }
  return masked;
}

/**
 * Where the import declaration opened at `at` on line `from` ends: just past the closing quote of
 * its module specifier when the language writes one, and otherwise at the `;` that closes the
 * statement or at the end of the line it stops on. Undefined only when neither turns up inside the
 * span — an unclosed quote, or a binding list left open.
 *
 * The declaration-only endpoint is what a language spelling its imports without a string (Java's
 * `import static pkg.Widget.render;`, Kotlin's `import pkg.Widget`) is masked by: the binding it
 * takes is as stale as an ESM one, and leaving the statement standing let it read as its own
 * caller.
 *
 * The search only follows the statement onto another line while it is visibly unfinished — a
 * binding list still open, or a break after `from` or a comma — so the mask stops on the line the
 * declaration stops on and never reaches the program below it.
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
      // The `;` closes the statement and the code after it is a statement of its own, so the mask
      // ends before it rather than swallowing what shares the line.
      if (char === ";" && depth <= 0) return { line, at: index };
      if (char === "{" || char === "(" || char === "[") depth += 1;
      else if (char === "}" || char === ")" || char === "]") depth -= 1;
    }
    if (depth <= 0 && !IMPORT_CONTINUES.test(text.slice(start))) return { line, at: text.length };
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
 * Whether the initializer starting at `at` on `line` is a `require` of a quoted module specifier,
 * followed across the break a formatter puts after the `=`: `const { Widget } =` with
 * `require('./widget')` under it takes the same stale binding the one-line form does. Reading only
 * the rest of the `=` line rejects it, leaves the binding unmasked, and lets a module that merely
 * still requires the symbol read as its own caller — deleting a true finding (anton-23xe).
 *
 * Only blank lines are crossed. Anything else is the initializer itself, and a `=` whose value is
 * not a `require` binds a value rather than a module.
 */
function requireFollows(
  code: readonly string[],
  from: number,
  line: number,
  at: number,
): boolean {
  for (let index = line; index < code.length && index - from <= IMPORT_SPAN_LINES; index += 1) {
    const text = (code[index] ?? "").slice(index === line ? at : 0);
    if (!text.trim()) continue;
    return REQUIRE_CALL.test(text);
  }
  return false;
}

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
        return requireFollows(code, from, line, index + 1) ? { line, at: index } : undefined;
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
function maskRequireBindings(code: readonly string[]): MaskedCode {
  const masked = [...code];
  const aliases: AliasBinding[] = [];
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
      aliases.push(...aliasBindings(masked, { line: index, at: opened }, end, KEY_ALIAS));
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
  return { code: masked, aliases };
}

/** Files whose imports are Python statements, which name no module string to end on. */
const PYTHON_FILE = /\.pyi?$/i;

/**
 * A Python import statement's head, at the start of a statement — the start of a line, or after the
 * `;` that closed the one before it. The `import` keyword is required on both forms, so a `from`
 * that names something else never opens the mask; the `from` of a chained `raise … from cause` and
 * a `yield from` both stand mid-statement, where this never looks.
 */
const PYTHON_IMPORT_HEAD = /(?:^|;)[ \t]*((?:from[ \t]+[\w.]+[ \t]+)?import\b)/g;

/**
 * Where the Python import statement opened at `at` on line `from` ends: at the `;` that closes it
 * or at the end of its last line. A statement runs onto another line only while a parenthesised
 * binding list is open or a backslash has joined the next one, so an `import` that never closes its
 * list is left standing rather than dragged over the program below it.
 */
function pythonImportEnd(
  code: string[],
  from: number,
  at: number,
): { line: number; at: number } | undefined {
  let depth = 0;
  for (let line = from; line < code.length && line - from <= IMPORT_SPAN_LINES; line += 1) {
    const text = code[line] ?? "";
    for (let index = line === from ? at : 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      else if (char === ";" && depth <= 0) return { line, at: index };
    }
    if (depth <= 0 && !text.endsWith("\\")) return { line, at: text.length };
  }
  return undefined;
}

/**
 * The code with its Python import statements blanked out. `from widget import Widget` takes a
 * binding exactly as `import { Widget } from './widget'` does, so a module that still imports a
 * symbol it stopped calling would otherwise read as its own caller and erase a true finding — the
 * same stale half the ESM mask exists to discount.
 */
function maskPythonImports(code: readonly string[]): MaskedCode {
  const masked = [...code];
  const aliases: AliasBinding[] = [];
  for (let index = 0; index < masked.length; index += 1) {
    let at = 0;
    for (;;) {
      PYTHON_IMPORT_HEAD.lastIndex = at;
      const head = PYTHON_IMPORT_HEAD.exec(masked[index] ?? "");
      if (!head) break;
      const opened = head.index + head[0].length;
      const end = pythonImportEnd(masked, index, opened);
      if (!end) break;
      const start = opened - head[1].length;
      aliases.push(...aliasBindings(masked, { line: index, at: start }, end, AS_ALIAS));
      if (end.line === index) {
        masked[index] = blankSpans(masked[index], [[start, end.at]]);
      } else {
        masked[index] = blankSpans(masked[index], [[start, masked[index].length]]);
        for (let line = index + 1; line < end.line; line += 1) masked[line] = blankAll(masked[line]);
        masked[end.line] = blankSpans(masked[end.line], [[0, end.at]]);
        index = end.line;
      }
      at = end.at;
    }
  }
  return { code: masked, aliases };
}

/** Files whose imports are Rust `use` declarations, which name no module string either. */
const RUST_FILE = /\.rs$/i;

/**
 * A Rust `use` declaration's keyword, at the head of a statement — the start of a line, or after
 * the `;` that closed the one before it.
 *
 * `pub use` and `pub(crate) use` are left standing on purpose: republishing a symbol under this
 * module's path is a use of it, exactly as an ESM `export … from` is. Neither stands at the head of
 * its statement, so neither is matched here.
 */
const RUST_USE_HEAD = /(?:^|;)[ \t]*use\b/g;

/**
 * Where the Rust `use` declaration opened at `at` on line `from` ends: at the `;` that closes it.
 * A grouped list — `use crate::widget::{Widget, Panel}` — is what carries one onto another line, so
 * the search follows it only while a brace is open, and a `}` that closes the block around an
 * unterminated `use` stops it rather than letting the mask reach the program below.
 */
function rustUseEnd(
  code: string[],
  from: number,
  at: number,
): { line: number; at: number } | undefined {
  let depth = 0;
  for (let line = from; line < code.length && line - from <= IMPORT_SPAN_LINES; line += 1) {
    const text = code[line] ?? "";
    for (let index = line === from ? at : 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === "{") depth += 1;
      else if (char === "}") {
        if (depth <= 0) return undefined;
        depth -= 1;
      } else if (char === ";" && depth <= 0) return { line, at: index };
    }
  }
  return undefined;
}

/**
 * The code with its Rust `use` declarations blanked out. `use crate::widget::Widget;` takes a
 * binding exactly as `import { Widget } from './widget'` does, so a module that still imports a
 * symbol it stopped calling would otherwise read as its own caller and erase a true finding — the
 * same stale half the ESM mask exists to discount.
 */
function maskRustUse(code: readonly string[]): MaskedCode {
  const masked = [...code];
  const aliases: AliasBinding[] = [];
  for (let index = 0; index < masked.length; index += 1) {
    let at = 0;
    for (;;) {
      RUST_USE_HEAD.lastIndex = at;
      const head = RUST_USE_HEAD.exec(masked[index] ?? "");
      if (!head) break;
      const opened = head.index + head[0].length;
      const end = rustUseEnd(masked, index, opened);
      if (!end) break;
      const start = opened - "use".length;
      aliases.push(...aliasBindings(masked, { line: index, at: start }, end, AS_ALIAS));
      if (end.line === index) {
        masked[index] = blankSpans(masked[index], [[start, end.at]]);
      } else {
        masked[index] = blankSpans(masked[index], [[start, masked[index].length]]);
        for (let line = index + 1; line < end.line; line += 1) masked[line] = blankAll(masked[line]);
        masked[end.line] = blankSpans(masked[end.line], [[0, end.at]]);
        index = end.line;
      }
      at = end.at;
    }
  }
  return { code: masked, aliases };
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
 * An `import` that reaches no quoted specifier ends at its `;` or at the end of its line instead:
 * `import static pkg.Widget.render;` binds `render` without calling it exactly as an ESM import
 * does, so leaving it standing let one stale Java import erase a true finding. Python spells its
 * imports without a specifier too, but its own grammar — no `;`, parenthesised lists, `from widget
 * import Widget` — is read by `maskPythonImports` instead, and Rust's `use`, which spells the same
 * binding under another keyword entirely, by `maskRustUse`.
 *
 * CommonJS `require` bindings are masked first, by `maskRequireBindings`, since a repo can spell
 * the same stale binding either way.
 *
 * A binding taken under another name is put back by `unmaskUsedAliases` when the file still uses
 * that name: `import { Widget as Renamed } from './widget'` holds the file's only mention of the
 * symbol, and the call beside it is spelled `Renamed`. `references` is how this file reads a line,
 * so that use has to be code by the same rules a hit for the symbol is judged by.
 */
function maskImports(code: string[], file: string, references?: LineReference): string[] {
  if (PYTHON_FILE.test(file)) {
    const python = maskPythonImports(code);
    return unmaskUsedAliases(code, python.code, python.aliases, references);
  }
  if (RUST_FILE.test(file)) {
    const rust = maskRustUse(code);
    return unmaskUsedAliases(code, rust.code, rust.aliases, references);
  }
  const required = maskRequireBindings(code);
  const masked = required.code;
  const aliases = required.aliases;
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
      aliases.push(...aliasBindings(masked, { line: index, at: opened }, end, AS_ALIAS));
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
  return unmaskUsedAliases(code, masked, aliases, references);
}

/**
 * One file read and prepared for every symbol that lands in it: its comments and imports blanked,
 * and the predicate that reads a line of the result — its own grammar when anton tracks one, and
 * the union comment fallback when it doesn't, since an unrecognized extension is no reason to read
 * the middle of a block comment as a call.
 *
 * The predicate is built before the imports are masked, because the mask consults it: an alias is
 * only restored when the file uses its local name as code, which is the same question the hit check
 * asks of the symbol.
 */
async function maskFile(
  repoPath: string,
  file: string,
  abort?: AbortSignal,
): Promise<MaskedFile> {
  const syntax = commentSyntaxOf(file) ?? UNKNOWN_SYNTAX;
  const isMdx = MDX_FILE.test(file);
  const isMarkup = !isMdx && MARKUP_FILE.test(file);
  const flavor: MarkupFlavor = isMarkup ? markupFlavorOf(file) : "static";
  const isJsx = !isMdx && !isMarkup && JSX_FILE.test(file);
  const text = await readFile(join(repoPath, file), { encoding: "utf8", signal: abort });
  // MDX's markdown — its fences and code spans — is blanked before the JSX comment grammar runs,
  // so a `/*` or `//` shown inside an example can't open a comment across the program.
  const code = maskComments(
    isMdx ? maskMdxProse(text) : SHELL_FILE.test(file) ? maskHeredocs(text) : text,
    syntax,
  );
  const raw = text.split("\n");
  const markup = isMarkup ? markupProgram(code, file) : undefined;
  const open = isMdx ? mdxOpenLines(code, raw) : undefined;
  const jsx = isJsx ? jsxLineStates(code) : undefined;
  const depth = markup && markupOpenDepths(markup.code, markup.script, raw, flavor);
  const attr = markup && markupOpenAttrs(markup.code, markup.script, raw);
  const references: LineReference = (line, symbol, index) => {
    if (isMdx) return referencesMdx(line, symbol, open?.[index] === true);
    if (isMarkup)
      return referencesMarkup(
        line,
        symbol,
        { code: markup?.script[index], depth: depth?.[index], attr: attr?.[index] },
        flavor,
      );
    if (isJsx) return referencesJsx(line, symbol, jsx?.[index]);
    return referencesWord(line, symbol);
  };
  const program = markup?.code ?? code;
  return {
    // Imports are blanked last, off the program text every state above was tracked through: an
    // `import` is what opens MDX's ESM block and what a wrapped specifier list continues, so
    // masking it before those are read would close the block over the lines under it.
    code: maskImports(program, file, references),
    program,
    references,
  };
}

/**
 * The file's masked text, read once and reused: the same cache `codeReferencingFiles` fills, so a
 * file already judged for one symbol is never read again for another. Undefined for a file anton
 * cannot read, which proves nothing either way.
 */
async function maskedFile(
  repoPath: string,
  file: string,
  masked: Map<string, MaskedFile | undefined>,
  abort?: AbortSignal,
): Promise<MaskedFile | undefined> {
  if (!masked.has(file)) {
    try {
      masked.set(file, await maskFile(repoPath, file, abort));
    } catch {
      // A cancelled read is not an unreadable file. Swallowing it would turn the abort into
      // "proves no caller" and let the pass finish on a verdict nobody asked for.
      abort?.throwIfAborted();
      masked.set(file, undefined);
    }
  }
  return masked.get(file);
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
    const entry = await maskedFile(repoPath, file, masked, abort);
    if (!entry) continue;
    if (lines.some((line) => entry.references(entry.code[line - 1], symbol, line - 1)))
      files.push(file);
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
 * Every hit for a word across the TRACKED tree — the one the scan's commit names, whether the word
 * is the symbol itself or the module a caller might import it from. Untracked files are
 * deliberately left out: the nightly refresh tolerates the
 * scratch and generated debris a checkout accumulates (git/refresh.ts), so counting it would let a
 * file that never shipped erase a signal recorded against a SHA whose tree holds no such caller,
 * and score the same commit differently on two machines. `-F`/`-w` so a symbol carrying regex
 * punctuation (`$mount`) matches itself rather than a pattern, `-z` so a non-ASCII path comes back
 * unquoted under `core.quotePath`, `-I` so a binary blob is never read as a call site, `-n` so a
 * hit can be located in its file and judged against the comments around it, and the scan's own
 * exclusions so generated and vendored trees answer for nothing. Whether a hit is a reference is
 * the caller's question — this one only reports where the word is written.
 *
 * The caller's signal goes to the child so a cancelled job kills the grep it is waiting on instead
 * of paying out its 30s timeout.
 */
async function grepWord(
  repoPath: string,
  word: string,
  pathspecs: string[],
  abort?: AbortSignal,
): Promise<CandidateHits | { unavailable: string }> {
  try {
    const args = ["-C", repoPath, "grep", "-n", "-I", "-w", "-F", "-z", "-e", word];
    if (pathspecs.length > 0) args.push("--", ...pathspecs);
    const { stdout } = await execFileAsync("git", args, {
      timeout: GREP_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      signal: abort,
    });
    return candidateHits(stdout);
  } catch (err) {
    // A cancelled job is not an unsearchable tree. Reporting the kill as `unavailable` would let the
    // scan finish and record the pass, holding up shutdown and the `--delta` baseline unwind — so
    // the abort is rethrown, ahead of the exit-code test because a killed grep can surface as either.
    abort?.throwIfAborted();
    // Exit 1 is `git grep`'s "no match" — the answer, not a failure. Anything else is git unable to
    // answer at all, which must not read as "nothing references it".
    const e = err as { code?: number | string } | null;
    if (e?.code === 1) return new Map();
    return { unavailable: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Every file that references the symbol, by either spelling it or binding the module's default
 * export to a name of its own. `declaring` is the file set this scan says declares the symbol, so
 * the second search knows which modules to follow and which hits are the declaration itself.
 */
async function filesMentioning(
  repoPath: string,
  symbol: string,
  declaring: ReadonlySet<string>,
  masked: Map<string, MaskedFile | undefined>,
  pathspecs: string[],
  aliases: AliasCache,
  abort?: AbortSignal,
): Promise<string[] | { unavailable: string }> {
  const hits = await grepWord(repoPath, symbol, pathspecs, abort);
  if (!(hits instanceof Map)) return hits;
  const files = await codeReferencingFiles(repoPath, symbol, hits, masked, abort);
  if (files.some((file) => !declaring.has(file))) return files;
  // Only when the symbol's own name turned up no caller: the second search costs a grep per
  // declaring module, and a symbol already proved live has nothing to gain from it.
  const renamed = await defaultBindingCallers(
    repoPath,
    symbol,
    declaring,
    masked,
    pathspecs,
    aliases,
    abort,
  );
  return [...files, ...renamed.filter((file) => !files.includes(file))];
}

/**
 * Extensions a module specifier may leave off, longest first so `./widget` resolving to
 * `widget.d.ts` is not read as a module named `widget.d`.
 */
const MODULE_EXTENSIONS = [
  ".d.ts",
  ".tsx",
  ".ts",
  ".mts",
  ".cts",
  ".jsx",
  ".js",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
  ".astro",
];

/** A path with the module extension a specifier omits stripped off. */
function withoutModuleExtension(path: string): string {
  const found = MODULE_EXTENSIONS.find((ext) => path.toLowerCase().endsWith(ext));
  return found ? path.slice(0, -found.length) : path;
}

/** The prefixes a repo roots its own modules under — `@/lib/x`, `~/lib/x`, `#lib/x`. */
const MODULE_ALIAS = /^(?:[@~#]\/|#)/;

/** Path separators as either platform writes them, so a resolved path compares as git spells it. */
function posix(path: string): string {
  return path.split(/[\\/]/).join("/");
}

/** The `paths` mappings this pass has already read, by the directory each governs. */
type AliasCache = Map<string, readonly AliasRule[]>;

/** No rule claims anything — shared so an unmapped directory costs no allocation. */
const NO_ALIASES: readonly AliasRule[] = [];

/**
 * The `paths` mapping that governs `file`: the nearest tsconfig at or above it that publishes one,
 * rather than the repo root's. A monorepo declares `@/*` in the app that uses it, so resolving
 * every importer against the root config finds no rule there, falls back to matching the
 * specifier's tail, and reads `@/ui/widget` as the same-named module of an unrelated package —
 * inventing a caller and deleting a true finding.
 *
 * The walk stops at the nearest config whether or not it publishes a mapping, because that config
 * is the project boundary: tsc inherits `paths` through `extends` alone and never from an ancestor
 * DIRECTORY, so an app declaring none resolves `@/widget` as a package rather than through the
 * root's `@/* -> src/*` (anton-23xe). Climbing past it would name the root's `src/widget` and
 * invent a caller for it.
 *
 * Every directory walked is cached, negative answers included, so a package's config is read once
 * however many of its files import.
 */
async function aliasesGoverning(
  repoPath: string,
  file: string,
  cache: AliasCache,
): Promise<readonly AliasRule[]> {
  const walked: string[] = [];
  let rules: readonly AliasRule[] = NO_ALIASES;
  for (let dir = posix(dirname(file)); ; dir = posix(dirname(dir))) {
    const cached = cache.get(dir);
    if (cached) {
      rules = cached;
      break;
    }
    walked.push(dir);
    const found = await readDirAliases(repoPath, dir);
    if (found.governed) {
      rules = found.rules;
      break;
    }
    // The repo root answers last: above it there is no config of this project's to read.
    if (dir === "." || dir === "/" || dir === "..") break;
  }
  for (const dir of walked) cache.set(dir, rules);
  return rules;
}

/**
 * Where the `paths` mapping governing the importer sends `spec` — the targets of the MOST SPECIFIC
 * rule claiming its prefix, and nothing when no rule claims it.
 *
 * Overlapping patterns are how a monorepo carves an exception out of a broad alias — `"@/*":
 * ["apps/web/src/*"]` beside `"@/special/*": ["packages/special/*"]` — and tsc resolves such an
 * import through the longest matching prefix alone (anton-23xe). Expanding every rule that matches
 * lets `@/special/widget` name `apps/web/src/special/widget` as well, so a caller of the real
 * module is read as a caller of the broad one too, inventing a caller and deleting a true finding.
 *
 * Rules tie only when the same pattern is declared twice, and then they are equally specific, so
 * both answer — as they already would have. A pattern with no `*` claims its whole specifier, so
 * it is the most specific rule any import can match.
 *
 * The selection itself lives in `claimingRules`, shared with the coupling graph's `resolveAlias`:
 * two resolvers reading the same rules must not disagree about which one tsc would apply (PR #190
 * review).
 */
function aliasedModules(
  aliases: readonly AliasRule[],
  spec: string,
): { mapped: string[]; claimed: boolean } {
  const claiming = claimingRules(aliases, spec);
  const mapped: string[] = [];
  for (const { rule, rest } of claiming) {
    // More than one target is an ORDERED fallback list, and tsc resolves the first of them that
    // exists on disk. This pass reads no disk, so it cannot say which — and answering with all of
    // them credits a caller of `first/widget` to `fallback/widget` too, inventing a caller and
    // deleting a true finding (anton-23xe). Claiming without mapping leaves the signal standing,
    // which is the side this filter errs on. Resolving them in order is anton-5tjw.
    //
    // An `unresolved` rule declares a target anton could not model at all, so what it did map is a
    // PARTIAL list read the same way: the target tsc would pick may be one that isn't here
    // (PR #190 review).
    if (rule.unresolved || rule.targets.length > 1)
      return { mapped: [], claimed: claiming.length > 0 };
    for (const target of rule.targets) mapped.push(posix(normalize(aliasTarget(target, rest))));
  }
  return { mapped, claimed: claiming.length > 0 };
}

/**
 * Whether `spec`, written in `importer`, could name `module` — both repo-relative paths.
 *
 * A relative specifier is resolved exactly, against the importing file's own directory, so it names
 * one module and no other. An ALIASED one is resolved through `aliases` — the mapping governing the
 * importing file, which `aliasesGoverning` reads from the config nearest it — and a rule that
 * claims the prefix answers alone: `@/ui/widget` under `"@/*": ["apps/web/*"]` is
 * `apps/web/ui/widget` and no other module. Falling back to the tail behind a mapping that already
 * answered is how the same specifier gets read as the same-named module in an unrelated package of
 * a monorepo — inventing a caller and deleting a true finding.
 *
 * Only where no rule claims the prefix is the tail matched instead — a repo whose aliases anton
 * cannot read still imports `@/ui/widget` from the module whose path ends in `ui/widget`. The tail
 * must carry a directory for that: a bare `widget` would match half a tree.
 *
 * Nothing else is matched at all. A bare `ui/widget` is as readily a package subpath, and a local
 * `src/ui/widget.ts` beside it would then read as the module that import named — inventing a caller
 * and deleting a true finding, which is the one direction this filter never errs in. Refusing the
 * bare form under-covers a repo that roots its own modules through `baseUrl` rather than an alias,
 * and that only leaves a signal standing.
 */
function specifierNames(
  importer: string,
  spec: string,
  module: string,
  aliases: readonly AliasRule[],
  shadowed: ReadonlySet<string> = new Set(),
): boolean {
  const target = withoutModuleExtension(posix(module));
  // `./widget` names `src/widget.ts` where that file exists, and `src/widget/index.ts` only where
  // it does not — resolution tries the file first. Accepting the index unconditionally credits an
  // import of the FILE to the index's own default export, which deletes the index module's true
  // finding (PR #190 review). `shadowed` holds the directories a file module outranks.
  const names = (resolved: string): boolean =>
    resolved === target || (!shadowed.has(resolved) && `${resolved}/index` === target);
  // `.` and `..` are relative specifiers in their own right — the directory's own index, and its
  // parent's — and testing only for the `./` and `../` spellings sent them to the alias branch,
  // where no rule claims them and the tail cannot read one, so a neighbour importing an index as
  // `"."` named nothing and its live default stayed reported dead (PR #190 review).
  if (RELATIVE_SPECIFIER.test(spec))
    return names(withoutModuleExtension(posix(normalize(join(dirname(importer), spec)))));
  const path = posix(spec);
  const { mapped, claimed } = aliasedModules(aliases, path);
  if (mapped.length > 0) return mapped.some((to) => names(withoutModuleExtension(to)));
  // A rule claimed the prefix but could not be resolved. The tail must not answer in its place:
  // that is the match which reads `@/ui/widget` as an unrelated package's same-named module.
  if (claimed) return false;
  if (!MODULE_ALIAS.test(path)) return false;
  const tail = withoutModuleExtension(path.replace(MODULE_ALIAS, ""));
  if (!tail.includes("/")) return false;
  return (
    target === tail ||
    target === `${tail}/index` ||
    target.endsWith(`/${tail}`) ||
    target.endsWith(`/${tail}/index`)
  );
}

/** A specifier resolved against the importing file's own directory: `.`, `..`, `./x`, `../x`. */
const RELATIVE_SPECIFIER = /^\.\.?(?:\/|$)/;

/**
 * Every tracked file the scan's exclusions leave standing, or undefined when git could not say.
 *
 * Read for two questions a grep cannot answer, both about a directory `index`: which files sit
 * beside it (they can import it as `"."`, a specifier carrying no word to search for), and whether
 * a file module of the directory's own name outranks it in resolution.
 *
 * The exclusions are passed WITHOUT a positive pathspec and the narrowing is done here, because
 * `git ls-files` answers with nothing at all when the two are combined (verified on git 2.50.1),
 * unlike `git grep`. Applying them matters: they are caller-supplied and need not be whole
 * directory trees, so an `exclude: ['src/widget/fixture.ts']` the grep honours must be honoured
 * here too, or a fixture stringer never scanned removes a real finding (PR #190 review).
 *
 * One listing serves every declaring module in the call, and is read only when one of them is an
 * index. A listing git cannot produce is no candidates, exactly as a failed grep is.
 */
async function trackedFiles(
  repoPath: string,
  pathspecs: string[],
  abort?: AbortSignal,
): Promise<string[] | undefined> {
  try {
    const args = ["-C", repoPath, "ls-files", "-z", "--", ...pathspecs.slice(1)];
    const { stdout } = await execFileAsync("git", args, {
      timeout: GREP_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      signal: abort,
    });
    return stdout.split("\0").filter(Boolean);
  } catch {
    abort?.throwIfAborted();
    return undefined;
  }
}

/** Whether `module` is a directory's `index`, the shape both index questions are about. */
function isDirectoryIndex(module: string): boolean {
  return withoutModuleExtension(posix(module)).split("/").pop() === "index";
}

/**
 * The words an EXACT alias lets a specifier name `module` by, which its file name is not among.
 *
 * A wildcard mapping carries the module's own path through the specifier — `@/ui/widget` under
 * `"@/*"` still writes `widget` — so `moduleWord` finds those importers. A pattern with no `*`
 * renames the module outright: `"@/widget": ["src/components/special.ts"]` is imported as
 * `@/widget`, which contains no `special`, so the grep that looks for the file name never reaches
 * the importer and a caller binding the default under another name goes unfound — leaving a live
 * symbol reported dead (PR #190 review).
 *
 * Read from the mapping governing the DECLARING module, which is where a project that aliases its
 * own file writes the rule. An exact alias declared only in some OTHER project and reaching across
 * a package boundary is still missed; that under-covers, which leaves the signal standing, and is
 * the direction this filter errs in.
 *
 * The word is the specifier's last segment, because that is what a word-boundary grep can match
 * inside `from "@/widget"`.
 */
function exactAliasWords(module: string, aliases: readonly AliasRule[]): string[] {
  const target = withoutModuleExtension(posix(module));
  const words: string[] = [];
  for (const rule of aliases) {
    if (!rule.exact) continue;
    const names = rule.targets.some((to) => {
      const resolved = withoutModuleExtension(posix(to));
      return resolved === target || `${resolved}/index` === target;
    });
    if (!names) continue;
    const word = rule.prefix.split("/").pop();
    if (word) words.push(word);
  }
  return words;
}

/**
 * The word every specifier naming `module` through a WILDCARD mapping must contain: the module's
 * own file name, or its directory's when the file is the directory's `index`. Grepping for it is
 * how the importers of a module are found without walking the tree. An exact alias can rename the
 * module past this word, which `exactAliasWords` answers for.
 */
function moduleWord(module: string): string | undefined {
  const segments = withoutModuleExtension(posix(module)).split("/");
  const name = segments.pop();
  return name === "index" ? segments.pop() : name;
}

/**
 * `export default`, and the two `exports` spellings of it, up to the name being exported. The head
 * has to stand at the start of a statement: `export default` inside a string or after other code is
 * not this module's default, and `module.exports` reached through a property is not either.
 *
 * Every keyword a declaration can stand between `default` and its name is consumed, `interface` and
 * `abstract class` among them (anton-23xe). One left out doesn't merely miss a shape: the keyword is
 * read as the exported name, the module is taken to declare no default at all, and the caller that
 * imported it under another name — `import type Renamed from './widget'`, which writes the symbol
 * nowhere for a per-word match to find — goes unfound, leaving a live symbol reported dead.
 */
const DEFAULT_EXPORT_HEAD =
  /(?:^|[;{}])[ \t]*(?:export\s+default\s+(?:async\s+)?(?:function[\s*]+|(?:abstract\s+)?class\s+|interface\s+)?|(?:module\.exports|exports\.default)[ \t]*=\s*(?:async\s+)?(?:function[\s*]+|(?:abstract\s+)?class\s+)?)/gm;

/**
 * `export { Widget as default }` — the same claim written as a re-export, and the list is read
 * across lines because a formatter wraps one: `export {` with `Widget as default` under it declares
 * the module's default as plainly as the single line does, and a caller importing it under another
 * name writes the symbol nowhere for a per-line match to find. The body admits only what an export
 * list is spelled with, so a lone `export {` cannot reach across a whole file for an `as default`
 * belonging to something else and invent a default export the module never had.
 */
const DEFAULT_REEXPORT = /\bexport\s*\{[\w$,\s]*?\b([A-Za-z_$][\w$]*)\s+as\s+default\b/g;

/** How a module hands its default value out, which decides what a caller may bind it with. */
interface DefaultExport {
  /**
   * `export default Widget`, and the `exports.default = Widget` an ESM default compiles to — both
   * reached by an ESM default import and by nothing else.
   */
  esm: boolean;
  /** `module.exports = Widget` — reached by a whole-module `require` as well. */
  cjs: boolean;
}

/** How `program` exports `symbol` as its default value, or undefined when it doesn't. */
function defaultExportOf(program: readonly string[], symbol: string): DefaultExport | undefined {
  const result: DefaultExport = { esm: false, cjs: false };
  // Read as one text rather than line by line, for the reason `defaultBindingsOf` reads its own that
  // way: an export list is what wraps, and a pattern that never sees `export {` beside the name
  // under it misses the module's default and reports a live symbol dead. The statement heads stay
  // anchored to their own line — `[ \t]` never crosses a newline, and the multiline flag keeps `^`
  // meaning the start of a line rather than the start of the file.
  const text = program.join("\n");
  DEFAULT_EXPORT_HEAD.lastIndex = 0;
  for (let head = DEFAULT_EXPORT_HEAD.exec(text); head; head = DEFAULT_EXPORT_HEAD.exec(text)) {
    const at = head.index + head[0].length;
    if (!text.startsWith(symbol, at)) continue;
    if (WORD_CHAR.test(text[at + symbol.length] ?? "")) continue;
    // Only an outright `module.exports = Widget` puts the symbol where a whole-module `require`
    // lands. `exports.default = Widget` leaves it on a property, so a `require` binding names the
    // module object and not the function — treating it as CJS would invent a caller.
    if (head[0].includes("module.exports")) result.cjs = true;
    else result.esm = true;
  }
  DEFAULT_REEXPORT.lastIndex = 0;
  for (let list = DEFAULT_REEXPORT.exec(text); list; list = DEFAULT_REEXPORT.exec(text))
    if (list[1] === symbol) result.esm = true;
  return result.esm || result.cjs ? result : undefined;
}

/**
 * `import Renamed from './widget'`, and `import Renamed, { other } from './widget'` — the shapes
 * that bind a module's default export to a name the importing file chooses. A brace or a `*` where
 * the name would stand is a named or namespace import, which binds no default and is left out.
 *
 * Whitespace spans newlines because a formatter wraps a long specifier list, and the local name and
 * the module it came from land on different lines. The run of any-but-quote after the comma cannot
 * cross a string literal, so it stops inside the statement it started in.
 */
const DEFAULT_IMPORT =
  /(?:^|[;{}])\s*import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,[^'"]*)?\bfrom\s*['"]([^'"]+)['"]/gm;

/**
 * `import { default as Renamed } from './widget'` — the list spelling of a default import, and the
 * exact mirror of the `export { Widget as default }` this module already reads on the export side
 * (anton-23xe). It binds the default as plainly as the bare form, and the caller writes the
 * original symbol nowhere, so leaving it out reports a live symbol dead.
 *
 * The list body admits only what an import list is spelled with, so it cannot reach past the
 * statement's own `}` for a `default as` belonging to another one.
 */
const DEFAULT_LIST_IMPORT =
  /(?:^|[;{}])\s*import\s+(?:type\s+)?\{[\w$,\s]*?\bdefault\s+as\s+([A-Za-z_$][\w$]*)[\w$,\s]*\}\s*from\s*['"]([^'"]+)['"]/gm;

/** `const Renamed = require('./widget')` — CommonJS binding the whole module, default and all. */
const DEFAULT_REQUIRE =
  /(?:^|[;{}])\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]/gm;

/**
 * `const Renamed = require('./widget').default` — how CommonJS reaches an ESM default, and the only
 * shape that selects it off the module object (anton-23xe). The caller writes the original symbol
 * nowhere, so leaving it out reports a live symbol dead.
 *
 * It answers for an ESM default alone: where a module assigned `module.exports` outright there is
 * no `.default` on it to select, and counting one would invent a caller.
 */
const DEFAULT_REQUIRE_INTEROP =
  /(?:^|[;{}])\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.default\b/gm;

/**
 * `const { default: Renamed } = require('./widget')` — the destructured spelling of the interop
 * read above, and the exact mirror of `DEFAULT_LIST_IMPORT` on the CommonJS side (PR #190 review).
 * It selects the same `.default` off the same module object, and the caller writes the original
 * symbol nowhere, so leaving it out reports a live symbol dead.
 *
 * Only the renaming form exists to match: `const { default } = …` binds a reserved word and is a
 * syntax error, so every valid destructured default carries a local name.
 *
 * The list body admits only what a destructuring pattern is spelled with, so it cannot reach past
 * the statement's own `}` for a `default:` belonging to another one.
 */
const DEFAULT_REQUIRE_DESTRUCTURED =
  /(?:^|[;{}])\s*(?:const|let|var)\s*\{[\w$,:\s]*?\bdefault\s*:\s*([A-Za-z_$][\w$]*)[\w$,:\s]*\}\s*=\s*require\s*\(\s*['"]([^'"]+)['"]/gm;

/**
 * `import * as ns from './widget'` — a namespace import binds no default under its own name, which
 * is why `DEFAULT_IMPORT` leaves it out, but `ns.default()` reaches one (anton-23xe). The binding
 * recorded for it is `ns.default` rather than `ns`, because `ns` alone is also how every NAMED
 * export is reached: crediting a file for writing `ns.somethingElse()` would invent a caller.
 */
const DEFAULT_NAMESPACE_IMPORT =
  /(?:^|[;{}])\s*import\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][\w$]*)\s*\bfrom\s*['"]([^'"]+)['"]/gm;

/** The local names `program` binds the default export of one of `modules` to. */
function defaultBindingsOf(
  program: readonly string[],
  file: string,
  modules: ReadonlyMap<string, DefaultExport>,
  aliases: readonly AliasRule[],
  shadowed: ReadonlySet<string>,
): string[] {
  // Read as one text rather than line by line: an import statement is what wraps, and a pattern
  // that never sees the local name beside its specifier misses the binding and reports a live
  // symbol dead.
  const text = program.join("\n");
  const locals: string[] = [];
  const collect = (
    pattern: RegExp,
    reachable: (how: DefaultExport) => boolean,
    bind: (local: string) => string = (local) => local,
  ): void => {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const [, local, spec] = match;
      if (local === undefined || spec === undefined) continue;
      for (const [declared, how] of modules)
        if (reachable(how) && specifierNames(file, spec, declared, aliases, shadowed))
          locals.push(bind(local));
    }
  };
  collect(DEFAULT_IMPORT, () => true);
  collect(DEFAULT_LIST_IMPORT, () => true);
  // A `require` hands back the module object, which is the default value only where the module
  // assigned `module.exports` outright. Requiring an ESM module yields a namespace whose `.default`
  // holds the symbol, and the property beside it is a mention grep already reads.
  collect(DEFAULT_REQUIRE, (how) => how.cjs);
  collect(DEFAULT_REQUIRE_INTEROP, (how) => how.esm);
  collect(DEFAULT_REQUIRE_DESTRUCTURED, (how) => how.esm);
  collect(DEFAULT_NAMESPACE_IMPORT, (how) => how.esm, (ns) => `${ns}.default`);
  return locals;
}

/**
 * How many files one symbol's default-binding search will read. The word it greps for is a module's
 * file name, and a framework that names every route module the same thing (`page.tsx`) makes that
 * word half the tree. Stopping there under-covers — the signal stands, which is the direction this
 * filter errs in — rather than letting one symbol spend a nightly reading a repo twice.
 */
const DEFAULT_BINDING_FILE_BUDGET = 200;

/**
 * The files that call the symbol through a default import bound to another name.
 * `export default function Widget()` consumed as `import Renamed from './widget'; Renamed()` writes
 * `Widget` nowhere outside its own module, so the symbol's own grep finds no caller and a live
 * function is reported dead. The explicit `Widget as Renamed` recovery cannot help — there is no
 * original-name hit to read the rename off — so the binding is resolved from the declaring module
 * instead: which modules export the symbol as their default, who imports those modules, and whether
 * that importer uses the name it bound them to.
 *
 * Nothing here can invent a caller out of prose: the local name is judged by the importing file's
 * own grammar, exactly as a hit for the symbol would be.
 *
 * A grep that fails leaves the signal standing rather than failing the pass — the symbol's own
 * search already answered, so this one adds evidence or adds nothing.
 */
async function defaultBindingCallers(
  repoPath: string,
  symbol: string,
  declaring: ReadonlySet<string>,
  masked: Map<string, MaskedFile | undefined>,
  pathspecs: string[],
  aliases: AliasCache,
  abort?: AbortSignal,
): Promise<string[]> {
  const modules = new Map<string, DefaultExport>();
  for (const file of declaring) {
    abort?.throwIfAborted();
    const entry = await maskedFile(repoPath, file, masked, abort);
    const how = entry && defaultExportOf(entry.program, symbol);
    if (how) modules.set(file, how);
  }
  if (modules.size === 0) return [];

  const words = new Set<string>();
  for (const declared of modules.keys()) {
    const word = moduleWord(declared);
    if (word) words.add(word);
    const governing = await aliasesGoverning(repoPath, declared, aliases);
    for (const alias of exactAliasWords(declared, governing)) words.add(alias);
  }
  // Two listings, because the index questions are not the same kind of question (PR #190 review).
  // Which files may be CALLERS is the scan's business, so the exclusions apply. Which module a
  // specifier RESOLVES to is a fact about the disk that the scan's reading list cannot change: an
  // excluded `src/widget.ts` still outranks `src/widget/index.ts` for every importer of
  // `./widget`, and reading precedence off the filtered tree would credit those importers to the
  // index and drop its true finding. Both are read only when a declaring module is an index.
  const indexes = [...modules.keys()].filter(isDirectoryIndex);
  const candidates = indexes.length > 0 ? await trackedFiles(repoPath, pathspecs, abort) : undefined;
  const resolvable = indexes.length > 0 ? await trackedFiles(repoPath, [], abort) : undefined;
  const shadowed = new Set<string>();
  if (resolvable) {
    const stems = new Set(resolvable.map((file) => withoutModuleExtension(posix(file))));
    for (const index of indexes) {
      const dir = posix(dirname(index));
      if (stems.has(dir)) shadowed.add(dir);
    }
  }

  const callers = new Set<string>();
  let read = 0;
  let spent = false;
  /** Whether one candidate file binds a declaring module's default to a name it then uses. */
  const judge = async (file: string): Promise<void> => {
    // Prose and data are read as text wherever else a hit is weighed (`codeReferencingFiles`), and
    // must be here too: a README beside an index showing `import Renamed from '.'` in an example is
    // documentation, and parsing it as a default import invents a caller and deletes a true finding
    // (PR #190 review). It guards the grep hits as much as the listed neighbours — this search
    // greps by module name and never passed its hits through that filter either.
    if (PROSE_FILE.test(file) || DATA_FILE.test(file)) return;
    if (declaring.has(file) || callers.has(file)) return;
    if ((read += 1) > DEFAULT_BINDING_FILE_BUDGET) {
      spent = true;
      return;
    }
    abort?.throwIfAborted();
    const entry = await maskedFile(repoPath, file, masked, abort);
    if (!entry) return;
    const locals = defaultBindingsOf(
      entry.program,
      file,
      modules,
      await aliasesGoverning(repoPath, file, aliases),
      shadowed,
    );
    const used = locals.some((local) =>
      entry.code.some((line, index) => entry.references(line, local, index)),
    );
    if (used) callers.add(file);
  };

  for (const word of words) {
    abort?.throwIfAborted();
    const hits = await grepWord(repoPath, word, pathspecs, abort);
    // Deliberately not propagated as `unavailable`: the symbol's own grep already answered, and this
    // search only ever adds callers. A failure here is "no further evidence", which keeps the signal
    // standing — the conservative direction — rather than voiding a pass that did search the tree.
    if (!(hits instanceof Map)) continue;
    for (const file of hits.keys()) {
      await judge(file);
      if (spent) return [...callers];
    }
  }
  // A directory `index` can be imported as `"."`, which carries no word any grep could have found,
  // so its neighbours are read off the listing rather than searched for (PR #190 review).
  for (const index of indexes) {
    const dir = posix(dirname(index));
    for (const file of candidates ?? []) {
      if (posix(dirname(file)) !== dir) continue;
      await judge(file);
      if (spent) return [...callers];
    }
  }
  return [...callers];
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
 * A symbol nothing spells is checked once more before it stands: a default export consumed as
 * `import Renamed from './widget'` is written under the caller's own name and never under its own,
 * so `defaultBindingCallers` resolves the binding from the declaring module rather than reporting a
 * live function dead.
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
  // The `paths` mappings the pass reads, one per directory that publishes one: they are what say
  // which module an aliased specifier names, and a monorepo holds more than one module per path
  // tail — and more than one config declaring the prefix that tells them apart.
  const aliases: AliasCache = new Map();
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
      const found = await filesMentioning(
        repoPath,
        symbol,
        declarers.get(symbol) ?? new Set([path]),
        masked,
        pathspecs,
        aliases,
        abort,
      );
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
