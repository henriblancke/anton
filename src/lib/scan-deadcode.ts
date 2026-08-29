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
 * `node_modules` or a build dir. Grep sees text, so hits are read line by line and prose is
 * discounted — a name in a comment or a doc is being described, not called, and this module's own
 * docblock would otherwise keep the symbols it names alive forever. Conservative in the direction
 * that matters — a tree anton cannot search drops nothing, so an unsearchable repo over-reports
 * rather than deleting a finding nobody hears about again.
 */
import { execFile } from "node:child_process";
import { isAbsolute, normalize, relative, sep } from "node:path";
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
 * A line that opens with a comment marker in the languages stringer collects. Only the start of the
 * trimmed line is checked: a trailing `// note` on a real statement still counts, which errs toward
 * keeping a signal anton cannot disprove.
 */
const COMMENT_LINE = /^(?:\/\/|\/\*|\*\/|\*|#|--|;|%|<!--|"""|''')/;

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

/**
 * The files holding at least one hit that reads as code. `git grep -n -z` writes one record per
 * hit as `path\0line\0text\n`, so a file is judged by its hits rather than by appearing in a
 * filename list.
 *
 * Comment lines and documentation files are discounted because a name written in prose is not a
 * reference. A name inside a string literal or a same-named local declaration still counts: grep
 * cannot tell those from a call, and only a parser could.
 */
function referencingFiles(stdout: string): string[] {
  const files = new Set<string>();
  for (const record of stdout.split("\n")) {
    const pathEnd = record.indexOf("\0");
    if (pathEnd < 0) continue;
    const textStart = record.indexOf("\0", pathEnd + 1);
    if (textStart < 0) continue;
    const file = normalize(record.slice(0, pathEnd));
    if (files.has(file) || PROSE_FILE.test(file)) continue;
    if (COMMENT_LINE.test(record.slice(textStart + 1).trimStart())) continue;
    files.add(file);
  }
  return [...files];
}

/**
 * Every file that references the symbol as a whole word — tracked files plus anything new that
 * isn't ignored, since a caller written today is a caller. `-F`/`-w` so a symbol carrying regex
 * punctuation (`$mount`) matches itself rather than a pattern, `-z` so a non-ASCII path comes back
 * unquoted under `core.quotePath`, `-I` so a binary blob is never read as a call site.
 */
async function filesMentioning(
  repoPath: string,
  symbol: string,
): Promise<string[] | { unavailable: string }> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "grep", "-n", "-I", "-w", "-F", "-z", "--untracked", "-e", symbol],
      { timeout: GREP_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
    );
    return referencingFiles(stdout);
  } catch (err) {
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
 * phantoms.
 *
 * Only reached when a scan actually carries a deadcode signal, so an ordinary pass runs no git.
 */
export async function filterDeadcodeSignals(
  repoPath: string,
  signals: ScanSignal[],
): Promise<{ kept: ScanSignal[]; deadcode: DeadcodeFilter }> {
  const relevant = signals.filter((signal) => collectorOf(signal) === DEADCODE_COLLECTOR);
  if (relevant.length === 0) return { kept: signals, deadcode: { dropped: [] } };

  const seen = new Map<string, string[]>();
  const verdicts = new Map<ScanSignal, string>();
  let unavailable: string | undefined;

  for (const signal of relevant) {
    if (unavailable) break;
    const symbol = symbolOf(signal);
    const path = filePathOf(repoPath, signal);
    // No symbol or no file is nothing anton can check: a mention count needs both a name to look
    // for and the declaration to discount.
    if (!symbol || !path) continue;

    let files = seen.get(symbol);
    if (!files) {
      if (seen.size >= SYMBOL_BUDGET) break;
      const found = await filesMentioning(repoPath, symbol);
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
