/**
 * A repeated comment is not duplicated code (anton-vb2h). stringer's `duplication` collector matches
 * on token windows, so anton's house doc-comment style, its import specifier lists, and its
 * TypeScript interface field lists all read as clones. The 2026-08-19 scan spent 97 of its 121
 * signals on `duplication` and 42 of those pointed at a window holding no statement at all — a JSDoc
 * paragraph (approval-gate.ts:17, 29 locations), an interface field list (shape-draft.ts:16, 44
 * locations), an import specifier list (bd-bin.test.ts:10). Triage paid a full pass to throw them
 * away and filed one bead from the lot.
 *
 * DEFAULT_SCAN_EXCLUDES cannot express this: the problem is not WHICH file a signal names, it is
 * WHICH LINES. So the reported window is resolved against the tree and READ — the verdict comes from
 * the source, never from the signal's title or kind, which say "code-clone" for prose just as
 * readily as for code.
 *
 * Conservative by construction, like the type-only coupling filter it sits beside: a signal is
 * dropped only when the locations that DECLARE outnumber the ones that compute, and a tie keeps it.
 * A block size it cannot parse, a file it could not read, a window whose statements carry the
 * block — each leaves the signal exactly as stringer wrote it. Under-filtering costs one triaged
 * bead; over-filtering deletes a real clone nobody hears about.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { collectorOf, type ScanSignal } from "./scan-severity";

/** The collector these rules are about; every other signal rides through untouched. */
const DUPLICATION_COLLECTOR = "duplication";

/**
 * How many files one filter pass will read. A scan can carry a hundred duplication signals across
 * as many files; the budget bounds what a nightly pass spends on them. Hitting it means "not
 * proven", so the signals still standing keep their place rather than being dropped unread.
 */
const FILE_BUDGET = 500;

/**
 * Languages where `#` starts a comment. In TS/JS a leading `#` is a private class field — code. A
 * stub (`.pyi`) is Python with its bodies removed: `#` cuts a line there exactly as it does in the
 * module it describes, and omitting the extension files a window of repeated stub comments as
 * executable code and sends it to triage.
 */
const HASH_COMMENT_EXTENSIONS = [
  ".py",
  ".pyi",
  ".sh",
  ".bash",
  ".zsh",
  ".rb",
  ".yaml",
  ".yml",
  ".toml",
];

/**
 * The subset where a `#` opens a comment only AFTER whitespace. Shell reads `${#items[@]}` and `$#`
 * as expansions, and YAML reads the `#` in `key: a#b` as part of the scalar, so cutting at a bare
 * marker there would drop real syntax. Python, Ruby and TOML have no such rule — `)#{ note` is
 * comment from the `#` on — and demanding a gap leaves that `{` to be counted as a delimiter.
 */
const SPACED_HASH_EXTENSIONS = [".sh", ".bash", ".zsh", ".yaml", ".yml"];

/**
 * Where `//` opens a comment. An ALLOW-list, not "every language that lacks `#` comments": Lua
 * spells floor division `//` exactly as Python does, so a wrapped expression there leads its
 * continuation lines with an operator, and reading those as prose drops a genuine clone of
 * arithmetic. A language anton has no rule for keeps its signals rather than losing them to C's
 * grammar.
 */
const SLASH_COMMENT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".swift",
  ".dart",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
];

/**
 * Where a block comment NESTS — Rust, Swift, Scala, Kotlin and Dart close an outer `/*` only on the
 * closer that MATCHES it. Everywhere else the first closer ends the comment however many openers
 * preceded it, and counting depth there would run the comment past its close over the rest of the
 * file.
 */
const NESTED_COMMENT_EXTENSIONS = [".rs", ".swift", ".scala", ".kt", ".kts", ".dart"];

/**
 * Where `"""` and `'''` BOTH open a string that spans lines — Python's docstrings, Dart's multiline
 * literals. A file named by neither this list nor the one below has no such form at all: in a shell
 * or YAML file the same three characters are an empty string beside a quote, and reading them as an
 * opener would swallow the rest of the file.
 */
const TRIPLE_QUOTE_EXTENSIONS = [".py", ".pyi", ".dart"];

/**
 * Where only `"""` opens one — Kotlin's raw strings, Java's text blocks, Scala and Swift. A `'''`
 * there is a quote beside a char literal rather than an opener. Each of these parses imports, so an
 * embedded fixture quoting `import (` inside a multiline string would otherwise open import state
 * that no real `)` closes, and every executable window past the closing delimiter is dropped.
 */
const DOUBLE_TRIPLE_QUOTE_EXTENSIONS = [".kt", ".kts", ".java", ".scala", ".swift"];

/** Where `<<WORD` opens a heredoc whose payload is input rather than syntax — the shells. */
const HEREDOC_EXTENSIONS = [".sh", ".bash", ".zsh"];

/**
 * Where a quoted import path with no alias BINDS a name — Go, where `import "fmt"` binds `fmt`.
 * Only the blank spelling `import _ "…"` runs purely for its side effect there. Everywhere else the
 * bare form binds nothing and IS the side-effect import, so reading Go's by the same rule would keep
 * a duplicated window of ordinary bound imports as executable setup.
 */
const BOUND_BARE_IMPORT_EXTENSIONS = [".go"];

/**
 * Where a string spans lines behind delimiters NO escape can end — Rust's `r"…"` and `r#"…"#`. The
 * same characters elsewhere are an identifier beside a quote, so reading them as an opener would
 * swallow the rest of the file.
 */
const RAW_STRING_EXTENSIONS = [".rs"];

/**
 * Where `type X`, `interface X` and the erased `enum` forms DECLARE a type. `type` is an executable
 * builtin in shell — `type git` asks whether a command exists — so reading it as a declaration there
 * files a duplicated block of availability checks as a field list and drops it. An ALLOW-list for
 * that reason: a language anton has no rule for keeps its signals rather than losing them to
 * TypeScript's grammar.
 */
const TYPE_DECLARATION_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".go", ".rs"];

/**
 * Where a leading `import` DECLARES a dependency rather than naming a command. In shell it is an
 * ordinary executable — ImageMagick's `import -window root shot.png` grabs a screenshot — so a
 * duplicated block of those would be filed as a specifier list and dropped. An ALLOW-list for the
 * same reason as the type one above: a language anton has no rule for keeps its signals rather than
 * losing them to TypeScript's grammar.
 */
const IMPORT_DECLARATION_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyi",
  ".go",
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".swift",
  ".dart",
];

/**
 * Where `const x;` / `let x;` / `var x;` DECLARE a binding and run nothing. `let` is an ordinary
 * command in shell — `let first;` evaluates arithmetic and sets the exit status, which `set -e` then
 * acts on — so reading it as a declaration there files a duplicated window of real arithmetic as an
 * erased binding list and drops it. An ALLOW-list for the same reason as the type and import ones
 * above: a language anton has no rule for keeps its signals rather than losing them to TypeScript's
 * grammar. Rust is on it because `let x: u32;` is its deferred-init binding, which declares exactly
 * as much.
 */
const BINDING_DECLARATION_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".rs",
];

/**
 * Where `function foo(` and `const f = (` are DECLARATION headers — the JS/TS family, whose tail
 * grammar (`) {`, `) =>`) these recognizers are written against. `function` is an ordinary
 * identifier elsewhere: a multiline Python call (`function(do_first(),`) opens a parameter list no
 * `)` ever closes for it, and every executable line through the real closer inherits `signature`
 * and is dropped. An ALLOW-list for the same reason as the type, import and binding ones above — a
 * language whose declarations are spelled differently keeps its signals rather than borrowing JS's
 * grammar. Rust is off it: `let total = (` opens a parenthesized expression there, never a closure.
 */
const FUNCTION_HEADER_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/**
 * Where a `<` can open a JSX tag, so a `/` written TIGHT against one is a tag's punctuation rather
 * than a comparison. `.ts` and its siblings cannot hold JSX — a `<` there is a comparison or a type
 * argument list — so `value</[/*]/.source` is the comparison it reads as, and refusing it leaves the
 * `/*` in that character class to open a comment over every line below. `.js` stays on the list:
 * React projects write JSX in it as readily as in `.jsx`.
 */
const JSX_EXTENSIONS = [".tsx", ".jsx", ".js", ".mjs", ".cjs"];

/** One duplication signal the filter removed, and the proof that removed it. */
export interface DroppedDuplication {
  /** The file stringer named, as it spelled it. */
  path: string;
  /** stringer's `Kind` — `code-clone` or `near-duplicate`. */
  kind: string;
  /** Why the block is not duplicated code, in the terms an operator would check it in. */
  reason: string;
}

/** What the non-code filter did to this scan — every drop is surfaced, never silent. */
export interface DuplicationFilter {
  dropped: DroppedDuplication[];
}

/**
 * What one source line contributes. `code` and `body` are the classes that do work; `blank` and
 * `structural` (a lone brace, a JSX closer) are neither — they say nothing about the block either
 * way. Everything between is declaration: prose, an import specifier, a type field, a parameter.
 *
 * `body` is the one line that carries a function's WHOLE executable body — the `) => execute(…)`
 * or `) { return x; }` that closes a multiline parameter list. It computes like `code` does, and it
 * additionally proves the window holds a complete function definition, which is what lets it
 * outweigh the parameter lines above it.
 */
type LineClass =
  | "blank"
  | "structural"
  | "comment"
  | "import"
  | "type"
  | "declaration"
  | "signature"
  | "code"
  | "body";

/** The classes that make a block a declaration rather than a computation. */
const DECLARATIVE: ReadonlySet<LineClass> = new Set<LineClass>([
  "comment",
  "import",
  "type",
  "declaration",
  "signature",
]);

/** A location stringer reported the block at. */
interface Location {
  /** Repo-relative path, as stringer spelled it. */
  path: string;
  /** 1-based first line of the block. */
  line: number;
}

/** Lines that carry only nesting — closing braces, a lone `{`, a JSX closer. No statement. */
const STRUCTURAL_LINE = /^(?:[[\](){}<>,;:]+|<\/[A-Za-z][\w.:-]*>[,;)]*|\/>[,;)]*)$/;

/**
 * `import …`, `export { … } from …`, `export * from …` — the statement's first line. A dynamic
 * `import("./plugin")` is excluded: it loads a module at runtime and drives whatever comes after it,
 * so it computes — and it is excluded on the paren ALONE, not on what follows, because the argument
 * may sit on the next line (`import(\n  "./plugin"\n).then(register)`). Reading that opener as an
 * import would hold the whole runtime expression below it in import state and drop the window.
 *
 * Go's grouped `import (` keeps its place: gofmt separates the keyword from the paren, and a paren
 * with nothing after it on the line opens a specifier list. The spaced call form (`import ("./x")`)
 * is excluded by its argument, as before.
 *
 * A block comment between the keyword and the paren is trivia the call still runs through —
 * `import /* webpackIgnore: true *\/ ("./plugin")` is how a bundler is told what to do with a
 * runtime load. It settles the paren on its own: a comment in that position is the loader-hint
 * idiom, never Go's specifier list, so the argument may wrap to the next line as it may after a
 * bare `import(`.
 */
const INLINE_BLOCK_COMMENT = String.raw`\/\*(?:[^*]|\*(?!\/))*\*\/`;
const IMPORT_START = new RegExp(
  String.raw`^import\b(?!\(|(?:\s*${INLINE_BLOCK_COMMENT})+\s*\(|\s*(?:\(\s*\S|\.))` +
    String.raw`|^export\s+(?:type\s+)?[{*]|^export\b[^;]*\bfrom\s*["']`,
);

/**
 * Python's other import spelling — `from package import name`, `from . import sibling`, and the
 * parenthesized `from package import (` list. It binds names exactly as `import os` does, so a
 * window of specifiers declares; without it the commonest Python import form reads as executable
 * code and its repeated specifier lists keep reaching triage.
 *
 * `from` is not a statement keyword in TS/JS, and the assignment forms that could start a line
 * there (`from = resolve(x)`) carry no bare `import` after a dotted name, so this stays Python's.
 */
const FROM_IMPORT_START = /^from\s+[.\w]+\s+import\b/;

/**
 * `interface X {`, `type X =`, and the ERASED enum forms — `declare enum`, `const enum`. A plain
 * `enum` emits runtime code and its members can compute (`Draft = label("draft")`), so it is read as
 * code rather than counted as a declaration.
 */
const TYPE_START =
  /^(?:export\s+)?(?:(?:declare\s+)?(?:interface|type)|declare\s+(?:const\s+)?enum|const\s+enum)\s+[A-Za-z_$]/;

/**
 * `import "./register-plugin";` — an import that binds NOTHING is there for what the module does on
 * load: registering a plugin, installing a polyfill. That runs, so the line computes rather than
 * declares, and a window of them is duplicated setup triage can act on.
 *
 * This is the spelling for languages where a bare quoted path binds NO name. Go is not one of them
 * — `import "fmt"` binds `fmt` — so it gets its own pattern below rather than sharing this one.
 *
 * An import-attributes clause — `import "./data.json" with { type: "json" }`, or the older
 * `assert` spelling — binds nothing either: it only tells the loader how to parse what it loads.
 * The module is still fetched and evaluated, so the line computes as the bare form does.
 *
 * The trailing comment is part of the idiom — `import "./register"; // install hooks` is how the
 * side effect gets named at all, and rejecting it would file the window with the specifier lists.
 * It is matched after the quoted specifier, so a `//` inside a URL import stays inside the string.
 */
const SIDE_EFFECT_IMPORT =
  /^import\s+(["'`])[^"'`]+\1(?:\s+(?:with|assert)\s*\{[^{}]*\})?\s*;?\s*(?:\/\/.*|\/\*.*)?$/;

/**
 * Go spells the same intent `import _ "net/http/pprof"`: the blank name exists precisely to run the
 * package's `init()` and bind nothing. The `_` is REQUIRED here — `import "fmt"` binds the package's
 * own name and is a declaration like the grouped bound list, and a named alias (`import fmt2 "fmt"`)
 * binds too. Go's raw-string spelling of the path (`` import _ `net/http/pprof` ``) is the same
 * statement, so the delimiter is matched as a pair rather than assumed to be a quote.
 */
const BLANK_IMPORT = /^import\s+_\s+(["'`])[^"'`]+\1\s*(?:\/\/.*|\/\*.*)?$/;

/**
 * The same statement with its attributes clause left OPEN — `import "./data.json" with {` over a
 * wrapped attribute list. The module is fetched and evaluated exactly as the single-line form is, so
 * the whole statement computes; matched only by `IMPORT_START`, its lines would file a duplicated
 * runtime load with the specifier lists and drop it.
 */
const SIDE_EFFECT_IMPORT_OPEN = /^import\s+(["'`])[^"'`]+\1\s+(?:with|assert)\s*\{[^{}]*$/;

/**
 * One blank specifier inside Go's grouped `import (` list — `_ "github.com/lib/pq"`, or the raw
 * string `` _ `github.com/lib/pq` ``. Same side effect as the single-line form, so it must not
 * inherit the enclosing list's `import` class: a window of driver registrations is executable
 * setup, not a specifier list.
 */
const BLANK_IMPORT_SPEC = /^_\s+(["'`])[^"'`]+\1\s*(?:\/\/.*|\/\*.*)?$/;

/** `function foo(` / `export async function foo(` — a declaration header, not a call. */
const FUNCTION_START = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/;

/**
 * `const Foo = ({` / `export const f = async (` — the other spelling of the same header. Only a
 * CANDIDATE: `const result = (` opens a parenthesized expression just as well, and the two are told
 * apart on the line that closes the paren, not here.
 */
const ARROW_START = /^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=]+)?=\s*(?:async\s*)?\(/;

/**
 * `let repo: string;` — a binding with no initializer runs nothing at all. Read only in the
 * languages `BINDING_DECLARATION_EXTENSIONS` names, since the same spelling is a command elsewhere.
 */
const BARE_DECLARATION = /^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=;]+)?;$/;

/**
 * The keywords a `/` can only BEGIN a regex after. Each one expects an EXPRESSION next and yields no
 * value of its own, so the grammar forbids division there — `throw /[/*]/` is a thrown regex, and
 * reading its slash as division leaves the `/*` inside the character class to open a comment that
 * swallows every line below. The whole expression-prefix set is listed rather than the few that came
 * up, since a keyword missing from it costs the rest of the file.
 */
const EXPRESSION_KEYWORDS = String.raw`\b(?:return|case|typeof|throw|instanceof|delete|void|yield|await|new|else|do|in|of)`;

/**
 * The punctuation the same rule covers: openers, separators, and the binary and unary operators
 * that expect an expression next. Arithmetic counts as much as assignment — `prefix + /[/*]/.source`
 * concatenates a regex source, and reading that slash as division leaves the `/*` inside the
 * character class to open a comment over the rest of the file.
 *
 * Division is one of them: `total / /[/*]/.source.length` divides by a regex's source length, and
 * the slash before a divisor expects an expression exactly as `+` does. The `//` and `/*` forms are
 * recognized ahead of this rule everywhere it is read, so a comment's own slashes never reach it.
 *
 * Bitwise-not is in the set for the same reason as `!`: `~/[/*]/.test(input)` coerces a match, and
 * `~` is prefix-only — it never follows a value, so a `/` behind it can never divide.
 *
 * `++`/`--` are excluded, since `i++ / 2` divides: the trailing `+` there is a postfix operator that
 * DOES yield a value. `<` and `>` are held apart in `COMPARISON_OPERATORS`, since they lead an
 * expression only across whitespace.
 *
 * Spread is spelled out as its own alternative because a single `.` is the opposite rule: `...` can
 * only be followed by an expression — `[.../[/*]/.source]` spreads a regex's source — while
 * `array.length / 2` divides behind an ordinary property-access dot. Three dots are the whole
 * distinction, so only the triple is read as a prefix.
 */
const EXPRESSION_OPERATORS = String.raw`=>|\.\.\.|[([{,;:=!&|?*%^/~]|(?<!\+)\+|(?<!-)-`;

/**
 * The comparison operators, which expect an expression next exactly as the binary operators above do
 * — `value < /[/*]/.source` compares against a regex's source — but only ACROSS WHITESPACE. Written
 * tight the same characters are JSX punctuation: `</div>` closes a tag and `<div></div>` carries a
 * `>/` pair, and reading either as a regex opener would blank the brackets between two tags on one
 * line. A tag never puts a gap between its `<` and its `/`; a comparison against a regex literal
 * always does, so the gap is what tells the two apart.
 */
const COMPARISON_OPERATORS = String.raw`[<>]=?`;

/**
 * A regex literal, and only where a `/` can BEGIN one: at the start of a line, or after an opener,
 * a separator, an operator or an expression keyword. After a value — `)`, `]`, an identifier — the
 * same `/` divides, and blanking `a / b(c) / d` would eat the parens it spans. The prefix is
 * captured rather than looked behind so the scan resumes after it, and the body admits an escape or
 * a character class so `/[/]/` and `/\(/` both close where they actually close. A class carries
 * escapes of its own — `/[\(]/`, `/[\w]/` — so its content admits them too: refusing them fails the
 * whole class branch, and the `(` left behind in `/[\(]/` is counted as a delimiter by `parenDelta`.
 *
 * Without this a parameter default like `pattern = /\(/` leaves an unmatched `(` for `parenDelta`
 * to count, the signature never closes on its real `)`, and every statement below it reads as more
 * parameter list — turning a genuine clone of runtime work into a declaration and dropping it.
 */
const REGEX_LITERAL = new RegExp(
  String.raw`(^|${EXPRESSION_OPERATORS}|${EXPRESSION_KEYWORDS}|${COMPARISON_OPERATORS}(?=\s))(\s*)\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\[])+\/[dgimsuvy]*`,
  "g",
);

/** The same prefixes, anchored to the END of the text before a `/` — the one rule, read backwards. */
const REGEX_PREFIX = new RegExp(String.raw`(?:${EXPRESSION_OPERATORS}|${EXPRESSION_KEYWORDS})$`);

/** Its comparison half, read the same way; the gap the rule turns on is checked by the caller. */
const COMPARISON_PREFIX = new RegExp(String.raw`(?:${COMPARISON_OPERATORS})$`);

/**
 * Strip what would confuse brace counting: comments, string bodies and regex literals. Block
 * comments go too, and not only the ones a line opens with — a declaration closed by a trailing
 * block comment holding a brace would otherwise have that brace counted, keeping the import open
 * over every function below it. Templates go FIRST, through the same masker that carries them
 * across lines, because they nest — pairing backticks with a regex would read a nested literal's
 * opener as the outer one's close and hand the text between them over as syntax. Quotes are
 * blanked next, so a comment opener inside one is not read as a comment; regexes go LAST, so prose
 * that happens to hold a `/…/` is already gone and cannot be read as one. Crude on purpose — the
 * only thing riding on it is where a multi-line import or type declaration ends, and an unbalanced
 * count there classifies a line as `type`/`import` rather than dropping anything on its own.
 */
function stripNoise(line: string): string {
  return maskTemplate(line, []).text
    .replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/, "")
    .replace(/\/\*.*$/, "")
    .replace(REGEX_LITERAL, (_match, prefix: string, space: string) => `${prefix}${space}""`);
}

/** Where a quoted string ends, escapes and all; the line's end when it never closes. */
function afterQuoted(line: string, start: number): number {
  const quote = line[start];
  for (let i = start + 1; i < line.length; i += 1) {
    if (line[i] === "\\") i += 1;
    else if (line[i] === quote) return i + 1;
  }
  return line.length;
}

/**
 * The same text with every literal and comment span blanked to spaces. Length is preserved, so an
 * index measured in the original still points at the same character — which is what the backward
 * scans below need: they walk `before` from its end counting brackets to find the `(` or `{` that
 * its trailing `)` or `}` closes, then read the text in front of that opener.
 *
 * A bracket written inside a string, a template or a comment is TEXT, not nesting. Left standing,
 * `const x = { val: "}" } / count` ends the scan one level deep, the object literal's `}` reads as a
 * block's, and the divisor's slash is taken for a regex opener. Regex literals are blanked last for
 * `stripNoise`'s reason — with quotes already gone, prose holding a `/…/` cannot be read as one.
 */
function blankLiterals(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === "'" || char === '"') {
      const end = afterQuoted(text, i);
      out += " ".repeat(end - i);
      i = end;
      continue;
    }
    if (char === "`") {
      const end = afterTemplate(text, i);
      out += " ".repeat(end - i);
      i = end;
      continue;
    }
    if (char === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      const close = text[i + 1] === "*" ? text.indexOf("*/", i + 2) : -1;
      const end = close < 0 ? text.length : close + 2;
      out += " ".repeat(end - i);
      i = end;
      continue;
    }
    out += char;
    i += 1;
  }
  return out.replace(
    REGEX_LITERAL,
    (match: string, prefix: string, space: string) =>
      `${prefix}${space}${" ".repeat(match.length - prefix.length - space.length)}`,
  );
}

/**
 * The heads whose parenthesized clause is followed by a STATEMENT rather than by more expression.
 * `for await` is the same head with its async spelling — the `await` there is part of the loop, not
 * an operator yielding a value, so its clause hands to a statement exactly as a plain `for` does.
 * `with` is on the list because sloppy-mode scripts still carry it and `with (obj) /[/*]/.test(v)`
 * is a legal body; a MEMBER of the same name is not, since `array.with(0, x)` yields a value and
 * `array.with(0, x) / 2` divides — hence the dot the head is refused behind.
 */
const CONTROL_HEAD = /(?<!\.\s*)\b(?:if|for(?:\s+await)?|while|with)\s*$/;

/**
 * Whether the text ends with the `)` that CLOSES a control-flow head — `if (enabled)`, `for (…)`,
 * `while (…)`. Every other `)` ends a value, so a `/` behind it divides; these hand to a statement,
 * and `if (enabled) /[/*]/.test(value);` runs a regex test as its body. Read as division, the `/*`
 * inside that character class opens a comment that swallows every line below.
 *
 * The paren is matched backwards rather than assumed, because a call closes one too and
 * `compute(a) / 2` divides. Only the head's own `(` decides, so the keyword is read at the position
 * that balances — `if (has(a)) /re/.test(b)` finds `if`, `compute(a) / 2` finds nothing.
 */
function closesControlHead(before: string): boolean {
  if (!before.endsWith(")")) return false;
  let depth = 0;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    if (before[i] === ")") depth += 1;
    else if (before[i] === "(") {
      depth -= 1;
      if (depth === 0) return CONTROL_HEAD.test(before.slice(0, i));
    }
  }
  return false;
}

/**
 * What an open `{` turned out to be. A block ends a STATEMENT, so a `/` behind its `}` opens a
 * regex; an object literal ends a VALUE, so the same `/` divides.
 */
type BraceKind = "block" | "value";

/**
 * The two spellings where a trailing `:` hands to a STATEMENT rather than to a value — a statement
 * label (`outer:`) and a switch arm (`case "draft":`, `default:`). The `:` is an expression prefix
 * everywhere else, so without this `outer: {` records an object literal and the `}` that closes it
 * is not read as a statement boundary: `} /[/*]/.test(value);` on the next line then opens a
 * phantom comment that drops every executable window below it.
 *
 * The label must be the whole clause — a name, or a `case` expression carrying no `:` of its own —
 * so a property key with a value already on the line (`retries: 3,`) never reads as one.
 */
const STATEMENT_LABEL = /(?:^|[;{}])\s*(?:case\b[^:]*|default|[A-Za-z_$][\w$]*)\s*:$/;

/**
 * The expression keywords whose own `{` nevertheless opens a BLOCK. `else` and `do` hand to a
 * STATEMENT — `} else { … }`, `do { … } while (…)` — so their brace is the block the keyword leads,
 * not a value. Read as an object literal, the `}` that closes it is no longer a statement boundary
 * and `} /[/*]/.test(value);` below opens a phantom comment over every window that follows. They
 * stay in `EXPRESSION_KEYWORDS` all the same, since `else /[/*]/.test(value);` is a regex statement
 * body; only the brace is the exception. A dot refuses the keyword for `CONTROL_HEAD`'s reason — a
 * member of the same name yields a value.
 */
const BLOCK_KEYWORD = /(?<!\.\s*)\b(?:else|do)$/;

/**
 * What the `{` that `before` ends at opened. An expression prefix — `=`, `(`, `return` — can only
 * be followed by a value, so the brace opened an object literal; anything else opened a block.
 *
 * A label's `:` is the exception: it is an expression prefix by spelling and a statement boundary in
 * fact. Which one it is depends on where it sits — inside an object literal `handler: {` is a
 * property whose value is another literal, while anywhere else `outer: {` is a labeled block — so
 * the kind of the brace ENCLOSING it decides.
 */
function braceKind(before: string, enclosing: BraceKind | undefined): BraceKind {
  const text = before.trimEnd();
  if (enclosing !== "value" && STATEMENT_LABEL.test(text)) return "block";
  if (BLOCK_KEYWORD.test(text)) return "block";
  return REGEX_PREFIX.test(text) ? "value" : "block";
}

/**
 * Whether the trailing `}` of `before` closes a BLOCK rather than an object literal. A block ends a
 * statement, so a `/` behind it opens a regex; an object literal is a VALUE, so the same `/`
 * divides — `const ratio = { value: 1 } / /[/*]/.source.length` divides by a regex's source length,
 * and reading its first slash as an opener runs an invented literal to the second one and leaves the
 * `/*` in that character class to open a comment over every line below.
 *
 * The `{` that matches is found by a balanced scan backwards, as the control head's `(` is, and
 * `braceKind` reads what precedes it. A `{` opened on an EARLIER line is not on this line to read,
 * so the kinds `open`
 * carries from above decide instead: a multiline object literal ends on a line leading with its own
 * `}`, and `} / /[/*]/.source.length` divides there exactly as the one-line spelling does. The
 * backward scan ends one level deep per unmatched `}`, so the brace this one closes sits that many
 * levels down that stack; anything the stack does not reach still reads as a block, which is what
 * this rule assumed of every `}` before the distinction existed.
 */
function closesBlock(before: string, open: readonly BraceKind[]): boolean {
  let depth = 0;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    if (before[i] === "}") depth += 1;
    else if (before[i] === "{") {
      depth -= 1;
      if (depth === 0) return braceKind(before.slice(0, i), open[open.length - 1]) === "block";
    }
  }
  return open[open.length - depth] !== "value";
}

/**
 * Fold this line's braces into the kinds still open above it, so a `}` on a LATER line knows what it
 * closed. The rule is `braceKind`'s, the one `closesBlock` reads within a line, carried ACROSS
 * lines — the kinds already on the stack are what tells a labeled block's `{` from an object
 * literal's property. `stripNoise` runs first — a brace inside a
 * comment, a string or a regex opens nothing — and an unmatched `}` simply pops nothing, since a
 * file whose braces do not balance is one this scanner is already guessing about.
 */
function trackBraces(open: BraceKind[], line: string): void {
  const text = stripNoise(line);
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "{") {
      open.push(braceKind(text.slice(0, i), open[open.length - 1]));
    } else if (text[i] === "}") open.pop();
  }
}

/**
 * Whether the `/` at `start` OPENS a regex literal rather than divides — `REGEX_PREFIX` read
 * against the text BEHIND the slash, for the scanners that walk a line character by character
 * instead of matching it whole, plus the two prefixes a regex cannot express: the `)` of a
 * control-flow head, which takes a balanced scan backwards to tell from a call's, and the `}` that
 * closes a block, which is told from an object literal's by the same scan and from JSX's self-close
 * by the character AFTER the slash.
 */
function opensRegex(
  line: string,
  start: number,
  jsx: boolean,
  open: readonly BraceKind[],
): boolean {
  const raw = line.slice(0, start);
  const before = raw.trimEnd();
  if (before === "") return true;
  // A comparison counts only when it stands off from the slash, and only where a tag could be meant
  // instead: the trimmed text is what the prefix is read against, so whether anything WAS trimmed is
  // the whole distinction between `value < /re/` and a closing tag. Outside a JSX language no tag
  // can be meant at all, and the tight `value</re/.source` is the comparison it looks like.
  if (COMPARISON_PREFIX.test(before) && (!jsx || raw.length > before.length)) return true;
  // Only the bracket scans read a blanked copy: they count nesting, where a bracket inside a string
  // is text. The prefix tests above and below read the text as written, since a string is a VALUE —
  // blanking one to spaces would make `const a = "x" / 2` look like a line leading with its slash.
  const nesting = blankLiterals(before);
  if (closesControlHead(nesting)) return true;
  // A `}` that ends a BLOCK hands to a fresh STATEMENT — `if (enabled) {} /[/*]/.test(value);`
  // tests a regex. Read as division, the `/*` inside that character class opens a comment that
  // swallows every line below. An object literal's `}` ends a value instead, so `closesBlock` tells
  // the two apart. The one block-closing `}` a slash follows without a statement starting is JSX's
  // self-close: `<Icon size={n} /> {/* note` puts a `/` there too, and reading it as an opener would
  // run an invented literal over the `{/*` that follows and leave that comment unseen. The `>` is
  // what tells them apart — a literal `/>/` loses to the tag, which is what the character pair means
  // in the TSX this actually scans.
  if (before.endsWith("}") && line[start + 1] !== ">" && closesBlock(nesting, open)) return true;
  return REGEX_PREFIX.test(before);
}

/**
 * Where the regex literal opened at `start` ends, escapes and character classes and all — `-1` when
 * it never closes on the line, which proves the slash was not one (the grammar forbids the break).
 */
function afterRegex(line: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < line.length; i += 1) {
    const char = line[i];
    if (char === "\\") i += 1;
    else if (inClass) inClass = char !== "]";
    else if (char === "[") inClass = true;
    else if (char === "/") return i + 1;
  }
  return -1;
}

/**
 * One level of the nesting a template opens: its raw TEXT, or the expression of a `${…}` inside it.
 * An expression can open templates of its own, so what closes an outer literal is the backtick that
 * matches it — not the next one on the line. `depth` tracks the braces the expression opens, so the
 * `}` that ends it is told apart from the ones inside an object it builds.
 */
type TemplateFrame = { kind: "text" } | { kind: "expression"; depth: number };

/**
 * Blank the template literals a line carries, INCLUDING the one it leaves open. A multiline
 * template is raw text, but a `(` in that text would otherwise reach `parenDelta` as syntax: a
 * parameter list whose default opens with `raw (` never closes on its real `)`, and every statement
 * below it inherits `signature` — dropping a genuine clone of runtime work.
 *
 * Nesting is tracked rather than closing on every unescaped backtick, because a template's
 * interpolation may hold another template (`` `outer ${`inner (`} tail` ``). Read pairwise, the
 * nested opener closes the outer literal and exposes its raw `(` — the very leak this exists to
 * stop. The whole construct is blanked, interpolations and all: a `${…}` holds a complete
 * expression, so its own delimiters balance and hiding them costs nothing.
 *
 * Quoted strings and comments are stepped over rather than parsed, so a backtick sitting inside a
 * quoted string or a trailing `//` note opens nothing. The stack is returned so the next line
 * resumes exactly where this one stopped.
 */
function maskTemplate(
  line: string,
  stack: readonly TemplateFrame[],
): { text: string; stack: TemplateFrame[] } {
  const frames: TemplateFrame[] = stack.map((frame) => ({ ...frame }));
  let text = frames.length > 0 ? '""' : "";
  let i = 0;
  while (i < line.length) {
    const char = line[i];
    const top = frames[frames.length - 1];
    if (top?.kind === "text") {
      if (char === "\\") i += 2;
      else if (char === "`") {
        frames.pop();
        i += 1;
      } else if (char === "$" && line[i + 1] === "{") {
        frames.push({ kind: "expression", depth: 0 });
        i += 2;
      } else i += 1;
      continue;
    }
    if (char === "`") {
      frames.push({ kind: "text" });
      if (frames.length === 1) text += '""';
      i += 1;
      continue;
    }
    if (top?.kind === "expression" && (char === "{" || char === "}")) {
      if (char === "{") top.depth += 1;
      else if (top.depth > 0) top.depth -= 1;
      else frames.pop();
      i += 1;
      continue;
    }
    let end = i + 1;
    if (char === "'" || char === '"') end = afterQuoted(line, i);
    else if (char === "/" && line[i + 1] === "/") end = line.length;
    else if (char === "/" && line[i + 1] === "*") {
      const close = line.indexOf("*/", i + 2);
      end = close < 0 ? line.length : close + 2;
    }
    if (frames.length === 0) text += line.slice(i, end);
    i = end;
  }
  return { text, stack: frames };
}

/**
 * Where the template literal opened at `start` ends — the backtick that MATCHES it, and the line's
 * end when it never closes. Pairing backticks instead would end the outer literal on a nested one's
 * opener: in `` `${`in/*ner`}` `` the scan would resume inside the inner literal's TEXT and read its
 * `/*` as a comment opener, filing every line below a balanced one-liner as prose.
 *
 * Quoted strings inside an interpolation are stepped over, so a backtick quoted in one closes
 * nothing.
 */
function afterTemplate(line: string, start: number): number {
  const frames: TemplateFrame[] = [{ kind: "text" }];
  let i = start + 1;
  while (i < line.length) {
    const char = line[i];
    const top = frames[frames.length - 1];
    if (top.kind === "text") {
      if (char === "\\") i += 2;
      else if (char === "`") {
        frames.pop();
        i += 1;
        if (frames.length === 0) return i;
      } else if (char === "$" && line[i + 1] === "{") {
        frames.push({ kind: "expression", depth: 0 });
        i += 2;
      } else i += 1;
      continue;
    }
    if (char === "`") frames.push({ kind: "text" });
    else if (char === "{") top.depth += 1;
    else if (char === "}") {
      if (top.depth > 0) top.depth -= 1;
      else frames.pop();
    } else if (char === "'" || char === '"') {
      i = afterQuoted(line, i);
      continue;
    }
    i += 1;
  }
  return line.length;
}

/** The delimiters a string can span lines behind. */
const TRIPLE_QUOTES = ['"""', "'''"] as const;
type TripleQuote = (typeof TRIPLE_QUOTES)[number];

/** The half of them Kotlin, Java, Scala and Swift open a multiline string with. */
const DOUBLE_TRIPLE_QUOTES: readonly TripleQuote[] = ['"""'];

/**
 * Blank the triple-quoted strings a line carries, INCLUDING the one it leaves open — Python's
 * docstrings and its SQL constants, Kotlin's raw strings, Java's text blocks. Such a string holds
 * arbitrary text, and a fixture inside one routinely quotes source: an example `import (` in it
 * would otherwise reach the declaration classifiers as syntax, opening `import` state that no real
 * `)` ever closes, and every executable window past the closing delimiter inherits the class and is
 * dropped as a specifier list.
 *
 * Single quotes and comments are stepped over rather than parsed, so neither an apostrophe in prose
 * nor a `"""` inside a note opens anything — read with the marker the language actually uses, since
 * a `#` cuts a line in Python and means nothing in Kotlin. The open delimiter is returned so the
 * next line resumes behind the one that opened — `'''` does not close a `"""`.
 */
function maskTripleQuoted(
  line: string,
  open: TripleQuote | undefined,
  delimiters: readonly TripleQuote[],
  hashComments: boolean,
): { text: string; open: TripleQuote | undefined } {
  let quote = open;
  let text = quote ? '""' : "";
  let i = 0;
  while (i < line.length) {
    if (quote) {
      // A backslash defers the next character even in a raw string, where it stays in the value but
      // still cannot end it.
      if (line[i] === "\\") i += 2;
      else if (line.startsWith(quote, i)) {
        quote = undefined;
        i += 3;
      } else i += 1;
      continue;
    }
    const opener = delimiters.find((delimiter) => line.startsWith(delimiter, i));
    if (opener) {
      quote = opener;
      text += '""';
      i += 3;
      continue;
    }
    const char = line[i];
    if (hashComments) {
      if (char === "#") break;
    } else if (char === "/" && line[i + 1] === "/") break;
    else if (char === "/" && line[i + 1] === "*") {
      const close = line.indexOf("*/", i + 2);
      // An unclosed opener leaves the rest of the line as prose; the caller keeps the text it has.
      if (close < 0) break;
      text += line.slice(i, close + 2);
      i = close + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const end = afterQuoted(line, i);
      text += line.slice(i, end);
      i = end;
      continue;
    }
    text += char;
    i += 1;
  }
  return { text, open: quote };
}

/**
 * Rust's raw string opener — `r"`, `r#"`, `br##"`, `cr#"`. The hashes are CAPTURED because only a
 * `"` carrying the same number of them closes the string; that is the whole point of the form.
 * Sticky, so it is read at one position rather than searched for, and whether the token starts
 * there is the caller's check — an `r` inside an identifier opens nothing.
 */
const RAW_STRING_OPEN = /(?:b|c)?r(#*)"/y;

/**
 * Rust's char literal — `'x'`, `'\n'`, `'\u{1f600}'`. A `'` that opens none of those is a lifetime
 * (`&'a str`), which delimits nothing: read as a quote it would swallow the rest of the line and
 * hide a raw string opening after it.
 */
const CHAR_LITERAL = /^'(?:\\[^']*|[^'\\])'/;

/**
 * Blank the Rust raw strings a line carries, INCLUDING the one it leaves open. `r#"…"#` holds
 * arbitrary text that no escape sequence can end — an embedded query, a shell snippet, a fixture of
 * source code — so without this its text reaches the declaration classifiers as syntax: an
 * `import (` quoted inside one opens import state that no real `)` closes, and every executable
 * window past the closing `"#` inherits the class and is dropped as a specifier list.
 *
 * The hash COUNT is carried rather than a flag, since a `"#` inside an `r##"…"##` string closes
 * nothing. Quoted strings, char literals and comments are stepped over, so an `r"` inside any of
 * them opens nothing; the count is returned so the next line resumes behind the same delimiter.
 */
function maskRawString(
  line: string,
  open: number | undefined,
): { text: string; open: number | undefined } {
  let hashes = open;
  let text = hashes === undefined ? "" : '""';
  let i = 0;
  while (i < line.length) {
    if (hashes !== undefined) {
      if (line[i] === '"' && line.startsWith("#".repeat(hashes), i + 1)) {
        i += 1 + hashes;
        hashes = undefined;
      } else i += 1;
      continue;
    }
    const char = line[i];
    // Only where a token STARTS: `bar"` is an identifier beside a string, and `r#type` is a raw
    // identifier — neither opens anything.
    if (!/\w/.test(line[i - 1] ?? "")) {
      RAW_STRING_OPEN.lastIndex = i;
      const opened = RAW_STRING_OPEN.exec(line);
      if (opened) {
        hashes = opened[1].length;
        text += '""';
        i += opened[0].length;
        continue;
      }
    }
    if (char === "'") {
      const literal = CHAR_LITERAL.exec(line.slice(i));
      const end = literal ? i + literal[0].length : i + 1;
      text += line.slice(i, end);
      i = end;
      continue;
    }
    if (char === '"') {
      const end = afterQuoted(line, i);
      text += line.slice(i, end);
      i = end;
      continue;
    }
    if (char === "/" && line[i + 1] === "/") break;
    if (char === "/" && line[i + 1] === "*") {
      const close = line.indexOf("*/", i + 2);
      if (close < 0) break;
      text += line.slice(i, close + 2);
      i = close + 2;
      continue;
    }
    text += char;
    i += 1;
  }
  return { text, open: hashes };
}

/** Net nesting a line opens, over the brackets given — `stripNoise`d, so a brace in a string is not one. */
function nestingDelta(line: string, open: string, close: string): number {
  const text = stripNoise(line);
  let depth = 0;
  for (const char of text) {
    if (open.includes(char)) depth += 1;
    else if (close.includes(char)) depth -= 1;
  }
  return depth;
}

const braceDelta = (line: string): number => nestingDelta(line, "{([", "})]");
/** Parens alone: a signature ends when its PARAMETER list closes, not when its body brace opens. */
const parenDelta = (line: string): number => nestingDelta(line, "(", ")");

/** An `=` that assigns, not `==`/`=>`/`<=` — the mark of a default value in a parameter list. */
const PARAMETER_DEFAULT = /(?:^|[^=!<>])=(?!=|>)/;

/**
 * Whether a parameter line carries a default — `client = createClient()`, `{ limit = 10 }`. The
 * names and type annotations around it declare, but an initializer RUNS on every call, so a window
 * of them is real duplicated computation and the line votes as code.
 */
function hasParameterDefault(line: string): boolean {
  return PARAMETER_DEFAULT.test(stripNoise(line));
}

/**
 * The same question for a header line, where the `=` of `const f = (` is the binding rather than a
 * default: only what follows the parameter list's opening paren counts.
 */
function headerHasParameterDefault(line: string): boolean {
  const text = stripNoise(line);
  const open = text.indexOf("(");
  return open >= 0 && PARAMETER_DEFAULT.test(text.slice(open + 1));
}

/**
 * A type line left mid-expression — `type X =`, a trailing union bar, an open generic. The alias
 * cannot have ended here whatever the next line says.
 */
const TYPE_UNFINISHED = /(?:[=|&,<(:?]|\bextends)$/;

/** The next line picking that alias back up — a leading `| member`, `& Other`, `extends X`. */
const TYPE_RESUMED = /^(?:[|&?:]|extends\b)/;

/**
 * Whether a declaration statement runs past this line. An import ends when its bracket list closes
 * and no other way: Python's `import os` and Go's `import (\n  "fmt"\n)` carry neither a `;` nor a
 * quoted `from` clause, and reading one as unterminated would classify the whole rest of the file as
 * an import.
 *
 * A `type X =` union opens no bracket at all, so it is read off the expression instead of off a
 * terminator: a repo that writes no semicolons ends `type Status = "ready" | "done"` with the line,
 * and a union of inline objects (`| { mode: "dev" }`) closes a brace on every member without ending
 * anything. Only an unfinished line, or one the NEXT line continues, keeps the alias open.
 *
 * Python's explicit line join is the one continuation that opens no bracket either — `from package
 * import first, \` carries its remaining names on the lines below with a depth of zero. Ending the
 * statement there hands a specifier list to the filter as executable code.
 */
function continues(
  kind: "import" | "type",
  line: string,
  depth: number,
  next: string,
): boolean {
  if (depth > 0) return true;
  if (line.endsWith("\\")) return true;
  if (kind === "import" || line.endsWith(";")) return false;
  return TYPE_UNFINISHED.test(line) || TYPE_RESUMED.test(next);
}

/**
 * What a signature line carries once its parameter list closes. `) {` and `): Promise<void> {`
 * open a body — nothing runs on that line; `) => left * right` IS the body and runs on every call.
 * `undefined` when the list does not close here at all, which is what tells an empty tail (`)`)
 * apart from a line that closes nothing.
 */
function closingTail(line: string, depth: number): string | undefined {
  const text = stripNoise(line);
  let open = depth;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "(") open += 1;
    else if (text[i] === ")") {
      open -= 1;
      if (open <= 0) return text.slice(i + 1);
    }
  }
  return undefined;
}

/**
 * Whether that tail holds an expression body rather than an opening brace or a return type. A tail
 * ending in `{` opens a BODY however it got there — including `): (item: Item) => void {`, where the
 * `=>` belongs to the return type and nothing on the line runs.
 */
function hasArrowBody(tail: string): boolean {
  const arrow = tail.indexOf("=>");
  if (arrow < 0) return false;
  const body = tail.slice(arrow + 2).replace(/[;,]+$/, "").trim();
  return body !== "" && !body.endsWith("{");
}

/**
 * Whether the tail of a closing parameter list carries the arrow that DECLARES a function. Only an
 * arrow the list hands to directly (`) => x`) or across a return type (`): number => x`) declares.
 * An arrow reached any other way belongs to something else — `) as (value: string) => string`
 * asserts the TYPE of an expression that already ran — and reading it as a declaration would file a
 * window of live calls as a parameter list.
 */
function hasDeclarationArrow(tail: string): boolean {
  const text = tail.trim();
  if (text.startsWith("=>")) return true;
  // Past a `:` the tail IS the return type, so an arrow anywhere in it is still the signature's own
  // — `): (item: Item) => void {` declares as surely as `): number => x` does.
  return text.startsWith(":") && text.includes("=>");
}

/**
 * Where the body a closing parameter line opens begins — the LAST brace it opens at the tail's own
 * nesting level. Depth is tracked rather than taking the last brace outright, because braces nest
 * both ways around the body: an object return type sits BEFORE it (`): { ok: boolean } {`) and an
 * object the body itself builds sits INSIDE it (`) { return {}; }`). Only a level-0 brace opens a
 * body, and the last one is it. `-1` when the tail opens no body at all.
 */
function bodyBrace(tail: string): number {
  let depth = 0;
  let brace = -1;
  for (let i = 0; i < tail.length; i += 1) {
    if (tail[i] === "{") {
      if (depth === 0) brace = i;
      depth += 1;
    } else if (tail[i] === "}" && depth > 0) depth -= 1;
  }
  return brace;
}

/**
 * Whether the closing line of a parameter list also RUNS something — either as an expression body,
 * or as a braced body opened and closed on the same line (`) { return execute(); }`).
 */
function hasInlineBody(tail: string): boolean {
  if (hasArrowBody(tail)) return true;
  const brace = bodyBrace(tail);
  if (brace < 0) return false;
  return tail.slice(brace + 1).replace(/[});,\s]+$/, "").trim() !== "";
}

/**
 * Walk a line already INSIDE a block comment: how many levels it leaves open, and what follows the
 * delimiter that closed the last one.
 *
 * Depth is carried rather than a flag because Rust, Swift, Scala and Kotlin NEST — an outer `/*`
 * closes only on the closer that matches it. Commenting out a block that already holds a comment is
 * how the nesting arises at all, so closing at the inner delimiter hands the still-commented
 * remainder over as syntax: a `let load = (` inside it opens a parameter list nothing ever closes,
 * and every executable line past the real closer inherits `signature` and is dropped as a
 * declaration.
 */
function insideBlockComment(
  line: string,
  depth: number,
  nested: boolean,
): { depth: number; rest: string } {
  let level = depth;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "*" && line[i + 1] === "/") {
      level -= 1;
      i += 2;
      if (level === 0) return { depth: 0, rest: line.slice(i) };
      continue;
    }
    if (nested && line[i] === "/" && line[i + 1] === "*") {
      level += 1;
      i += 2;
      continue;
    }
    i += 1;
  }
  return { depth: level, rest: "" };
}

/**
 * What is left of a line once the block comments it OPENS are stripped — `""` when the line is
 * nothing but comment — and how many comment levels it leaves running past its end. A line that
 * closes its comment and then calls something still executes, so the suffix is classified rather
 * than read as prose.
 */
function afterBlockComment(line: string, nested: boolean): { depth: number; rest: string } {
  let rest = line;
  while (rest.startsWith("/*")) {
    const walked = insideBlockComment(rest.slice(2), 1, nested);
    if (walked.depth > 0) return { depth: walked.depth, rest: "" };
    rest = walked.rest.trim();
  }
  return { depth: 0, rest };
}

/**
 * The line with a trailing `#` note cut off — `)  # keep { documented` back to `)`. A `#`-comment
 * file has no block-comment state and no `stripNoise` rule for the marker, so an inline note reaches
 * the delta counters as syntax: one unmatched delimiter inside the prose holds a parenthesized
 * import open over every executable line below it, and each is dropped as a specifier.
 *
 * Under `spaced` only a `#` that starts a word counts, so shell's `${#items[@]}` and `$#` keep their
 * delimiters; elsewhere any unquoted `#` cuts, as Python and TOML read it. Quoted strings are
 * stepped over either way, so a `#` inside one opens nothing.
 */
function withoutHashComment(line: string, spaced: boolean): string {
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "'" || char === '"') {
      i = afterQuoted(line, i) - 1;
      continue;
    }
    if (char !== "#") continue;
    if (!spaced || i === 0 || /\s/.test(line[i - 1])) return line.slice(0, i).trimEnd();
  }
  return line;
}

/** A heredoc still owed its payload: the word that ends it, and whether `<<-` strips leading tabs. */
type Heredoc = { word: string; tabs: boolean };

/**
 * A heredoc opener — `<<EOF`, `<<-'SQL'`, `<< "END"`, `<<\END` — up to but not including its word,
 * with the `-` of the tab-stripping form captured. Sticky, so it is read at one position rather
 * than searched for. `<<<` is a herestring, which carries its whole value on the line and opens
 * nothing, so both neighbours of the `<<` are checked.
 */
const HEREDOC_OPEN = /(?<!<)<<(?!<)(-?)/y;

/** Where an unquoted delimiter word ends: shell's metacharacters, which cannot be part of one. */
const WORD_BREAK = /[\s;&|<>()`]/;

/**
 * The delimiter word after a `<<`, read from `start` — `EOF`, `'END-SQL'`, `"end marker"`, `\END`,
 * `EO'F'`. Quote removal is the only expansion a delimiter gets, so the quotes come off and
 * everything between them — punctuation included — belongs to the terminator. Restricting the word
 * to identifier characters instead would leave `cat <<'END-SQL'` untracked, and payload text like
 * `function fake(` would open a parameter list that swallows the commands past the real terminator.
 *
 * Undefined where no word follows, or where a quote in it never closes — neither is a heredoc a
 * shell would open.
 */
function heredocWord(line: string, start: number): { word: string; end: number } | undefined {
  let i = start;
  while (line[i] === " " || line[i] === "\t") i += 1;
  let word = "";
  while (i < line.length) {
    const char = line[i];
    if (char === "'" || char === '"') {
      const close = line.indexOf(char, i + 1);
      if (close === -1) return undefined;
      word += line.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (char === "\\") {
      if (i + 1 >= line.length) break;
      word += line[i + 1];
      i += 2;
      continue;
    }
    if (WORD_BREAK.test(char)) break;
    word += char;
    i += 1;
  }
  return word ? { word, end: i } : undefined;
}

/**
 * The heredocs a line opens, in the order their payloads arrive — one command can open two
 * (`cmd <<A <<B`). Quoted strings are stepped over, so a `<<EOF` inside one opens nothing.
 */
function heredocDelimiters(line: string): Heredoc[] {
  const found: Heredoc[] = [];
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "'" || char === '"') {
      i = afterQuoted(line, i) - 1;
      continue;
    }
    if (char !== "<") continue;
    HEREDOC_OPEN.lastIndex = i;
    const opened = HEREDOC_OPEN.exec(line);
    if (!opened) continue;
    const delimiter = heredocWord(line, HEREDOC_OPEN.lastIndex);
    if (!delimiter) {
      i = HEREDOC_OPEN.lastIndex - 1;
      continue;
    }
    found.push({ word: delimiter.word, tabs: opened[1] === "-" });
    i = delimiter.end - 1;
  }
  return found;
}

/**
 * Whether a payload line is the terminator of the heredoc it is inside. Shell ends a heredoc only
 * on a line that is EXACTLY the delimiter, so the whitespace around it is part of the comparison —
 * an indented `  EOF` under a plain `<<EOF` is payload, and so is a trailing-space `EOF   `. Ending
 * the heredoc on either would hand the declaration-looking text below it back to the classifiers,
 * and the commands past the REAL terminator inherit whatever state that text opens. Only `<<-`
 * strips leading TABS (never spaces), which is the whole point of that form.
 *
 * The one thing stripped from the tail is a `\r`, which is not payload but the other half of a CRLF
 * line ending — `split("\n")` leaves it on every line of such a file, and the delimiter word read
 * off the opener never carries one.
 */
function endsHeredoc(raw: string, heredoc: Heredoc): boolean {
  const line = heredoc.tabs ? raw.replace(/^\t+/, "") : raw;
  return line.replace(/\r$/, "") === heredoc.word;
}

/**
 * Where a block comment OPENS on this line and is never closed on it — `value: string, /* why`.
 * Quoted strings, templates, regex literals and `//` notes are stepped over, so a `/*` inside any
 * of them opens nothing, and a comment that closes is skipped past so a later opener is still
 * found. An opener of `-1` means the line leaves no comment running; `depth` is what it leaves open
 * where comments nest, since an outer `/*` holding an inner one needs two closers to end.
 *
 * Without it the prose below such a line is read as syntax: an unmatched `(` inside the comment
 * holds `statement` in `signature` or `import` past the real declaration, and every executable
 * window under it classifies as declarative and is dropped unread. A regex is stepped over for the
 * same reason in reverse: `pattern = /[/*]/` carries the two characters of an opener inside a
 * character class, and reading them as one would file every line below it as prose.
 */
function unclosedBlockComment(
  line: string,
  nested: boolean,
  jsx: boolean,
  open: readonly BraceKind[],
): { opener: number; depth: number } {
  let i = 0;
  while (i < line.length) {
    const char = line[i];
    if (char === "'" || char === '"') {
      i = afterQuoted(line, i);
      continue;
    }
    // A template is stepped over through its own nesting rather than paired backtick to backtick: a
    // literal nested in an interpolation would otherwise close the outer one, exposing its raw text.
    if (char === "`") {
      i = afterTemplate(line, i);
      continue;
    }
    if (char === "/" && line[i + 1] === "/") return { opener: -1, depth: 0 };
    if (char === "/" && line[i + 1] === "*") {
      const walked = insideBlockComment(line.slice(i + 2), 1, nested);
      if (walked.depth > 0) return { opener: i, depth: walked.depth };
      i = line.length - walked.rest.length;
      continue;
    }
    // Checked AFTER the comment forms, since a `/*` at a position where a regex could begin is a
    // comment in the grammar too. A slash that opens nothing that closes is left as division.
    if (char === "/" && opensRegex(line, i, jsx, open)) {
      const end = afterRegex(line, i);
      if (end > 0) {
        i = end;
        continue;
      }
    }
    i += 1;
  }
  return { opener: -1, depth: 0 };
}

/** The quotes an ordinary, single-line string is written behind. */
type QuoteChar = "'" | '"';

/**
 * Where an ordinary quoted string OPENS on this line and a trailing backslash carries it onto the
 * next — `const fixture = "example \`. Its text is not syntax, so the caller blanks it from the
 * opener on and resumes inside the same quote below.
 *
 * A quote left hanging WITHOUT that backslash opens nothing: the literal is then unterminated,
 * which no language accepts, and reading the rest of the file as its text would drop every window
 * below it. Comments and regex literals are stepped over for the reason the block-comment scanner
 * steps over them — the apostrophe in a trailing `// don't` note quotes nothing, and `/["']/` holds
 * quotes inside a character class.
 *
 * Without it the string's own text is read as syntax: a fixture line leading `import {` opens
 * import state whose unmatched brace never closes, and every executable window past the closing
 * quote inherits the class and is dropped as a specifier list.
 */
function continuedQuote(
  line: string,
  slashComments: boolean,
  jsx: boolean,
  open: readonly BraceKind[],
): { opener: number; quote: QuoteChar } | undefined {
  if (!line.endsWith("\\")) return undefined;
  let i = 0;
  while (i < line.length) {
    const char = line[i];
    if (char === "'" || char === '"') {
      const end = afterQuoted(line, i);
      // `afterQuoted` stops at the line's end whether the closer arrived or not; the character it
      // stopped on is what tells the two apart. A lone quote is its own opener, never its closer.
      if (end - 1 === i || line[end - 1] !== char) return { opener: i, quote: char };
      i = end;
      continue;
    }
    if (slashComments) {
      if (char === "/" && line[i + 1] === "/") return undefined;
      if (char === "/" && line[i + 1] === "*") {
        const close = line.indexOf("*/", i + 2);
        // An opener the line never closes is already cut by `unclosedBlockComment`; a remnant of one
        // leaves nothing behind it that could open a string.
        if (close < 0) return undefined;
        i = close + 2;
        continue;
      }
      if (char === "/" && opensRegex(line, i, jsx, open)) {
        const end = afterRegex(line, i);
        if (end > 0) {
          i = end;
          continue;
        }
      }
    }
    i += 1;
  }
  return undefined;
}

/**
 * Blank the text a continued string leaves on this line — up to the quote that closes it, or the
 * whole line when a backslash carries it on again. What follows the closer is handed back, since
 * that suffix is real syntax: `still text";` ends a statement.
 *
 * A line that neither closes nor continues ENDS the string here rather than running on: the file is
 * malformed at that point, and recovering costs the one line where carrying it costs the rest.
 */
function maskContinuedQuote(
  line: string,
  quote: QuoteChar,
): { text: string; open: QuoteChar | undefined } {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "\\") i += 1;
    else if (line[i] === quote) return { text: `""${line.slice(i + 1)}`, open: undefined };
  }
  return { text: '""', open: line.endsWith("\\") ? quote : undefined };
}

/**
 * Classify every line of a file in one forward pass. Whole-file, not just the reported window,
 * because the state that decides what a line IS — inside a block comment, inside a wrapped import,
 * inside an interface body — is only knowable from the lines above it. A bare `readFile,` is an
 * import specifier or a function call depending entirely on what opened above it.
 */
function classifyLines(
  source: string,
  opts: {
    hashComments: boolean;
    spacedHash: boolean;
    slashComments: boolean;
    tripleQuotes: readonly TripleQuote[] | undefined;
    heredocs: boolean;
    nestedComments: boolean;
    boundBareImport: boolean;
    rawStrings: boolean;
    importDeclarations: boolean;
    typeDeclarations: boolean;
    bindingDeclarations: boolean;
    functionHeaders: boolean;
    jsx: boolean;
  },
): LineClass[] {
  const classes: LineClass[] = [];
  // How many block comments are open, not whether one is: where they nest, an inner `*/` closes only
  // the level it opened.
  let commentDepth = 0;
  // Backticks delimit a multiline literal only where the language has one — JS/TS and Go. In a
  // `#`-comment language the same character is shell substitution or prose, so it opens nothing.
  const templates = !opts.hashComments;
  // Same boundary for `/* … */`: in a `#`-comment language a `/*` is a path or a glob (`rm /tmp/*`),
  // and reading it as a comment opener would swallow the rest of the file.
  const blockComments = !opts.hashComments;
  // `//` marks a comment only in the languages that spell one that way. Python and Lua both spell
  // floor division `//`, so a wrapped expression (`value = (total\n  // divisor\n)`) leads lines
  // that plainly compute with one; read as prose they would drop the window as non-code.
  const slashComments = opts.slashComments;
  // Which spelling of the side-effect import this language uses: Go's requires the blank name,
  // since its bare quoted form binds the package instead.
  const sideEffectImport = opts.boundBareImport ? BLANK_IMPORT : SIDE_EFFECT_IMPORT;
  // The delimiters this language opens a multiline string with; empty where it has no such form.
  const tripleQuotes = opts.tripleQuotes ?? [];
  // Empty outside a template; the frames of one it is inside, outermost first.
  let template: TemplateFrame[] = [];
  // The triple-quote delimiter an open multiline string is behind; undefined outside one.
  let tripleQuote: TripleQuote | undefined;
  // The heredocs still owed a payload, in the order they were opened.
  const heredocs: Heredoc[] = [];
  // How many `#` the open Rust raw string's closer must carry; undefined outside one.
  let rawString: number | undefined;
  // The quote an ordinary string a backslash continued is still behind; undefined outside one.
  let quoted: QuoteChar | undefined;
  let depth = 0;
  // The braces still open from the lines ABOVE, innermost last. A `}` that leads a line closes one
  // of these, and whether it ended a block or an object literal is what the `/` behind it reads as.
  const braces: BraceKind[] = [];
  let statement: "import" | "type" | "signature" | undefined;
  // Whether the open import is a side-effect one: held as an `import` so it terminates on its own
  // brace, but every line of it runs, so none of them votes as a declaration.
  let sideEffect = false;
  // Where the open signature started, and whether its arrow is still owed. `const x = (` reads as a
  // parameter list until the closing paren says otherwise, so the lines it claimed must be
  // reachable to hand back when no `=>` arrives.
  let signatureStart = 0;
  let arrow: "owed" | "settled" | "absent" = "settled";

  const lines = source.split("\n");
  // A file's terminal newline TERMINATES its last line rather than starting another, but `split`
  // hands one back as an empty element. Counted, it pads every file by a line, and a window that
  // runs one line off the end reads as complete — the truncated remnant `readWindow` refuses. An
  // EMPTY file is the same rule at its limit: it holds no lines at all, and counting the element
  // `split` invents for it would let a stale one-line location vote as a readable blank block —
  // two of those outvote the location that still holds the clone and the signal is dropped.
  if (lines[lines.length - 1] === "") lines.pop();

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    let line = raw.trim();
    const next = lines[index + 1]?.trim() ?? "";

    // Inside a heredoc the line is the command's INPUT, not shell syntax — exactly as template and
    // raw-string text is. A payload quoting `function fake(` would otherwise open a parameter list
    // that no `)` closes, and every command past the terminator inherits `signature` and is dropped
    // as a declaration. Read first, since payload text leading with `#` is not a comment either, and
    // matched against the RAW line, since indentation decides whether a heredoc ends.
    if (heredocs.length > 0) {
      if (endsHeredoc(raw, heredocs[0])) heredocs.shift();
      classes.push("code");
      continue;
    }

    if (commentDepth > 0) {
      const walked = insideBlockComment(line, commentDepth, opts.nestedComments);
      commentDepth = walked.depth;
      if (commentDepth > 0) {
        classes.push("comment");
        continue;
      }
      line = walked.rest.trim();
      if (line === "") {
        classes.push("comment");
        continue;
      }
    }
    // Inside a string a backslash carried onto this line, the line is that string's TEXT — the same
    // rule the template and raw-string states follow, for the one multiline form an ORDINARY quote
    // has. Read before the comment and blank tests, since a continuation line starting with `//` is
    // not prose.
    if (quoted) {
      const masked = maskContinuedQuote(line, quoted);
      quoted = masked.open;
      line = masked.text.trim();
      if (quoted || line === "") {
        classes.push("code");
        continue;
      }
    }
    // Inside an open raw string the line is raw text, exactly as template and docstring text are:
    // an embedded snippet declares nothing and its delimiters are not syntax. Read before the
    // template, comment and blank tests, since a line of raw text starting with `//` is not prose.
    if (rawString !== undefined) {
      const masked = maskRawString(line, rawString);
      rawString = masked.open;
      line = masked.text.trim();
      if (rawString !== undefined || line === "") {
        classes.push("code");
        continue;
      }
    }
    // Inside an open template the line is raw text: it declares nothing and its delimiters are not
    // syntax, so it never reaches the delta counters and votes as code — the side that keeps the
    // signal. Read before the comment and blank tests, since a line of template text that happens
    // to start with `//` is not prose.
    if (template.length > 0) {
      const masked = maskTemplate(line, template);
      template = masked.stack;
      line = masked.text.trim();
      if (template.length > 0 || line === "") {
        classes.push("code");
        continue;
      }
    }
    // Inside an open triple-quoted string the line is raw text, exactly as template text is: a
    // docstring's prose declares nothing and its delimiters are not syntax. Read before the comment
    // and blank tests, since a docstring line starting with `#` is not a comment.
    if (tripleQuote) {
      const masked = maskTripleQuoted(line, tripleQuote, tripleQuotes, opts.hashComments);
      tripleQuote = masked.open;
      line = masked.text.trim();
      if (tripleQuote || line === "") {
        classes.push("code");
        continue;
      }
    }
    if (line === "") {
      classes.push("blank");
      continue;
    }
    // A leading `*` is NOT read as comment text here: every line of a block comment is already
    // claimed by the `inComment` branch above, so outside one it is a multiplication continuation.
    if ((slashComments && line.startsWith("//")) || (opts.hashComments && line.startsWith("#"))) {
      classes.push("comment");
      continue;
    }
    if (blockComments && line.startsWith("/*")) {
      const opened = afterBlockComment(line, opts.nestedComments);
      if (opened.depth > 0) {
        classes.push("comment");
        commentDepth = opened.depth;
        continue;
      }
      if (opened.rest === "") {
        classes.push("comment");
        continue;
      }
      // The comment closed and something followed it: that suffix is what the line does.
      line = opened.rest;
    }

    // A raw string this line OPENS and does not close — `let query = r#"` over an embedded
    // snippet. Blanked ahead of the template masker, because a raw string holds ANY text: a
    // backtick inside one would otherwise open a template that runs past the string's own close.
    if (opts.rawStrings) {
      const masked = maskRawString(line, undefined);
      if (masked.open !== undefined) {
        rawString = masked.open;
        line = masked.text.trim();
      }
    }

    // A docstring, a text block or a multiline constant this line OPENS: blank its text now, so the
    // delimiters inside it never reach the import and signature classifiers below. Ahead of the
    // template masker for the same reason the raw string is: the text holds ANY character, and a
    // backtick inside one would otherwise open a template that runs past the string's own close.
    if (tripleQuotes.length > 0) {
      const masked = maskTripleQuoted(line, undefined, tripleQuotes, opts.hashComments);
      if (masked.open) {
        tripleQuote = masked.open;
        line = masked.text.trim();
      }
    }

    // A template this line OPENS and does not close: blank its text now, so the delimiters inside it
    // never reach `parenDelta`. One that closes on its own line is left as written — `stripNoise`
    // masks it wherever a delta is counted, and the raw text is what the import patterns read.
    if (templates) {
      const masked = maskTemplate(line, template);
      if (masked.stack.length > 0) {
        template = masked.stack;
        line = masked.text.trim();
      }
    }

    // A block comment can open ANYWHERE on a line — `value: string, /* why` — not only at its
    // start. What precedes the opener is still what the line does; everything after it is prose the
    // lines below inherit, so the state has to be raised here or their delimiters count as syntax.
    if (blockComments) {
      const { opener, depth: opened } = unclosedBlockComment(
        line,
        opts.nestedComments,
        opts.jsx,
        braces,
      );
      if (opener >= 0) {
        commentDepth = opened;
        line = line.slice(0, opener).trim();
        if (line === "") {
          classes.push("comment");
          continue;
        }
      }
    }

    // The same for a `#` note, which trails code as readily as it leads a line — `)  # keep {
    // documented`. Cut here, before any delta is counted, so the prose after the marker cannot hold
    // a wrapped import open over the executable lines below it.
    if (opts.hashComments) line = withoutHashComment(line, opts.spacedHash);

    // A quoted string this line leaves open behind a backslash: blank it from the opener on, so
    // neither its text nor the delimiters inside it reach the classifiers below — what precedes the
    // quote is still what the line does. Cut here, after the comment markers, since a quote inside a
    // note opens nothing.
    const continued = continuedQuote(line, slashComments, opts.jsx, braces);
    if (continued) {
      quoted = continued.quote;
      line = `${line.slice(0, continued.opener)}""`.trim();
    }

    // A heredoc this line opens: its payload starts on the NEXT line, so the opener itself still
    // classifies as the command it is. Read after the `#` cut, so one quoted in a note opens
    // nothing.
    if (opts.heredocs) heredocs.push(...heredocDelimiters(line));

    // Fold this line's braces in once every masker has run, so only real syntax is counted — and
    // AFTER the two scanners above read the stack, which must describe the lines above this one.
    trackBraces(braces, line);

    if (statement) {
      if (statement === "signature") {
        // The parameter list, however it is spelled — a destructured props object, its inline type
        // annotation, one name per line. None of it computes anything, unless it defaults — or
        // unless the line that closes the list carries the arrow body with it.
        // Closure is read off the tail, never off the line's net paren depth: an expression body
        // that opens a call on the same line (`) => combine(`) leaves the net positive while the
        // parameter list has plainly ended, and the calls below it would inherit `signature`.
        const tail = closingTail(line, depth);
        if (tail === undefined) depth += parenDelta(line);
        // The paren closed: settle what it was. An arrow's `=>` cannot be pushed to the next line —
        // the grammar forbids the break — so its absence here proves the construct was a
        // parenthesized EXPRESSION, and every line it swallowed (`computeA(),`) runs. Hand them back
        // as code rather than letting a window of calls read as a declaration.
        if (tail !== undefined && arrow === "owed") {
          arrow = hasDeclarationArrow(tail) ? "settled" : "absent";
          if (arrow === "absent") {
            for (let i = signatureStart; i < classes.length; i += 1) {
              if (classes[i] === "signature") classes[i] = "code";
            }
          }
        }
        // An `absent` arrow means the construct was a parenthesized expression, never a function, so
        // its closing line runs as ordinary code rather than carrying a declaration's body.
        const carriesBody = arrow !== "absent" && tail !== undefined && hasInlineBody(tail);
        const computes = arrow === "absent" || hasParameterDefault(line);
        classes.push(carriesBody ? "body" : computes ? "code" : "signature");
        if (tail !== undefined) {
          statement = undefined;
          depth = 0;
        }
        continue;
      }
      const runs = statement === "import" && (sideEffect || BLANK_IMPORT_SPEC.test(line));
      classes.push(runs ? "code" : statement);
      depth += braceDelta(line);
      if (!continues(statement, line, depth, next)) {
        statement = undefined;
        sideEffect = false;
        depth = 0;
      }
      continue;
    }

    if (STRUCTURAL_LINE.test(line)) {
      classes.push("structural");
      continue;
    }
    if (opts.bindingDeclarations && BARE_DECLARATION.test(line)) {
      classes.push("declaration");
      continue;
    }

    const declared = opts.functionHeaders && FUNCTION_START.test(line);
    if (declared || (opts.functionHeaders && ARROW_START.test(line))) {
      const open = parenDelta(line);
      // Only a header whose parameter list runs on is a declaration BLOCK; one that closes on its
      // own line is a single line of real code and is counted as such — as is one that defaults.
      classes.push(open > 0 && !headerHasParameterDefault(line) ? "signature" : "code");
      if (open > 0) {
        statement = "signature";
        // `function foo(` names a function whatever follows; `const foo = (` still owes an arrow.
        arrow = declared ? "settled" : "owed";
        signatureStart = index;
        depth = open;
      }
      continue;
    }

    if (sideEffectImport.test(line)) {
      classes.push("code");
      continue;
    }
    if (SIDE_EFFECT_IMPORT_OPEN.test(line)) {
      classes.push("code");
      depth = braceDelta(line);
      if (continues("import", line, depth, next)) {
        statement = "import";
        sideEffect = true;
      } else depth = 0;
      continue;
    }

    const kind =
      opts.importDeclarations && (IMPORT_START.test(line) || FROM_IMPORT_START.test(line))
        ? "import"
        : opts.typeDeclarations && TYPE_START.test(line)
          ? "type"
          : "code";
    classes.push(kind);
    if (kind === "code") continue;
    depth = braceDelta(line);
    // A statement that closes on its own line opens nothing; otherwise its continuation lines
    // inherit the same class until it terminates.
    if (continues(kind, line, depth, next)) statement = kind;
    else depth = 0;
  }
  return classes;
}

/** The locations stringer listed in its description, falling back to the signal's own file:line. */
function parseLocations(signal: ScanSignal): Location[] {
  const description = signal.Description ?? signal.description ?? "";
  const found: Location[] = [];
  const seen = new Set<string>();
  for (const match of description.matchAll(/^\s*-\s+(.+):(\d+)\s*$/gm)) {
    const key = `${match[1]}:${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ path: match[1], line: Number(match[2]) });
  }
  if (found.length > 0) return found;

  const path = filePathOf(signal);
  const line = Number(signal.Line ?? signal.line);
  return path && Number.isInteger(line) && line > 0 ? [{ path, line }] : [];
}

/** How many lines the reported block spans; undefined when stringer's title didn't say. */
function blockLines(signal: ScanSignal): number | undefined {
  const title = titleOf(signal);
  const match = /\((\d+) lines?/.exec(title);
  if (!match) return undefined;
  const lines = Number(match[1]);
  return lines > 0 ? lines : undefined;
}

function filePathOf(signal: ScanSignal): string | undefined {
  const raw = signal.FilePath ?? signal.filePath;
  return typeof raw === "string" && raw ? raw : undefined;
}

function titleOf(signal: ScanSignal): string {
  const raw = signal.Title ?? signal.title;
  return typeof raw === "string" ? raw : "";
}

function kindOf(signal: ScanSignal): string {
  const raw = signal.Kind ?? signal.kind;
  return typeof raw === "string" && raw ? raw : DUPLICATION_COLLECTOR;
}

/** A repo-relative path that stays inside the repo; undefined for anything that escapes it. */
function insideRepo(repoPath: string, raw: string): string | undefined {
  const rel = isAbsolute(raw) ? relative(repoPath, raw) : normalize(raw);
  return rel && rel !== "." && rel !== ".." && !rel.startsWith(`..${sep}`) ? rel : undefined;
}

/** What a source file looks like line by line, or why anton couldn't say. */
type FileLines =
  | { status: "read"; lines: LineClass[] }
  | { status: "missing" }
  | { status: "unreadable" }
  | { status: "budget" };

/**
 * The errno codes that mean the file is not on the tree. Every other read failure — `EACCES`,
 * `EMFILE`, a flaky filesystem — proves nothing about the block, so it must not be read as absence:
 * a signal whose locations all hit one would otherwise be dropped as rewritten away.
 */
const MISSING_FILE_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

function isMissingFile(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && MISSING_FILE_CODES.has(code);
}

/** Line classifications for one repo, read once per file and shared across every signal. */
function sourceIndex(repoPath: string) {
  const cache = new Map<string, FileLines>();
  let read = 0;

  return async function linesOf(path: string): Promise<FileLines> {
    const rel = insideRepo(repoPath, path);
    // Keyed on the RESOLVED path, not the spelling a signal used: `src/a.ts` and `./src/a.ts` are
    // one file, and keying on the raw string reads it twice and spends two FILE_BUDGET slots on it.
    // A path that escapes the repo has no resolved form, so its own spelling is the key there.
    const key = rel ?? path;
    const cached = cache.get(key);
    if (cached) return cached;
    if (!rel) {
      cache.set(key, { status: "missing" });
      return { status: "missing" };
    }
    if (read >= FILE_BUDGET) return { status: "budget" };
    read += 1;
    let source: string;
    try {
      source = await readFile(join(repoPath, rel), "utf8");
    } catch (error) {
      const failed: FileLines = isMissingFile(error)
        ? { status: "missing" }
        : { status: "unreadable" };
      cache.set(key, failed);
      return failed;
    }
    const result: FileLines = {
      status: "read",
      lines: classifyLines(source, {
        hashComments: HASH_COMMENT_EXTENSIONS.some((ext) => rel.endsWith(ext)),
        spacedHash: SPACED_HASH_EXTENSIONS.some((ext) => rel.endsWith(ext)),
        slashComments: SLASH_COMMENT_EXTENSIONS.some((ext) => rel.endsWith(ext)),
        tripleQuotes: TRIPLE_QUOTE_EXTENSIONS.some((ext) => rel.endsWith(ext))
          ? TRIPLE_QUOTES
          : DOUBLE_TRIPLE_QUOTE_EXTENSIONS.some((ext) => rel.endsWith(ext))
            ? DOUBLE_TRIPLE_QUOTES
            : undefined,
        heredocs: HEREDOC_EXTENSIONS.some((ext) => rel.endsWith(ext)),
        nestedComments: NESTED_COMMENT_EXTENSIONS.some((ext) => rel.endsWith(ext)),
        boundBareImport: BOUND_BARE_IMPORT_EXTENSIONS.some((ext) => rel.endsWith(ext)),
        rawStrings: RAW_STRING_EXTENSIONS.some((ext) => rel.endsWith(ext)),
        importDeclarations: IMPORT_DECLARATION_EXTENSIONS.some((ext) => rel.endsWith(ext)),
        typeDeclarations: TYPE_DECLARATION_EXTENSIONS.some((ext) => rel.endsWith(ext)),
        bindingDeclarations: BINDING_DECLARATION_EXTENSIONS.some((ext) => rel.endsWith(ext)),
        functionHeaders: FUNCTION_HEADER_EXTENSIONS.some((ext) => rel.endsWith(ext)),
        jsx: JSX_EXTENSIONS.some((ext) => rel.endsWith(ext)),
      }),
    };
    cache.set(key, result);
    return result;
  };
}

type Index = ReturnType<typeof sourceIndex>;

/** What one reported window turned out to hold. */
type Window =
  | { status: "gone" }
  | { status: "unreadable" }
  | { status: "block"; classes: LineClass[] };

async function readWindow(index: Index, loc: Location, lines: number): Promise<Window> {
  const file = await index(loc.path);
  if (file.status === "budget" || file.status === "unreadable") return { status: "unreadable" };
  if (file.status === "missing") return { status: "gone" };
  const start = loc.line - 1;
  // The tree must still hold the WHOLE window for the location to have a vote. One that starts past
  // the end is plainly gone; one that runs off the end is a remnant of a file rewritten shorter, and
  // letting the surviving lines vote would let two truncated comment tails outvote a location that
  // still holds the real clone.
  if (start < 0 || start + lines > file.lines.length) return { status: "gone" };
  return { status: "block", classes: file.lines.slice(start, start + lines) };
}

/** The block's make-up, phrased the way an operator would check it: "5 comment, 1 blank". */
function describeBlock(classes: LineClass[]): string {
  const counts = new Map<LineClass, number>();
  for (const cls of classes) counts.set(cls, (counts.get(cls) ?? 0) + 1);
  return (
    [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([cls, count]) => `${count} ${cls}`)
      .join(", ") || "nothing"
  );
}

/**
 * The window whose make-up the drop is described by: the composition the MOST locations share, the
 * first of them on a tie. A clone family normally classifies alike, but where one instance is the
 * odd one out — "4 signature, 1 comment" among five plain "6 comment" blocks — quoting the first
 * location describes the drop by its exception, and the operator checking the reason finds
 * something other than what the verdict was reached on.
 */
function typicalBlock(blocks: LineClass[][]): LineClass[] {
  const shared = new Map<string, number>();
  for (const block of blocks) {
    const key = describeBlock(block);
    shared.set(key, (shared.get(key) ?? 0) + 1);
  }
  const shareOf = (block: LineClass[]) => shared.get(describeBlock(block)) ?? 0;
  return blocks.reduce((best, block) => (shareOf(block) > shareOf(best) ? block : best));
}

/**
 * Whether the window shows a parameter list AND the braced body it opens — the multiline spelling of
 * what a `body` line proves on one line. `) {` opens a body that runs on the lines below it, and
 * those read as ordinary `code`, so without this the parameter lines above them outvote the very
 * function they belong to.
 *
 * A `code` line INSIDE the list is a parameter DEFAULT and must not count: the line that closes the
 * list always follows it and is itself a `signature`, so only a statement past the LAST signature
 * line is body.
 */
function holdsBracedBody(classes: LineClass[]): boolean {
  const closing = classes.lastIndexOf("signature");
  return closing >= 0 && classes.lastIndexOf("code") > closing;
}

/**
 * Whether one window is code at all. `blank` and `structural` lines count for neither side — a
 * closing brace is as at home in a clone of real logic as in a clone of an interface — so the
 * question is whether the block's CONTENT lines do work or merely declare. A tie goes to the
 * signal: a block half statements is a block triage can still act on.
 *
 * A window with NO content line at all — nothing but blanks and closers — is not code either, and
 * is reported in those terms rather than as a block that declares.
 *
 * The majority is overridden by the function's body, however the source spells it: a `body` line
 * carries it on the line that closes the parameter list, and a braced body carries it in the
 * statements BELOW that line. Either way the window holds a duplicated FUNCTION, parameter list and
 * all, however many parameter lines precede it — real duplicated computation an operator can
 * extract. That is not the case a stray literal default makes (`budgetAware = false`, which
 * computes nothing), so the override is tied to a body rather than to any `code` line at all.
 */
function isCodeBlock(classes: LineClass[]): boolean {
  if (classes.includes("body") || holdsBracedBody(classes)) return true;
  const code = classes.filter((cls) => cls === "code").length;
  const declarative = classes.filter((cls) => DECLARATIVE.has(cls)).length;
  return code > 0 && code >= declarative;
}

/** Nothing but blanks and closers: the window neither declares nor computes — it says nothing. */
function isEmptyBlock(classes: LineClass[]): boolean {
  return classes.every((cls) => cls === "blank" || cls === "structural");
}

/** A verdict on one signal: keep it, or drop it with the proof. */
type Verdict = { drop: false } | { drop: true; reason: string };

const KEEP: Verdict = { drop: false };

/**
 * Read EVERY location the signal reported and let them vote. A clone family repeats the same text,
 * so its instances classify alike and the vote is normally unanimous; where it isn't, the majority
 * decides and a tie keeps the signal — the same bias the rest of this filter runs on.
 *
 * A location the tree no longer has proves nothing on its own and simply doesn't vote. A signal
 * where NONE of them resolve is about a block that has already been rewritten away: triage cannot
 * read it, cannot act on it, and cannot even check what it claimed, so it goes the same way.
 */
async function judge(index: Index, signal: ScanSignal): Promise<Verdict> {
  const lines = blockLines(signal);
  if (lines === undefined) return KEEP; // stringer phrased its block size in a way anton can't read
  const locations = parseLocations(signal);
  if (locations.length === 0) return KEEP;

  let code = 0;
  const declarative: LineClass[][] = [];
  for (const loc of locations) {
    const window = await readWindow(index, loc, lines);
    if (window.status === "unreadable") return KEEP; // never read — not proven, so not dropped
    if (window.status === "gone") continue;
    if (isCodeBlock(window.classes)) code += 1;
    else declarative.push(window.classes);
  }

  const readable = code + declarative.length;
  if (readable === 0) {
    return {
      drop: true,
      reason:
        `none of its ${locations.length} reported location(s) exist on the tree anymore ` +
        `(${locations[0].path}:${locations[0].line}${locations.length > 1 ? ", …" : ""})`,
    };
  }
  if (declarative.length <= code) return KEEP;
  // Two different diagnoses for the operator reading the drop: a block that declares, and a block
  // that holds no content line to declare with.
  const sample = typicalBlock(declarative);
  const verdict = isEmptyBlock(sample)
    ? "holds nothing but blank and structural lines"
    : "declares rather than computes";
  return {
    drop: true,
    reason:
      `its ${lines}-line block ${verdict} at ${declarative.length} of ` +
      `${readable} readable location(s) — ${describeBlock(sample)}`,
  };
}

/**
 * Drop the duplication signals that describe no code, and say which. Runs BEFORE annotation, in
 * lib/stringer's one filter seam, so the health record's per-severity counts and the triage prompt
 * describe the same set.
 *
 * Only reached when a scan actually carries a duplication signal, so an ordinary pass reads no files.
 */
export async function filterDuplicationSignals(
  repoPath: string,
  signals: ScanSignal[],
): Promise<{ kept: ScanSignal[]; duplication: DuplicationFilter }> {
  const relevant = signals.filter((signal) => collectorOf(signal) === DUPLICATION_COLLECTOR);
  if (relevant.length === 0) return { kept: signals, duplication: { dropped: [] } };

  const index = sourceIndex(repoPath);
  const verdicts = new Map<ScanSignal, string>();
  for (const signal of relevant) {
    const verdict = await judge(index, signal);
    if (verdict.drop) verdicts.set(signal, verdict.reason);
  }

  const dropped: DroppedDuplication[] = [];
  const kept = signals.filter((signal) => {
    const reason = verdicts.get(signal);
    if (reason === undefined) return true;
    dropped.push({ path: filePathOf(signal) ?? "", kind: kindOf(signal), reason });
    return false;
  });
  return { kept, duplication: { dropped } };
}

/**
 * What the non-code filter did, for the session log; undefined when it changed nothing.
 *
 * A silent filter is indistinguishable from a collector that found nothing, and this one can remove
 * most of a scan: the count comes first so the size of the drop is the first thing read, and each
 * reason names the window so "a repeated JSDoc paragraph" stays distinguishable from "anton stopped
 * reporting real clones" without re-running the scan.
 */
export function describeDuplicationFilter(filter: DuplicationFilter): string | undefined {
  if (filter.dropped.length === 0) return undefined;
  const shown = filter.dropped.slice(0, 10);
  const rest = filter.dropped.length - shown.length;
  return (
    `dropped ${filter.dropped.length} duplication signal(s) over non-code blocks: ` +
    `${shown.map((d) => `${d.path} (${d.kind} — ${d.reason})`).join("; ")}` +
    `${rest > 0 ? ` (+${rest} more)` : ""}`
  );
}
