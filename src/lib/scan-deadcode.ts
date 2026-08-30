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
 * not silently dropped.
 */
const SYMBOL_BUDGET = 200;

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
 */
const PROSE_FILE = /\.(?:md|mdx|markdown|txt|rst|adoc|org)$/i;

/**
 * A line opening with a comment marker in *some* language, for a file whose language anton has no
 * grammar for below. It is the union across languages, so a marker one language doesn't share is
 * still read as prose — `;` is a Lisp comment and an ASI guard, and without knowing the file this
 * has to assume the reading that keeps a signal anton cannot disprove. Only the start of the
 * trimmed line is checked, for the same reason.
 */
const COMMENT_LINE = /^(?:\/\/|\/\*|\*\/|\*|#|--|;|%|<!--|"""|''')/;

interface CommentSyntax {
  files: RegExp;
  /** Markers that comment out the rest of their line. */
  line: string[];
  /** Delimiter pairs that span lines, opener then closer. */
  block: [string, string][];
  /** Whether an opener met inside an open block nests rather than reading as ordinary text. */
  nested?: boolean;
}

/**
 * Comment grammar by file kind. Judging a hit by how its line begins gets both ends wrong: the
 * middle of a block carries no marker of its own, so `neverCalled was removed later` reads as a
 * call, while a legitimate `;neverCalled()` reads as a Lisp comment. Knowing the language lets a
 * hit be judged where it actually sits. Only the grammars stringer's collectors meet are tracked;
 * a language without one falls back to the union line test above.
 */
const COMMENT_SYNTAX: CommentSyntax[] = [
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
    files: /\.(?:py|pyi)$/i,
    line: ["#"],
    block: [
      ['"""', '"""'],
      ["'''", "'''"],
    ],
  },
  {
    files: /\.(?:rb|sh|bash|zsh|ya?ml|toml)$/i,
    line: ["#"],
    block: [],
  },
];

/** The grammar to read a file with, or undefined when anton tracks none for its language. */
function commentSyntaxOf(file: string): CommentSyntax | undefined {
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
    const at = line.indexOf(opener, from);
    if (at >= 0 && (!found || at < found.at)) found = { at, marker: opener, closer };
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
): { at: number; closed: boolean } {
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
        const { at: end, closed } = closeBlock(line, at, open, syntax.nested === true);
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

/** Word characters as `git grep -w` counts them, so this reads a hit the way grep found it. */
const WORD_CHAR = /[0-9A-Za-z_]/;

/** Whether the line still writes the symbol as a whole word once its comments are blanked out. */
function referencesWord(line: string | undefined, symbol: string): boolean {
  if (line === undefined) return false;
  for (let at = line.indexOf(symbol); at >= 0; at = line.indexOf(symbol, at + 1)) {
    const before = at > 0 ? line[at - 1] : "";
    const after = line[at + symbol.length] ?? "";
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
  }
  return false;
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
 * The hits that survive the cheap prose tests, by file. `git grep -n -z` writes one record per hit
 * as `path\0line\0text\n`, so a file is judged by its hits rather than by appearing in a filename
 * list.
 *
 * Documentation files are discounted here without reading anything — a name written in prose is not
 * a reference. So is a line opening with a comment marker, but only in a file whose language anton
 * has no grammar for: the rest are judged against their own text, where a comment opened mid-line
 * and the middle of a block are both visible and `;` is not mistaken for a marker.
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
 * it are blanked out. A file is read only when anton knows its language and it carries a hit, and
 * the masked text is cached across symbols because one busy file answers for many of them.
 *
 * A file anton cannot read proves nothing: without its text there is no evidence the hit is a call,
 * and an unproven caller must not delete a finding.
 */
async function codeReferencingFiles(
  repoPath: string,
  symbol: string,
  hits: CandidateHits,
  masked: Map<string, string[] | undefined>,
): Promise<string[]> {
  const files: string[] = [];
  for (const [file, lines] of hits) {
    const syntax = commentSyntaxOf(file);
    if (!syntax) {
      files.push(file);
      continue;
    }
    if (!masked.has(file)) {
      try {
        const text = await readFile(join(repoPath, file), "utf8");
        masked.set(file, maskComments(text, syntax));
      } catch {
        masked.set(file, undefined);
      }
    }
    const code = masked.get(file);
    if (code && lines.some((line) => referencesWord(code[line - 1], symbol))) files.push(file);
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
  masked: Map<string, string[] | undefined>,
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
    return await codeReferencingFiles(repoPath, symbol, candidateHits(stdout), masked);
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
 * falsifies exactly that. The declaring file is excluded because a symbol always mentions itself
 * there — counting it would drop every signal, which is the one outcome worse than counting
 * phantoms. `opts.exclude` is the scan's own exclusion set, so the search covers the files stringer
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
  const seen = new Map<string, string[]>();
  /** One read per file, however many symbols land in it. */
  const masked = new Map<string, string[] | undefined>();
  const verdicts = new Map<ScanSignal, string>();
  let unavailable: string | undefined;

  for (const signal of relevant) {
    if (unavailable) break;
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
      if (seen.size >= SYMBOL_BUDGET) break;
      const found = await filesMentioning(repoPath, symbol, masked, pathspecs, abort);
      if (!Array.isArray(found)) {
        unavailable = found.unavailable;
        break;
      }
      files = found;
      seen.set(symbol, files);
    }

    const callers = files.filter((file) => file !== path);
    if (callers.length === 0) continue;
    const shown = callers.slice(0, 3);
    const rest = callers.length - shown.length;
    verdicts.set(
      signal,
      `${symbol} is referenced in ${shown.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`,
    );
  }

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
  return { kept, deadcode: { dropped } };
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
  if (filter.dropped.length === 0) return undefined;
  const shown = filter.dropped.slice(0, 10);
  const rest = filter.dropped.length - shown.length;
  return (
    `dropped ${filter.dropped.length} dead-code signal(s) whose symbol has callers elsewhere in ` +
    `the tree: ${shown.map((d) => `${d.path} (${d.kind} — ${d.reason})`).join("; ")}` +
    `${rest > 0 ? ` (+${rest} more)` : ""}`
  );
}
