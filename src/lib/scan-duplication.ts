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

/** Languages where `#` starts a comment. In TS/JS a leading `#` is a private class field — code. */
const HASH_COMMENT_EXTENSIONS = [".py", ".sh", ".bash", ".zsh", ".rb", ".yaml", ".yml", ".toml"];

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
 */
const IMPORT_START =
  /^import\b(?!\(|\s*(?:\(\s*\S|\.))|^export\s+(?:type\s+)?[{*]|^export\b[^;]*\bfrom\s*["']/;

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
 * Go spells the same intent `import _ "net/http/pprof"`: the blank name exists precisely to run the
 * package's `init()` and bind nothing. A named alias (`import fmt2 "fmt"`) binds and stays a
 * declaration. Go's raw-string spelling of the path (`` import _ `net/http/pprof` ``) is the same
 * statement, so the delimiter is matched as a pair rather than assumed to be a quote.
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
  /^import\s+(?:_\s+)?(["'`])[^"'`]+\1(?:\s+(?:with|assert)\s*\{[^{}]*\})?\s*;?\s*(?:\/\/.*|\/\*.*)?$/;

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

/** `let repo: string;` — a binding with no initializer runs nothing at all. */
const BARE_DECLARATION = /^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=;]+)?;$/;

/**
 * A regex literal, and only where a `/` can BEGIN one: at the start of a line, or after an opener,
 * a separator, an operator or `return`. After a value — `)`, `]`, an identifier — the same `/`
 * divides, and blanking `a / b(c) / d` would eat the parens it spans. The prefix is captured rather
 * than looked behind so the scan resumes after it, and the body admits an escape or a character
 * class so `/[/]/` and `/\(/` both close where they actually close.
 *
 * Without this a parameter default like `pattern = /\(/` leaves an unmatched `(` for `parenDelta`
 * to count, the signature never closes on its real `)`, and every statement below it reads as more
 * parameter list — turning a genuine clone of runtime work into a declaration and dropping it.
 */
const REGEX_LITERAL =
  /(^|=>|[([{,;:=!&|?]|\breturn|\bcase|\btypeof)(\s*)\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\[])+\/[dgimsuvy]*/g;

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
 */
function continues(
  kind: "import" | "type",
  line: string,
  depth: number,
  next: string,
): boolean {
  if (depth > 0) return true;
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
 * What is left of a line once the block comments it OPENS are stripped — `""` when the line is
 * nothing but comment, `undefined` when the comment runs past it. A line that closes its comment
 * and then calls something still executes, so the suffix is classified rather than read as prose.
 */
function afterBlockComment(line: string): string | undefined {
  let rest = line;
  while (rest.startsWith("/*")) {
    const close = rest.indexOf("*/", 2);
    if (close < 0) return undefined;
    rest = rest.slice(close + 2).trim();
  }
  return rest;
}

/**
 * Where a block comment OPENS on this line and is never closed on it — `value: string, /* why`.
 * Quoted strings, templates and `//` notes are stepped over, so a `/*` inside any of them opens
 * nothing, and a comment that closes is skipped past so a later opener is still found. `-1` when
 * the line leaves no comment running.
 *
 * Without it the prose below such a line is read as syntax: an unmatched `(` inside the comment
 * holds `statement` in `signature` or `import` past the real declaration, and every executable
 * window under it classifies as declarative and is dropped unread.
 */
function unclosedBlockComment(line: string): number {
  let i = 0;
  while (i < line.length) {
    const char = line[i];
    if (char === "'" || char === '"' || char === "`") {
      i = afterQuoted(line, i);
      continue;
    }
    if (char === "/" && line[i + 1] === "/") return -1;
    if (char === "/" && line[i + 1] === "*") {
      const close = line.indexOf("*/", i + 2);
      if (close < 0) return i;
      i = close + 2;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * Classify every line of a file in one forward pass. Whole-file, not just the reported window,
 * because the state that decides what a line IS — inside a block comment, inside a wrapped import,
 * inside an interface body — is only knowable from the lines above it. A bare `readFile,` is an
 * import specifier or a function call depending entirely on what opened above it.
 */
function classifyLines(source: string, opts: { hashComments: boolean }): LineClass[] {
  const classes: LineClass[] = [];
  let inComment = false;
  // Backticks delimit a multiline literal only where the language has one — JS/TS and Go. In a
  // `#`-comment language the same character is shell substitution or prose, so it opens nothing.
  const templates = !opts.hashComments;
  // Same boundary for `/* … */`: in a `#`-comment language a `/*` is a path or a glob (`rm /tmp/*`),
  // and reading it as a comment opener would swallow the rest of the file.
  const blockComments = !opts.hashComments;
  // Empty outside a template; the frames of one it is inside, outermost first.
  let template: TemplateFrame[] = [];
  let depth = 0;
  let statement: "import" | "type" | "signature" | undefined;
  // Where the open signature started, and whether its arrow is still owed. `const x = (` reads as a
  // parameter list until the closing paren says otherwise, so the lines it claimed must be
  // reachable to hand back when no `=>` arrives.
  let signatureStart = 0;
  let arrow: "owed" | "settled" | "absent" = "settled";

  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index].trim();
    const next = lines[index + 1]?.trim() ?? "";

    if (inComment) {
      const close = line.indexOf("*/");
      if (close < 0) {
        classes.push("comment");
        continue;
      }
      inComment = false;
      line = line.slice(close + 2).trim();
      if (line === "") {
        classes.push("comment");
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
    if (line === "") {
      classes.push("blank");
      continue;
    }
    // A leading `*` is NOT read as comment text here: every line of a block comment is already
    // claimed by the `inComment` branch above, so outside one it is a multiplication continuation.
    if (line.startsWith("//") || (opts.hashComments && line.startsWith("#"))) {
      classes.push("comment");
      continue;
    }
    if (line.startsWith("/*")) {
      const rest = afterBlockComment(line);
      if (rest === undefined) {
        classes.push("comment");
        inComment = true;
        continue;
      }
      if (rest === "") {
        classes.push("comment");
        continue;
      }
      // The comment closed and something followed it: that suffix is what the line does.
      line = rest;
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
      const opener = unclosedBlockComment(line);
      if (opener >= 0) {
        inComment = true;
        line = line.slice(0, opener).trim();
        if (line === "") {
          classes.push("comment");
          continue;
        }
      }
    }

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
      classes.push(statement === "import" && BLANK_IMPORT_SPEC.test(line) ? "code" : statement);
      depth += braceDelta(line);
      if (!continues(statement, line, depth, next)) {
        statement = undefined;
        depth = 0;
      }
      continue;
    }

    if (STRUCTURAL_LINE.test(line)) {
      classes.push("structural");
      continue;
    }
    if (BARE_DECLARATION.test(line)) {
      classes.push("declaration");
      continue;
    }

    const declared = FUNCTION_START.test(line);
    if (declared || ARROW_START.test(line)) {
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

    if (SIDE_EFFECT_IMPORT.test(line)) {
      classes.push("code");
      continue;
    }

    const kind =
      IMPORT_START.test(line) || FROM_IMPORT_START.test(line)
        ? "import"
        : TYPE_START.test(line)
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
    const cached = cache.get(path);
    if (cached) return cached;
    const rel = insideRepo(repoPath, path);
    if (!rel) {
      cache.set(path, { status: "missing" });
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
      cache.set(path, failed);
      return failed;
    }
    const result: FileLines = {
      status: "read",
      lines: classifyLines(source, {
        hashComments: HASH_COMMENT_EXTENSIONS.some((ext) => rel.endsWith(ext)),
      }),
    };
    cache.set(path, result);
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
  const sample = declarative[0];
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
