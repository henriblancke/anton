/**
 * The single place anton runs `stringer` (anton-3t2.3). stringer mines a repo for actionable
 * signals (TODOs, churn, CVEs, ...) and emits them as JSON; the nightly-stringer job then hands the
 * scan file to claude with the /scan-triage prompt to convert the few worth doing into beads.
 *
 * The binary is injectable (ANTON_STRINGER_BIN) so tests point it at a fake. `--delta` limits a
 * scan to signals new since the last run (stringer keeps its own baseline in the repo), keeping the
 * nightly pass cheap and the board from re-flooding.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { annotateSignal, collectorOf, severityOfSignal, type ScanSignal } from "./scan-severity";
import { filterCouplingSignals, type CouplingFilter } from "./scan-coupling";
import { filterDeadcodeSignals, type DeadcodeFilter } from "./scan-deadcode";
import { filterDuplicationSignals, type DuplicationFilter } from "./scan-duplication";
import { PoisonError } from "./jobs/errors";

const execFileAsync = promisify(execFile);

/** Override the stringer binary (tests point this at a fake that writes a canned scan file). */
export const STRINGER_BIN_ENV = "ANTON_STRINGER_BIN";

/**
 * Per-collector wall-clock budget passed to `--collector-timeout`. A backstop: without it a single
 * collector that walks a huge tree (measured: a Next.js `.next` build dir made the `todos`/`deadcode`
 * collectors run for >10 min) has no deadline, so the whole scan blows the outer execFile timeout and
 * is SIGTERM-killed with zero output. With it, a runaway collector is cut off and the scan still
 * completes with every other collector's results. Collectors run in parallel, so this bounds the
 * whole scan to ~this budget. Override with ANTON_STRINGER_COLLECTOR_TIMEOUT (e.g. "90s", "2m").
 */
const COLLECTOR_TIMEOUT = process.env.ANTON_STRINGER_COLLECTOR_TIMEOUT ?? "60s";

/**
 * Build output, caches, vendored deps, and VCS/tool state -- never worth mining for signals, and the
 * real cost of a scan. Measured on this repo: a Next.js `.next` dir alone yielded 1600+ junk "todos"
 * and took the walk from 0.1s to 22s; leaving heavy build dirs in is what pushes a scan past its
 * timeout. Excluding them keeps the walk on source across ecosystems (node, python, rust, jvm, go...).
 *
 * IMPORTANT: stringer globs are **root-relative** (its own `--help` example is `tests/**`, not
 * `**\/tests/**`) -- a `**\/`-prefixed pattern silently matches nothing. So these target repo-root
 * dirs, which is where build output lives. `node_modules` is already skipped by stringer internally;
 * it's listed anyway as belt-and-suspenders. For nested (monorepo) build dirs, the COLLECTOR_TIMEOUT
 * backstop above guarantees the scan still completes.
 */
export const DEFAULT_SCAN_EXCLUDES = [
  // build / generated output (the measured bottleneck). NB: no "bin/" -- it holds source CLIs in
  // node/script projects (anton's own bin/anton.mjs), so excluding it would drop real source.
  ".next/**", // next.js
  ".nuxt/**", // nuxt
  ".svelte-kit/**", // sveltekit
  ".turbo/**", // turborepo
  "dist/**",
  "build/**",
  "out/**",
  "target/**", // rust, maven / jvm
  ".gradle/**", // gradle
  // dependency / vendor trees
  "node_modules/**", // node (already internally skipped; kept for belt-and-suspenders)
  "vendor/**", // go, php (composer), ruby
  ".venv/**", // python
  "venv/**", // python
  ".bundle/**", // ruby
  // caches / tooling state
  "__pycache__/**", // python
  ".mypy_cache/**",
  ".pytest_cache/**",
  ".tox/**",
  ".cache/**",
  "coverage/**",
  // vcs / agent tool state
  ".git/**",
  ".anton/**",
  ".beads/**",
  // anton's own database, which lives at the repo root of the project it is run FROM. It is
  // gitignored and disposable, but `githygiene` walks the working tree rather than the index and
  // reports it as a multi-megabyte "large binary file" on every single scan of anton's own repo —
  // a finding that is never actionable and that triage pays for nightly. The `*` also covers
  // SQLite's `-wal`/`-shm` sidecars, which are flagged the same way.
  "anton.db*",
  // Claude Code's `isolation: worktree` checks a SECOND copy of the whole tree out at
  // `.claude/worktrees/<name>/`, inside the repo. Walking it double-counts every file: the
  // 2026-08-05 scan spent 118 of its 211 signals reporting src/x as a clone of
  // .claude/worktrees/tier-invariants/src/x, burying the real findings and inflating the health
  // totals against a repo twice its actual size. Excluded whole (like .anton/**) — it is agent
  // state, not source. anton's own run worktrees live OUTSIDE the repo and were never the leak.
  ".claude/**",
];

/**
 * Outer wall-clock deadline for one scan. Override with ANTON_STRINGER_TIMEOUT_MS (tests use a few
 * hundred ms). Read per call so an override lands without a module reload.
 */
function scanTimeoutMs(): number {
  const raw = Number(process.env.ANTON_STRINGER_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60_000;
}

/**
 * Render a deadline an operator can act on: the number must be traceable back to the configured
 * ANTON_STRINGER_TIMEOUT_MS, so only exact whole minutes collapse to "m" -- rounding 90_000ms to
 * "2m" would send someone looking for a timeout that isn't set anywhere. Exported for tests.
 */
export function formatTimeout(ms: number): string {
  if (ms < 60_000) return `${ms}ms`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Number((ms / 1000).toFixed(3))}s`;
}

/**
 * Translate an execFile rejection into what actually went wrong (anton-be1s). On a timeout Node
 * SIGTERMs the child and reports `Command failed: <argv>\n<stderr-so-far>` -- but stringer buffers
 * every collector's log until the whole scan finishes, so a killed scan's stderr holds only startup
 * noise. One job parked for three ~1000s attempts pointing at a harmless `gitlog` line while the
 * real cause was the deadline. So a kill is reported as a kill; every other failure keeps its
 * stderr, which for a genuine non-zero exit is the real diagnosis.
 */
function toScanError(err: unknown, opts: { timeoutMs: number }): unknown {
  const e = err as { name?: string; code?: unknown; killed?: boolean; signal?: string } | null;
  // A caller abort is cancellation, not a deadline -- keep the AbortError so the job runner
  // classifies it as such. Discriminate on the error Node raised, not on the signal's state now:
  // a signal aborted after a deadline kill would otherwise mask the timeout as cancellation.
  if (e?.name === "AbortError" || e?.code === "ABORT_ERR") return err;
  if (!e?.killed) return err;
  return new Error(
    `stringer timed out after ${formatTimeout(opts.timeoutMs)} (killed with ${e.signal ?? "SIGTERM"}, no output written). ` +
      `stringer buffers collector logs until every collector finishes, so its partial stderr is startup noise, not the cause.`,
    { cause: err },
  );
}

/**
 * stringer's `--delta` baseline, identified either side of a scan (anton-3flx). The baseline lives
 * in the REPO (`.stringer/last-scan.json`, rewritten on every delta scan) while anton's health
 * series lives in a disposable anton.db — two independent lifetimes, so neither can be inferred
 * from the other. Only these identities can tell a reader whether two scans measured the same
 * quantity: an arrival rate since a shared baseline, or a whole-repo standing total.
 */
export interface DeltaState {
  /**
   * The baseline this scan measured against. Absent when the scan ESTABLISHED it — nothing was
   * suppressed, so its signals are everything in the repo — or when it ran without `--delta`.
   */
  before?: string;
  /** The baseline it left for the next scan. Absent when anton could not read stringer's state. */
  after?: string;
  /**
   * True when these counts are a whole-repo STANDING TOTAL rather than an arrival rate — the scan
   * established `--delta`'s baseline, or ran without `--delta` at all.
   *
   * ABSENT is "anton cannot say", which is not the same claim and must not be recorded as one: a
   * missing `before` alone proves nothing, because a stringer that keeps its state somewhere anton
   * doesn't look answers `absent` to every scan, and reading that as "established" would label an
   * incremental series whole-repo forever. Only this module can tell the two apart — it saw the
   * state either side of the run (see {@link readBaseline}).
   */
  baselineScan?: boolean;
}

export interface ScanResult {
  /** Absolute path to the JSON scan file — stringer's, re-written with anton's severity annotation. */
  scanFile: string;
  /**
   * The signals stringer wrote (empty means nothing to triage). Carried rather than just counted:
   * the health record summarizes THESE, so the dispatch decision and the recorded counts come from
   * one parse of one read. Re-reading the file downstream let a storage error land a zeroed point on
   * the trend for a pass that had just dispatched triage, and split the envelope-shape knowledge
   * across two modules that could drift apart.
   */
  signals: ScanSignal[];
  /** Collectors that died during the scan — their signals are silently absent from the JSON. */
  collectorFailures: CollectorFailure[];
  /** What the untracked-file filter removed from `signals` before anyone counted them. */
  untracked: UntrackedFilter;
  /**
   * What the type-only filter removed from `signals`, and which fan-outs it re-priced, before anyone
   * counted them (see {@link filterCouplingSignals}).
   */
  coupling: CouplingFilter;
  /**
   * What the non-code filter removed from `signals` before anyone counted them — the duplication
   * signals whose reported block holds no executable statement (see {@link filterDuplicationSignals}).
   */
  duplication: DuplicationFilter;
  /**
   * What the reference check removed from `signals` — dead-code findings whose symbol has callers
   * elsewhere in the tree — before anyone counted them (see {@link filterDeadcodeSignals}).
   */
  deadcode: DeadcodeFilter;
  /** Which baseline this scan measured against, and which one it left (see {@link DeltaState}). */
  deltaState: DeltaState;
  /**
   * Put the `--delta` baseline back where this scan found it, for a caller that consumed this
   * window and then failed to REPORT it (triage died, the job was aborted). Returns why it couldn't,
   * or undefined on success — see {@link rejectWithBaselineRestored}, which turns that into the
   * right kind of failure. A no-op for a non-delta scan, which consumed no window.
   */
  restoreBaseline: () => Promise<string | undefined>;
}

/** Where stringer keeps the delta baseline — under the scanned repo, whatever anton's own cwd is. */
const DELTA_STATE_FILE = join(".stringer", "last-scan.json");

/**
 * The baseline as it stood at one moment — its identity, and enough to put it back.
 *
 * The identity is a content hash rather than a parsed field: every delta scan rewrites the file (it
 * carries the scan's timestamp and signal hashes), so the bytes already ARE the identity, and
 * reading them this way can't drift when stringer renames a key. Unreadable is reported as unknown,
 * never as unchanged — a state anton can't identify is one it can't prove two scans share.
 *
 * `absent` and `unreadable` are kept apart because only the first is restorable: a baseline that
 * wasn't there is put back by deleting the one stringer wrote, while bytes anton never read cannot
 * be reconstructed at all (see {@link restoreBaseline}).
 */
type BaselineSnapshot =
  | { kind: "read"; id: string; raw: Buffer }
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string };

async function readBaseline(repoPath: string): Promise<BaselineSnapshot> {
  try {
    const raw = await readFile(join(repoPath, DELTA_STATE_FILE));
    return { kind: "read", id: createHash("sha256").update(raw).digest("hex").slice(0, 16), raw };
  } catch (err) {
    const e = err as NodeJS.ErrnoException | null;
    if (e?.code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", reason: e?.message ?? String(err) };
  }
}

/** The baseline's identity as it stands right now, or undefined when there is none anton can read. */
async function deltaStateId(repoPath: string): Promise<string | undefined> {
  const snapshot = await readBaseline(repoPath);
  return snapshot.kind === "read" ? snapshot.id : undefined;
}

/**
 * Whether this pass's counts are a whole-repo standing total — the fact the trend renders on
 * (see {@link DeltaState.baselineScan}). Undefined wherever the evidence doesn't reach.
 *
 * @param baseline the state as it stood BEFORE the run; `undefined` for a non-delta scan.
 * @param after the state anton could identify afterwards.
 */
function classifyScanBasis(
  baseline: BaselineSnapshot | undefined,
  after: string | undefined,
): boolean | undefined {
  // No baseline was consulted at all, so stringer emitted everything in the repo.
  if (!baseline) return true;
  // It measured arrivals since a baseline anton read off the repo.
  if (baseline.kind === "read") return false;
  // Nothing there before and a baseline anton can see now: THIS scan established it. Without that
  // second half, an absent state is just a state anton can't find — unknown, not a baseline.
  if (baseline.kind === "absent" && after) return true;
  return undefined;
}

/**
 * Put the baseline back exactly as the scan found it. Returns why it couldn't, or undefined on success.
 *
 * stringer advances `.stringer/last-scan.json` on its way out, so a scan that then FAILS — anton
 * refused the output (see {@link readAnnotatedSignals}), or the process itself exited non-zero, hit
 * the deadline, or was cancelled — has already consumed the window it failed to report. Left alone,
 * the runner's `--delta` retry measures against the ADVANCED baseline, finds
 * nothing new, and records a clean pass for findings nobody ever triaged — the exact false green the
 * rejection exists to prevent. Restoring makes the retry rescan the same window.
 */
async function restoreBaseline(
  repoPath: string,
  snapshot: BaselineSnapshot,
): Promise<string | undefined> {
  const file = join(repoPath, DELTA_STATE_FILE);
  try {
    if (snapshot.kind === "read") await writeFile(file, snapshot.raw);
    // Nothing was there before, so the baseline stringer just established is the thing to undo.
    else if (snapshot.kind === "absent") await rm(file, { force: true });
    else return `anton could not read it before the scan (${snapshot.reason})`;
    return undefined;
  } catch (err) {
    return `rewriting ${file} failed (${err instanceof Error ? err.message : String(err)})`;
  }
}

/**
 * Rejecting a scan means unwinding it. When the baseline can't go back, the error says so rather
 * than leaving a retry to quietly measure against a baseline the rejected scan advanced.
 *
 * That case is POISON, not an ordinary failure: the runner reschedules a plain error, and the retry
 * would measure `--delta` against the advanced baseline, find nothing new, and close the pass green
 * over findings nobody triaged — the same false green the rejection exists to prevent, now dressed
 * as a success. Only a human can put the window back (reset the state file, or rescan with delta
 * off), so the job parks for one instead of burning attempts on a retry that cannot see the window.
 *
 * Exported because rejecting the scan's OUTPUT is not the only way a pass consumes a window without
 * reporting it: a scan whose PROCESS dies mid-run, and one whose triage dies afterwards, have the
 * same problem and must fail the same way (see {@link ScanResult.restoreBaseline}).
 */
export async function rejectWithBaselineRestored(
  err: unknown,
  restore: () => Promise<string | undefined>,
): Promise<unknown> {
  const problem = await restore();
  if (!problem) return err;
  return new PoisonError(
    `${err instanceof Error ? err.message : String(err)}. Worse, stringer's --delta baseline could ` +
      `not be restored (${problem}): a retry would measure against the baseline this scan advanced, ` +
      `so these findings will not reappear — parked for a human: rescan with delta off, or reset ` +
      `${DELTA_STATE_FILE}`,
    { cause: err },
  );
}

/** A collector stringer ran but that returned an error (or timed out) — a silent hole in the scan. */
export interface CollectorFailure {
  /** Collector name as stringer reports it, e.g. "gitlog". */
  name: string;
  /** stringer's error text, e.g. "opening repo: core.repositoryformatversion ...". */
  error: string;
}

/**
 * A dead collector doesn't fail the scan: stringer exits 0 and just omits that collector's signals,
 * so the loss is invisible in the JSON (anton-uspu — `gitlog` dies on every repo with
 * `extensions.worktreeConfig` set, taking churn/hotspots/reverts/lottery-risk with it, and nothing
 * said so). The only evidence is stderr, where stringer's slog emits one
 * `level=ERROR msg="collector failed" name=<c> error=<e>` line per casualty. Parse those out so the
 * caller can surface the hole; also covers collectors killed by COLLECTOR_TIMEOUT.
 */
const SLOG_FIELD_RE = /(\w+)=("(?:[^"\\]|\\.)*"|\S*)/g;
/** Older/quiet builds only emit the INFO form — matched as a fallback so a version bump can't re-silence us. */
const RETURNED_ERROR_RE = /^collector "([^"]+)" returned error: (.*)$/;

/** Unwrap a Go-quoted slog value (`"a \"b\""` → `a "b"`); plain values pass through. */
function unquote(value: string): string {
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    // Malformed for JSON (a truncated line, or a Go escape like \x00 that JSON rejects): salvage the
    // text by hand rather than dropping the field. Only strip a closing quote that's actually there.
    const body = value.endsWith('"') && value.length > 1 ? value.slice(1, -1) : value.slice(1);
    return body.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

/** Extract per-collector failures from stringer's stderr; one entry per collector (both forms agree). */
export function parseCollectorFailures(stderr: string): CollectorFailure[] {
  const byName = new Map<string, CollectorFailure>();
  for (const line of stderr.split("\n")) {
    const fields: Record<string, string> = {};
    for (const [, key, value] of line.matchAll(SLOG_FIELD_RE)) fields[key] = unquote(value);

    if (fields.msg === "collector failed") {
      const name = fields.name || "unknown";
      if (!byName.has(name)) byName.set(name, { name, error: fields.error || "unknown error" });
      continue;
    }
    const fallback = RETURNED_ERROR_RE.exec(fields.msg ?? "");
    if (fallback && !byName.has(fallback[1])) {
      byName.set(fallback[1], { name: fallback[1], error: fallback[2].trim() || "unknown error" });
    }
  }
  return [...byName.values()];
}

/**
 * One human-readable line per dead collector, naming what the scan lost. The worktreeConfig hint is
 * called out because it's the one cause an operator can act on — and anton won't touch a repo's git
 * config itself.
 */
export function describeCollectorFailure(failure: CollectorFailure): string {
  const base = `collector "${failure.name}" failed — ${failure.error}; its signals are missing from this scan`;
  return /worktreeconfig/i.test(failure.error)
    ? `${base}. Cause: this repo sets extensions.worktreeConfig (conductor and \`git config --worktree\` do this) and stringer's git library refuses it. Unsetting it is the operator's call — only safe if no .git/worktrees/*/config.worktree depends on it`
    : base;
}

/** The envelope keys stringer has used for its signal array, in the order they are recognized. */
const SIGNAL_ENVELOPE_KEYS = ["signals", "issues", "results"] as const;

/**
 * stringer JSON is either a top-level array or an object carrying `signals`/`issues`/`results`.
 * The ONE place that shape is known: every reader takes its signals from here, so a stringer that
 * renames its envelope key can't leave the scan dispatching triage while the health record counts zero.
 *
 * `undefined` — distinct from an empty array — for a shape carrying NONE of those keys. Both readers
 * would otherwise agree on a FALSE zero: a renamed envelope reads as a clean scan, skips triage, and
 * charts a green point for output nobody parsed. Reporting the fact rather than flattening it to
 * `[]` is what lets the caller refuse the scan (see {@link readAnnotatedSignals}).
 */
export function extractSignals(parsed: unknown): ScanSignal[] | undefined {
  if (Array.isArray(parsed)) return parsed as ScanSignal[];
  const key = envelopeKeyOf(parsed);
  return key ? ((parsed as Record<string, unknown>)[key] as ScanSignal[]) : undefined;
}

/** Which key {@link extractSignals} read the signals out of; undefined for an array or a shape it can't read. */
function envelopeKeyOf(parsed: unknown): (typeof SIGNAL_ENVELOPE_KEYS)[number] | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const o = parsed as Record<string, unknown>;
  return SIGNAL_ENVELOPE_KEYS.find((key) => Array.isArray(o[key]));
}

/**
 * The scan file with a REPLACED signal list, in whatever shape it arrived in — so a filtered signal
 * is gone from the file triage reads, not just from the array anton counted. Everything else the
 * envelope carries (stringer's metadata) rides through untouched.
 */
function withSignals(parsed: unknown, signals: ScanSignal[]): unknown {
  const key = envelopeKeyOf(parsed);
  return key ? { ...(parsed as Record<string, unknown>), [key]: signals } : signals;
}

/** What the unrecognized output looked like, so an operator can tell a rename from a broken write. */
function describeShape(parsed: unknown): string {
  if (parsed === null) return "null";
  if (typeof parsed !== "object") return typeof parsed;
  const keys = Object.keys(parsed as Record<string, unknown>);
  return keys.length > 0 ? `object with keys: ${keys.join(", ")}` : "empty object";
}

/**
 * Collectors whose findings are a claim about the REPOSITORY, so a file git doesn't track can't
 * support one. `githygiene` reports large binaries, mixed line endings and conflict markers off the
 * working tree, not the index: every scan of this repo flagged anton's own `anton.db` — gitignored
 * three times over and unknown to `git ls-files` — as a medium-severity "large binary file",
 * unactionable by construction and re-triaged every night (anton-j2zg).
 *
 * Deliberately not every collector: a `todos` or `patterns` finding is about the source in front of
 * you and reads the same whether or not it is committed yet, and a signal naming no file at all is
 * never in question. This drops only what git can positively contradict.
 */
const TRACKED_ONLY_COLLECTORS = new Set(["githygiene"]);

/**
 * One finding the filter removed. The path alone doesn't say what was lost — `githygiene` reports
 * committed secrets beside stale binaries, so a drop is logged with what the signal CLAIMED and the
 * severity it would have carried. An operator reading the session must be able to tell "routine
 * hygiene noise" from "a secret anton stopped watching" without re-running the scan.
 */
export interface DroppedSignal {
  /** The repo-relative path, as git would spell it. */
  path: string;
  /** stringer's `Kind` for the finding — its collector, when the signal named no kind. */
  kind: string;
  /** The severity the signal would have been counted at, derived before the drop. */
  severity: string;
}

/** What the untracked filter did to this scan — every drop is surfaced, never silent. */
export interface UntrackedFilter {
  /** The signals dropped because git does not track the file they are about. */
  dropped: DroppedSignal[];
  /**
   * Why git could not be asked, when it couldn't be. Nothing is dropped in that case: a filter that
   * can't prove a file is untracked must leave the signal in, so an unreadable repo under-filters
   * rather than silently deleting findings.
   */
  unavailable?: string;
}

/** Everything in the index, exactly as git spells it — or why anton couldn't ask. */
async function readTrackedPaths(repoPath: string): Promise<Set<string> | { unavailable: string }> {
  try {
    // -z for the same reason git/ops.ts uses it: under core.quotePath a non-ASCII path comes back
    // C-quoted, and a mangled path would read as untracked and drop a real finding.
    // 30s, not the scan's own budget: `ls-files` reads the index and returns in well under a second
    // even on a huge monorepo, so anything near the deadline is git stuck (stale lock, dead NFS
    // mount) — and a stuck git should surface fast rather than hold the scan slot for minutes.
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "ls-files", "-z"], {
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return new Set(stdout.split("\0").filter(Boolean));
  } catch (err) {
    return { unavailable: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A signal's path as git would spell it, or undefined when it isn't one git can be asked about:
 * no path, the repo root itself (collectors spell it `.`), or a path outside the scanned repo.
 * None of those is evidence of anything.
 */
function repoRelativePath(repoPath: string, signal: ScanSignal): string | undefined {
  const raw = signal.FilePath ?? signal.filePath;
  if (typeof raw !== "string" || !raw) return undefined;
  // normalize, not a `./` strip: it also collapses mid-path traversals, so a collector spelling a
  // tracked file `src/../app.ts` matches the index instead of missing it and losing a real finding.
  const rel = isAbsolute(raw) ? relative(repoPath, raw) : normalize(raw);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
  return rel;
}

/** What a signal says it found, falling back to its collector when it named no kind. */
function kindOf(signal: ScanSignal): string {
  const kind = signal.Kind ?? signal.kind;
  if (typeof kind === "string" && kind) return kind;
  return collectorOf(signal) || "unknown";
}

/**
 * Whether git tracks this path. A path with tracked files UNDER it counts: a signal can name a
 * directory, which is never itself in the index but is plainly part of the repo.
 */
function isTracked(tracked: Set<string>, path: string): boolean {
  if (tracked.has(path)) return true;
  const prefix = path.endsWith("/") ? path : `${path}/`;
  for (const file of tracked) {
    if (file.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Drop the signals git contradicts, and say how many. Runs BEFORE annotation so the health record's
 * severity counts and the triage prompt see one set — a filter applied downstream of either would
 * leave the trend charting findings the agent never saw.
 *
 * Asks git rather than re-reading `.gitignore`: the index is the one answer that already accounts
 * for negated patterns, nested ignore files, `core.excludesFile`, and files committed despite a
 * matching rule. Only reached when a signal actually raises the question, so an ordinary scan pays
 * no git call at all.
 */
async function dropUntrackedSignals(
  repoPath: string,
  signals: ScanSignal[],
): Promise<{ kept: ScanSignal[]; untracked: UntrackedFilter }> {
  const candidates = new Map<ScanSignal, string>();
  for (const signal of signals) {
    if (!TRACKED_ONLY_COLLECTORS.has(collectorOf(signal))) continue;
    const path = repoRelativePath(repoPath, signal);
    if (path) candidates.set(signal, path);
  }
  if (candidates.size === 0) return { kept: signals, untracked: { dropped: [] } };

  const tracked = await readTrackedPaths(repoPath);
  if (!(tracked instanceof Set)) {
    return { kept: signals, untracked: { dropped: [], ...tracked } };
  }

  const dropped: DroppedSignal[] = [];
  const kept = signals.filter((signal) => {
    const path = candidates.get(signal);
    if (path === undefined || isTracked(tracked, path)) return true;
    dropped.push({ path, kind: kindOf(signal), severity: severityOfSignal(signal) });
    return false;
  });
  return { kept, untracked: { dropped } };
}

/**
 * What the untracked filter removed, and what each drop CLAIMED; undefined when it removed nothing.
 *
 * Each path carries its findings' severity and kind, because that is what an operator triages on: a
 * dropped `medium large-binary` is the phantom this filter exists for, a dropped `critical
 * committed-secret` is anton going quiet about a leaked key and wants a look.
 */
export function describeUntrackedFilter(filter: UntrackedFilter): string | undefined {
  if (filter.unavailable) {
    return (
      `git could not be asked which files it tracks (${filter.unavailable}) — findings for files ` +
      `git does not track are counted this pass`
    );
  }
  if (filter.dropped.length === 0) return undefined;
  const byPath = new Map<string, Set<string>>();
  for (const { path, kind, severity } of filter.dropped) {
    const kinds = byPath.get(path) ?? new Set<string>();
    kinds.add(`${severity} ${kind}`);
    byPath.set(path, kinds);
  }
  // "; " between paths, since each entry already spends ", " on its kinds.
  const entries = [...byPath].map(([path, kinds]) => `${path} (${[...kinds].join(", ")})`);
  const shown = entries.slice(0, 10);
  const rest = entries.length - shown.length;
  return (
    `dropped ${filter.dropped.length} signal(s) about ${byPath.size} path(s) git does not track: ` +
    `${shown.join("; ")}${rest > 0 ? ` (+${rest} more)` : ""}`
  );
}

/**
 * Read the scan stringer just wrote, stamp anton's derived severity onto every signal, and write it
 * back. Two guarantees ride on this one parse:
 *
 * - **Output anton can't read is a failed scan, not a clean one.** stringer exits 0 having written
 *   the `-o` file even for zero new signals, so a missing, truncated, or unrecognized file is a
 *   process-boundary failure. Reading it as "no signals" would skip triage, chart a zero-signal
 *   point, and end the session `done` — the board would report a clean scan nobody could read. So
 *   it throws, and the runner retries or parks the job. The caller unwinds the `--delta` baseline on
 *   the way out, so the retry measures the window this attempt consumed rather than the one after it.
 * - **Triage labels the signal anton counted.** stringer emits no severity of its own; annotating
 *   here means the agent reads anton's derivation off the file instead of re-deriving one from the
 *   raw fields and drifting from the trend (see {@link annotateSignal}).
 *
 * It is also the one seam where a signal can still be dropped from BOTH readers at once — see
 * {@link dropUntrackedSignals}, {@link filterCouplingSignals}, {@link filterDuplicationSignals} and
 * {@link filterDeadcodeSignals}.
 */
async function readAnnotatedSignals(
  scanFile: string,
  repoPath: string,
  opts: { exclude: readonly string[]; abort?: AbortSignal },
): Promise<{
  signals: ScanSignal[];
  untracked: UntrackedFilter;
  coupling: CouplingFilter;
  duplication: DuplicationFilter;
  deadcode: DeadcodeFilter;
}> {
  let parsed: unknown;
  try {
    const raw = await readFile(scanFile, "utf8");
    if (!raw.trim()) throw new Error("the file is empty");
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `stringer exited 0 but its scan output at ${scanFile} is unreadable (${reason}) — ` +
        `reading it as an empty scan would record a clean pass for a scan nobody read`,
      { cause: err },
    );
  }

  // Valid JSON anton can't find signals in is the same false green as no JSON at all: stringer
  // spells "nothing new" as `[]` or an empty envelope array, so a shape carrying neither is output
  // nobody parsed — counting it as zero would skip triage and chart a clean point over whatever a
  // renamed envelope was holding. Refusing it instead unwinds the baseline, so the findings come
  // back on the rescan once the new key is recognized.
  const signals = extractSignals(parsed);
  if (!signals) {
    throw new Error(
      `stringer exited 0 but its scan output at ${scanFile} carries no recognized signal array ` +
        `(${describeShape(parsed)}; expected a top-level array or one of ` +
        `${SIGNAL_ENVELOPE_KEYS.join("/")}) — reading it as an empty scan would record a clean pass ` +
        `for output nobody parsed. If stringer renamed its envelope key, add it to SIGNAL_ENVELOPE_KEYS.`,
    );
  }

  const { kept: tracked, untracked } = await dropUntrackedSignals(repoPath, signals);
  // Coupling after untracked: it reads the source of the modules a signal names, so it should never
  // be paid for a finding the index already contradicted.
  const { kept: coupled, coupling } = await filterCouplingSignals(repoPath, tracked);
  // Same reason, same order: reading the source at a reported clone window is only worth paying for
  // a finding the index hasn't already contradicted.
  const { kept: deduped, duplication } = await filterDuplicationSignals(repoPath, coupled);
  // Deadcode last: one `git grep` per symbol is cheap but not free, so it runs over only what every
  // cheaper filter left.
  const { kept, deadcode } = await filterDeadcodeSignals(repoPath, deduped, {
    exclude: opts.exclude,
    abort: opts.abort,
  });
  for (const signal of kept) annotateSignal(signal);
  await writeFile(scanFile, JSON.stringify(withSignals(parsed, kept)), "utf8");
  return { signals: kept, untracked, coupling, duplication, deadcode };
}

/**
 * Run `stringer scan <repo> --delta --format json -o <scanFile>` and return the signals it produced,
 * plus any collector that died mid-scan (stringer exits 0 either way — see
 * `parseCollectorFailures`) and the baseline this pass measured against (see {@link DeltaState}).
 * `delta` (default true) restricts to new signals since the last scan.
 * Throws on a stringer failure OR on output it can't read (fail loud — see
 * `readAnnotatedSignals`), so the job then retries/parks per the runner's policy; a deadline kill
 * throws a distinct "timed out" error rather than stringer's misleading partial stderr. Any failed
 * scan — refused output or a dead process — leaves the `--delta` baseline where it found it, so the
 * retry rescans the same window rather
 * than the empty one this attempt advanced past — and when it CAN'T put the baseline back, it throws
 * poison so the runner parks the job instead of retrying past the lost window (see
 * `rejectWithBaselineRestored`).
 */
export async function scan(opts: {
  repoPath: string;
  scanFile: string;
  delta?: boolean;
  /** Extra exclude globs, appended to DEFAULT_SCAN_EXCLUDES. */
  exclude?: string[];
  signal?: AbortSignal;
}): Promise<ScanResult> {
  const bin = process.env[STRINGER_BIN_ENV] ?? "stringer";
  await mkdir(dirname(opts.scanFile), { recursive: true });

  const delta = opts.delta ?? true;
  // Read BEFORE the run: only the pre-scan state distinguishes a pass that measured arrivals since
  // a baseline from one that established it, and stringer overwrites the state on its way out. The
  // BYTES come along so a scan anton refuses can be unwound (see `restoreBaseline`). A non-delta
  // scan counts the whole repo whatever is on disk, so it consumes no baseline at all.
  const baseline = delta ? await readBaseline(opts.repoPath) : undefined;
  const before = baseline?.kind === "read" ? baseline.id : undefined;
  const unwind = async (): Promise<string | undefined> =>
    baseline ? restoreBaseline(opts.repoPath, baseline) : undefined;

  const args = ["scan", opts.repoPath, "--format", "json", "-o", opts.scanFile];
  if (delta) args.push("--delta");
  // Skip build output / caches so the walk stays on source (the .next build dir alone made this scan
  // time out), and cap each collector so a runaway one can't hang the whole scan past the timeout.
  const exclude = [...DEFAULT_SCAN_EXCLUDES, ...(opts.exclude ?? [])];
  args.push("--exclude", exclude.join(","));
  args.push("--collector-timeout", COLLECTOR_TIMEOUT);
  // Keep stderr free of ANSI escapes so the collector-failure parse stays reliable when a TTY leaks in.
  args.push("--no-color");

  const timeoutMs = scanTimeoutMs();
  let stderr = "";
  try {
    ({ stderr } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      signal: opts.signal,
    }));
  } catch (err) {
    // A scan that DIED still consumed the window: stringer rewrites its state as it goes, so a
    // non-zero exit, a deadline kill, or a caller abort can leave the baseline advanced past
    // signals it produced but never wrote out. Unwind here too — without it the next attempt
    // measures from the advanced state, finds nothing, and closes green over findings nobody
    // triaged. The original error passes through unchanged when the unwind works, so the runner
    // still classifies a timeout as a timeout and an abort as cancellation.
    throw await rejectWithBaselineRestored(toScanError(err, { timeoutMs }), unwind);
  }

  let read: Awaited<ReturnType<typeof readAnnotatedSignals>>;
  try {
    read = await readAnnotatedSignals(opts.scanFile, opts.repoPath, {
      exclude,
      abort: opts.signal,
    });
  } catch (err) {
    // Refusing the output means refusing the whole pass, baseline included: the retry has to see the
    // same window this attempt consumed, or its findings are lost to a clean-looking rescan. A
    // cancel lands here too — the reference check stops on the caller's signal, and the pass it
    // abandons still consumed the window.
    throw await rejectWithBaselineRestored(err, unwind);
  }

  const after = delta ? await deltaStateId(opts.repoPath) : undefined;
  const baselineScan = classifyScanBasis(baseline, after);
  return {
    scanFile: opts.scanFile,
    signals: read.signals,
    collectorFailures: parseCollectorFailures(stderr),
    untracked: read.untracked,
    coupling: read.coupling,
    duplication: read.duplication,
    deadcode: read.deadcode,
    deltaState: {
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
      ...(baselineScan === undefined ? {} : { baselineScan }),
    },
    restoreBaseline: unwind,
  };
}
