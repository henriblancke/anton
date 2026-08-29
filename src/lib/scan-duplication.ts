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
 * A block size it cannot parse, a file past the read budget, a window whose statements carry the
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
 * What one source line contributes. `code` is the only class that does work; `blank` and
 * `structural` (a lone brace, a JSX closer) are neither — they say nothing about the block either
 * way. Everything between is declaration: prose, an import specifier, a type field, a parameter.
 */
type LineClass =
  | "blank"
  | "structural"
  | "comment"
  | "import"
  | "type"
  | "declaration"
  | "signature"
  | "code";

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

/** `import …`, `export { … } from …`, `export * from …` — the statement's first line. */
const IMPORT_START = /^import\b|^export\s+(?:type\s+)?[{*]|^export\b[^;]*\bfrom\s*["']/;

/** `interface X {`, `type X =`, `enum X {`, with the usual modifiers in front. */
const TYPE_START = /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?(?:interface|type|enum)\s+[A-Za-z_$]/;

/** A `from "…"` clause, which ends an import statement however many lines its bindings took. */
const FROM_CLAUSE = /\bfrom\s*["'][^"']*["']/;

/** `function foo(` / `export async function foo(` — a declaration header, not a call. */
const FUNCTION_START = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/;

/** `const Foo = ({` / `export const f = async (` — the other spelling of the same header. */
const ARROW_START = /^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=]+)?=\s*(?:async\s*)?\(/;

/** `let repo: string;` — a binding with no initializer runs nothing at all. */
const BARE_DECLARATION = /^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=;]+)?;$/;

/**
 * Strip what would confuse brace counting: line comments and string bodies. Crude on purpose — the
 * only thing riding on it is where a multi-line import or type declaration ends, and an unbalanced
 * count there classifies a line as `type`/`import` rather than dropping anything on its own.
 */
function stripNoise(line: string): string {
  return line
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""')
    .replace(/\/\/.*$/, "");
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

/**
 * Classify every line of a file in one forward pass. Whole-file, not just the reported window,
 * because the state that decides what a line IS — inside a block comment, inside a wrapped import,
 * inside an interface body — is only knowable from the lines above it. A bare `readFile,` is an
 * import specifier or a function call depending entirely on what opened above it.
 */
function classifyLines(source: string, opts: { hashComments: boolean }): LineClass[] {
  const classes: LineClass[] = [];
  let inComment = false;
  let depth = 0;
  let statement: "import" | "type" | "signature" | undefined;

  for (const raw of source.split("\n")) {
    const line = raw.trim();

    if (inComment) {
      classes.push("comment");
      if (line.includes("*/")) inComment = false;
      continue;
    }
    if (line === "") {
      classes.push("blank");
      continue;
    }
    if (line.startsWith("//") || line.startsWith("*") || (opts.hashComments && line.startsWith("#"))) {
      classes.push("comment");
      continue;
    }
    if (line.startsWith("/*")) {
      classes.push("comment");
      if (!line.includes("*/")) inComment = true;
      continue;
    }

    if (statement) {
      classes.push(statement);
      if (statement === "signature") {
        // The parameter list, however it is spelled — a destructured props object, its inline type
        // annotation, one name per line. None of it computes anything.
        depth += parenDelta(line);
        if (depth <= 0) {
          statement = undefined;
          depth = 0;
        }
        continue;
      }
      depth += braceDelta(line);
      if (depth <= 0 && (line.endsWith(";") || FROM_CLAUSE.test(line) || line.endsWith("}"))) {
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

    if (FUNCTION_START.test(line) || ARROW_START.test(line)) {
      const open = parenDelta(line);
      // Only a header whose parameter list runs on is a declaration BLOCK; one that closes on its
      // own line is a single line of real code and is counted as such.
      classes.push(open > 0 ? "signature" : "code");
      if (open > 0) {
        statement = "signature";
        depth = open;
      }
      continue;
    }

    const kind = IMPORT_START.test(line) ? "import" : TYPE_START.test(line) ? "type" : "code";
    classes.push(kind);
    if (kind === "code") continue;
    depth = braceDelta(line);
    // A statement that closes on its own line opens nothing; otherwise its continuation lines
    // inherit the same class until the braces balance and it terminates.
    const closed =
      depth <= 0 && (line.endsWith(";") || (kind === "import" && FROM_CLAUSE.test(line)));
    if (!closed) statement = kind;
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
  | { status: "budget" };

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
    const source = await readFile(join(repoPath, rel), "utf8").catch(() => undefined);
    const result: FileLines =
      source === undefined
        ? { status: "missing" }
        : {
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
  if (file.status === "budget") return { status: "unreadable" };
  if (file.status === "missing") return { status: "gone" };
  const start = loc.line - 1;
  // A window that starts past the end of the file is a location the tree no longer has: the file
  // was rewritten under the baseline and the block stringer measured is not there to check.
  if (start < 0 || start >= file.lines.length) return { status: "gone" };
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
 * Whether one window is code at all. `blank` and `structural` lines count for neither side — a
 * closing brace is as at home in a clone of real logic as in a clone of an interface — so the
 * question is whether the block's CONTENT lines do work or merely declare. A tie goes to the
 * signal: a block half statements is a block triage can still act on.
 */
function isCodeBlock(classes: LineClass[]): boolean {
  const code = classes.filter((cls) => cls === "code").length;
  const declarative = classes.filter((cls) => DECLARATIVE.has(cls)).length;
  return code > 0 && code >= declarative;
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
    if (window.status === "unreadable") return KEEP; // out of budget — not proven, so not dropped
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
  return {
    drop: true,
    reason:
      `its ${lines}-line block declares rather than computes at ${declarative.length} of ` +
      `${readable} readable location(s) — ${describeBlock(declarative[0])}`,
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
