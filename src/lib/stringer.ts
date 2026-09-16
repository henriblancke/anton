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
import { readFile, writeFile, mkdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { annotateSignal, collectorOf, severityOfSignal, type ScanSignal } from "./scan-severity";
import { filterCouplingSignals, type CouplingFilter } from "./scan-coupling";
import { filterDeadcodeSignals, type DeadcodeFilter } from "./scan-deadcode";
import {
  filterDuplicationSignals,
  parseLocations,
  insideRepo,
  DUPLICATION_COLLECTOR,
  type DuplicationFilter,
} from "./scan-duplication";
import { filterSecretSignals, type SecretFilter } from "./scan-secrets";
import { PoisonError } from "./jobs/errors";
import { GH_BIN_ENV } from "./git/ops";

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
  /**
   * What the nested-worktree filter removed from `signals` before anyone counted them — every
   * collector's findings about a path inside another checkout of this same repo (see
   * {@link dropWorktreeSignals}).
   */
  worktree: WorktreeFilter;
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
   * What the fixture filter removed from `signals` before anyone counted them — the committed-secret
   * signals whose flagged line holds a test placeholder (see {@link filterSecretSignals}).
   */
  secrets: SecretFilter;
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
 * None of those is evidence of anything. Containment itself is {@link insideRepo} — shared with
 * scan-duplication.ts's location parsing rather than a second copy of the same check.
 */
function repoRelativePath(repoPath: string, signal: ScanSignal): string | undefined {
  const raw = signal.FilePath ?? signal.filePath;
  return typeof raw === "string" && raw ? insideRepo(repoPath, raw) : undefined;
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
 * "path (severity kind, severity kind); path2 (...)" for a set of dropped signals, grouped by path
 * and capped at 10 path entries with a `(+N more)` tail — the shared body every `describe*Filter`
 * below renders. Each caller owns its own drop-count/filter-specific preamble; this only formats
 * what was lost, because that's what an operator triages on: a dropped `medium large-binary` is the
 * phantom a filter exists for, a dropped `critical committed-secret` is anton going quiet about a
 * leaked key and wants a look.
 */
function formatDroppedSignals(dropped: readonly DroppedSignal[]): { paths: number; list: string } {
  const byPath = new Map<string, Set<string>>();
  for (const { path, kind, severity } of dropped) {
    const kinds = byPath.get(path) ?? new Set<string>();
    kinds.add(`${severity} ${kind}`);
    byPath.set(path, kinds);
  }
  // "; " between paths, since each entry already spends ", " on its kinds.
  const entries = [...byPath].map(([path, kinds]) => `${path} (${[...kinds].join(", ")})`);
  const shown = entries.slice(0, 10);
  const rest = entries.length - shown.length;
  return { paths: byPath.size, list: `${shown.join("; ")}${rest > 0 ? ` (+${rest} more)` : ""}` };
}

/**
 * What the untracked filter removed, and what each drop CLAIMED; undefined when it removed nothing.
 */
export function describeUntrackedFilter(filter: UntrackedFilter): string | undefined {
  if (filter.unavailable) {
    return (
      `git could not be asked which files it tracks (${filter.unavailable}) — findings for files ` +
      `git does not track are counted this pass`
    );
  }
  if (filter.dropped.length === 0) return undefined;
  const { paths, list } = formatDroppedSignals(filter.dropped);
  return (
    `dropped ${filter.dropped.length} signal(s) about ${paths} path(s) git does not track: ${list}`
  );
}

/**
 * A git worktree checked out INSIDE the repo it scans is a second full copy of the tree: every real
 * finding under it is also reported at its own path, so it must never reach triage. `.claude/**`
 * already excludes Claude Code's own isolation worktrees (anton-bqge) from the walk, but a worktree
 * at any OTHER in-repo path — `.worktrees/<name>/`, or wherever the next tool picks — was still
 * walked in full (anton-fj1q: 759 of 894 signals in the 2026-09-10 scan of this repo).
 *
 * `git worktree list` is what actually distinguishes a second checkout from a directory that merely
 * looks like one (`src/lib/worktrees/`, a file named `worktrees.ts`) — a name list has to be kept
 * current by hand and misses the next tool; asking git what a worktree IS does not.
 */
export interface WorktreeFilter {
  /** The signals dropped because they describe a path inside a nested worktree. */
  dropped: DroppedSignal[];
  /** The nested worktrees this scan found, repo-relative — whether or not they held any signals. */
  worktrees: string[];
  /**
   * Why `git worktree list` could not be FULLY asked, when it couldn't be. Set whenever at least
   * one of the pre-/post-scan lookups failed, even if the other one resolved: `dropped`/`worktrees`
   * still reflect whatever that other lookup found, filtered as usual (see
   * {@link mergeNestedWorktrees}) — a worktree only the failed half would have seen is the one thing
   * still uncaught, so this under-filters rather than the reverse. Only when BOTH lookups fail are
   * `dropped`/`worktrees` themselves empty, leaving every signal counted.
   */
  unavailable?: string;
}

/**
 * Every OTHER checkout of this repo, repo-relative. `git worktree list --porcelain` lists the main
 * worktree first, then linked worktrees — not necessarily the checkout named by `repoPath`: when
 * `repoPath` is itself a linked worktree and the main worktree sits beneath it, the main checkout
 * would be misread as nested if we dropped by list position. So each entry is compared by resolved
 * path against `repoPath` instead — only the entry that IS the scanned checkout is excluded; a path
 * git names outside `repoPath` (a worktree of some other repo entirely — not possible in practice,
 * but not this filter's claim to make) is dropped too.
 *
 * Resolved through `realpath` on both sides before comparing: git reports worktree paths with
 * symlinks resolved, but `repoPath` itself may not be (a symlinked checkout, or — on macOS — a temp
 * dir under `/var`, itself a symlink to `/private/var`). Comparing one resolved path against one
 * unresolved path would find no common prefix at all and read every nested worktree as outside the
 * repo, silently disabling the whole filter.
 *
 * Parsed with `--porcelain -z`: an in-repo worktree path containing a newline would truncate on a
 * plain `\n` split, so `realpath` and the containment check below would silently miss everything
 * under it. `-z` NUL-terminates each attribute instead of newline-terminating it, and ends a record
 * with an empty field where plain `--porcelain` writes a blank line — so paths are read whole, and
 * since NUL, not whitespace, is the delimiter, a path is used as-is rather than trimmed (a trailing
 * space in a real path is significant and must survive).
 *
 * Parsed as whole RECORDS rather than isolated `worktree ` lines, so a `prunable` attribute in the
 * same block is seen: a registration can outlive its checkout — deleted without `git worktree
 * remove` — and git keeps reporting it (marked `prunable gitdir file points to non-existent
 * location`) even once the path has been recreated as an ordinary directory (see `worktree.ts`'s own
 * `existsSync` check for the same fact, anton-2wvb). Reading only the `worktree ` field would treat
 * that stale registration as a live nested checkout and drop every real signal under a path that is
 * no longer a worktree at all — so a prunable record is excluded before its path is even resolved.
 *
 * `prunable` alone isn't enough, though: `should_prune_worktree` never reports it for a *locked*
 * worktree (this repo locks its own, see `worktree.ts:485-491`), so a locked worktree deleted
 * outside git and reused as an ordinary tracked directory still passes the prunable check — git
 * keeps citing `locked` for a registration that no longer points at a checkout. A LINKED worktree
 * always has a `.git` FILE (not directory) at its root pointing back at the main repo's
 * `.git/worktrees/<name>`; a reused-as-ordinary directory doesn't. `isWorktreeCheckout` verifies
 * that marker before a resolved path is trusted, so a stale locked registration is dropped from
 * `nested` the same as a prunable one — real findings under its path keep flowing to triage.
 *
 * That marker check is skipped for the MAIN worktree specifically: git guarantees `worktree list`
 * reports it first regardless of which checkout `repoPath` names, and its `.git` is an ordinary
 * DIRECTORY, not the file marker a linked worktree has — so when `repoPath` is itself a linked
 * worktree with the main checkout nested beneath it, requiring the file marker on every record
 * would fail `isWorktreeCheckout` for that main checkout and leave it out of `--exclude` entirely,
 * silently letting its whole tree double-report every real finding (anton-fj1q PR #295 review).
 * The main worktree can't be a stale registration the way a linked one can — it's the checkout the
 * repo's own `.git` lives in — so skipping the marker check for it only widens what's excluded, it
 * never lets a fake one in.
 *
 * Bounded by (and cancellable via) the caller's own scan deadline/signal, same reasoning as
 * {@link githubToken}: this runs before `scan()`'s deadline clock starts, so the caller passes a
 * budget already charged against the outer timeout rather than an independent one — otherwise an
 * already-cancelled scan (or a near-zero ANTON_STRINGER_TIMEOUT_MS) could sit here regardless.
 *
 * That budget covers the whole lookup, not just the `git worktree list` subprocess: the `realpath`/
 * `stat` probes below it (per registered worktree) run against the actual filesystem, and neither
 * fs API takes a timeout — `realpath` doesn't accept a `signal` at all, and `stat`'s only checks one
 * at the call's start, not while the syscall is in flight. Left unbounded, a registered worktree on
 * a stalled mount (or an abort that lands while these are pending) could still hang `scan()` past
 * `ANTON_STRINGER_TIMEOUT_MS` after the subprocess above already returned. {@link withBudget} races
 * each probe against what's left of the deadline and the caller's signal instead.
 */
function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; code?: unknown } | null;
  return e?.name === "AbortError" || e?.code === "ABORT_ERR";
}

/**
 * Normalizes an abort into an identity `isAbortError` recognizes, no matter what the signal's own
 * `reason` carries. `AbortSignal.timeout()` sets `reason` to a `TimeoutError`, and a caller's own
 * `abort(customReason)` can set it to anything -- neither satisfies `isAbortError`, so a probe
 * racing {@link withBudget} against such a signal would reject with a value `listNestedWorktrees`
 * can't recognize as cancellation, converting a real abort into a plain lookup failure
 * ("unavailable") that can let an already-cancelled scan report success (PR #295 review).
 */
function toAbortError(reason: unknown): Error {
  if (isAbortError(reason)) return reason as Error;
  return new DOMException("This operation was aborted", "AbortError");
}

/**
 * Thrown by {@link withBudget} on deadline expiry (as opposed to the promise it's racing rejecting
 * on its own). Distinguished from a genuine filesystem lookup failure (ENOENT, EACCES, ...) so
 * callers can rethrow it like an abort instead of falling back to an unresolved path: falling back
 * here would let `scan()` return an incomplete worktree snapshot *and* still report success past its
 * own deadline, exactly the silent overrun {@link withBudget} exists to prevent.
 */
class ProbeDeadlineExceededError extends Error {
  constructor() {
    super("filesystem probe exceeded the scan deadline");
    this.name = "ProbeDeadlineExceededError";
  }
}

function isDeadlineError(err: unknown): boolean {
  return err instanceof ProbeDeadlineExceededError;
}

/**
 * Race a promise against what's left of `deadline` and the caller's `signal`, so a caller waiting on
 * it can't be made to hang past either. This does NOT cancel the underlying operation — Node gives
 * no way to interrupt a pending `stat`/`realpath` mid-syscall — it only stops the caller from
 * waiting on it, which is the actual guarantee a deadline/abort makes to its caller.
 */
function withBudget<T>(promise: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(toAbortError(signal.reason));
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new ProbeDeadlineExceededError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(toAbortError(signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      reject(new ProbeDeadlineExceededError());
    }, remaining);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

async function isWorktreeCheckout(path: string, deadline: number, signal?: AbortSignal): Promise<boolean> {
  try {
    return (await withBudget(stat(join(path, ".git")), deadline, signal)).isFile();
  } catch (err) {
    if (isAbortError(err) || isDeadlineError(err)) throw err;
    return false;
  }
}

async function listNestedWorktrees(
  repoPath: string,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<string[] | { unavailable: string }> {
  // Same "budget already spent" guard as githubToken's own `if (timeoutMs <= 0) return undefined`:
  // without it, `Math.max(1, Math.min(30_000, opts.timeoutMs))` below floors the subprocess timeout
  // at 1ms instead of skipping the spawn, so a call made after the deadline has already passed still
  // shells out to `git worktree list` rather than reporting unavailable immediately (PR #295 review).
  if (opts.timeoutMs <= 0) return { unavailable: "no time budget remaining for the nested-worktree lookup" };
  const deadline = Date.now() + Math.max(0, opts.timeoutMs);
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "worktree", "list", "--porcelain", "-z"],
      { timeout: Math.max(1, Math.min(30_000, opts.timeoutMs)), maxBuffer: 8 * 1024 * 1024, signal: opts.signal },
    );
    const records: string[][] = [[]];
    for (const field of stdout.split("\0")) {
      if (field === "") {
        if (records[records.length - 1].length > 0) records.push([]);
        continue;
      }
      records[records.length - 1].push(field);
    }

    const resolvedRepo = await withBudget(realpath(repoPath), deadline, opts.signal).catch((err) => {
      if (isAbortError(err) || isDeadlineError(err)) throw err;
      return repoPath;
    });
    const nested: string[] = [];
    for (const [index, record] of records.entries()) {
      const worktreeLine = record.find((l) => l.startsWith("worktree "));
      if (!worktreeLine) continue;
      if (record.some((l) => l === "prunable" || l.startsWith("prunable "))) continue;
      const wt = worktreeLine.slice("worktree ".length);
      const resolvedWt = await withBudget(realpath(wt), deadline, opts.signal).catch((err) => {
        if (isAbortError(err) || isDeadlineError(err)) throw err;
        return wt;
      });
      if (resolvedWt === resolvedRepo) continue;
      // git always lists the main worktree first, and only LINKED worktrees carry the `.git`
      // file marker — see the doc comment above for why the main entry skips this check.
      const isMainWorktree = index === 0;
      if (!isMainWorktree && !(await isWorktreeCheckout(resolvedWt, deadline, opts.signal))) continue;
      const rel = relative(resolvedRepo, resolvedWt);
      if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) nested.push(rel);
    }
    return nested;
  } catch (err) {
    // A caller abort must propagate, not collapse into "unavailable": swallowing it here would let
    // scan() proceed as if nothing were nested instead of short-circuiting as cancellation (mirrors
    // githubToken's own AbortError check, for the same reason). A deadline hit inside the
    // realpath/stat probes above lands here too, as a plain Error — reported as "unavailable" the
    // same as any other lookup failure, not silently swallowed into an empty `nested` list.
    if (isAbortError(err)) throw err;
    return { unavailable: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Union two `listNestedWorktrees` snapshots into one the post-scan backstop can filter against.
 * The pre-scan snapshot alone is stale by the time stringer exits: a worktree another process
 * creates mid-scan is in neither the `--exclude` list (built before stringer ran) nor an unrefreshed
 * `nested`, so its signals would sail through the one filter meant to catch what `--exclude` missed
 * (anton-fj1q PR #295 review). Unioning misses nothing either lookup saw.
 *
 * A transient failure in ONE snapshot must not discard what the OTHER one resolved. An earlier
 * version returned bare `{ unavailable }` the moment either side failed, which meant a flaky
 * pre-scan lookup followed by a successful post-scan retry threw away that retry's list too —
 * `dropWorktreeSignals` then received "unavailable" instead of the worktrees the retry actually
 * found, and every signal under one of them survived to triage as a phantom finding (anton-fj1q PR
 * #295 review). So the worktrees either side resolved are always unioned into the result;
 * `unavailable`, when set, rides alongside as a caveat rather than replacing that list —
 * `dropWorktreeSignals` still filters against what's there, and {@link describeWorktreeFilter}
 * reports the partial failure separately from whatever got dropped.
 */
function mergeNestedWorktrees(
  before: string[] | { unavailable: string },
  after: string[] | { unavailable: string },
): { worktrees: string[]; unavailable?: string } {
  const worktrees = Array.from(
    new Set([...(Array.isArray(before) ? before : []), ...(Array.isArray(after) ? after : [])]),
  );
  const failures = [before, after]
    .filter((snapshot): snapshot is { unavailable: string } => !Array.isArray(snapshot))
    .map((snapshot) => snapshot.unavailable);
  return failures.length === 0 ? { worktrees } : { worktrees, unavailable: failures.join("; ") };
}

/**
 * Drop the signals describing a path inside another checkout of this same repo, and say how many.
 * Runs BEFORE annotation, same as {@link dropUntrackedSignals} — a filter applied downstream of it
 * would leave the trend charting findings the agent never saw. `nested` is precomputed by the
 * caller ({@link scan} needs it before spawning stringer, to build `--exclude`) — this filter is a
 * backstop against whatever a glob exclude doesn't catch, not the primary defense.
 *
 * Unlike {@link dropUntrackedSignals} this runs over every collector's signals, not just
 * `githygiene`'s: the 2026-09-10 scan of this repo split its phantom signals across complexity,
 * patterns, duplication, coupling AND todos (759 of 894 total) — a nested worktree is never a valid
 * finding for ANY collector on the tree that ships.
 *
 * A `duplication` signal gets its own rule: it reports a GROUP of locations (in `Description`, see
 * {@link parseLocations}), and its own `FilePath` is only ONE of them — specifically, the FIRST one
 * stringer listed (verified against a 97-signal real scan, fixture at
 * `scan-duplication.d9eab116.fixture.json`: 97 signals, 97 distinct Descriptions, every `FilePath`
 * equal to its own Description's first location — one signal per clone GROUP, not one per
 * location). Checking `FilePath` alone would keep a clone whose "duplicate" is entirely the nested
 * worktree mirroring the real file, so once a signal names two or more locations, the vote runs
 * over ALL of them: it survives only if at least two locations sit outside every nested worktree,
 * because one real location left is not a duplicate of anything the tree still has.
 *
 * Because there is only ONE signal per group, a group that survives the vote must be KEPT even when
 * its own `FilePath` happens to be the nested location — there is no sibling signal for the
 * surviving real locations to carry the finding through on its own. Dropping it unconditionally,
 * as an earlier version of this filter did, silently deleted every valid clone group whose
 * representative happened to be listed first-and-nested (anton-fj1q PR #295 review). Instead the
 * signal is re-anchored: `FilePath`/`Line` are rewritten to a surviving real location, so triage
 * still points at a file whose edits ship.
 *
 * `Description` is rewritten the same way, dropping any nested location from its list, not just
 * `FilePath`/`Line`. {@link filterDuplicationSignals} reparses `Description` downstream
 * ({@link parseLocations}) and gives every location it lists its own declaration/code vote — left
 * unrewritten, the nested copy (identical text to the real location it mirrors) casts a second vote
 * for the same class, which can turn a genuine tie between two real locations into a false
 * declarative majority and drop a real clone. Whichever casing alias actually held the text
 * (`Description` or the lowercase `description` stringer sometimes emits) is the one rewritten, in
 * `parseLocations`'s own `??` order — writing `Description` unconditionally would plant an empty
 * string there that outranks a populated `description` in that same fallback chain, since `??` only
 * yields to null/undefined, not to `""` (anton-fj1q PR #295 review).
 */

/**
 * Drop every `  - path:line` entry from a duplication signal's `Description` whose raw text isn't
 * in `keep` (see {@link parseLocations} for the format this mirrors). Matched against the RAW
 * location text stringer emitted, not a resolved/repo-relative form, since that's what's actually
 * in the string being edited. Everything else — the preamble line, blank lines, indentation — is
 * left untouched.
 */
function reanchorDescription(description: string, keep: Set<string>): string {
  return description
    .split("\n")
    .filter((line) => {
      const match = /^\s*-\s+(.+):(\d+)\s*$/.exec(line);
      return match === null || keep.has(`${match[1]}:${match[2]}`);
    })
    .join("\n");
}

async function dropWorktreeSignals(
  repoPath: string,
  signals: ScanSignal[],
  nested: { worktrees: string[]; unavailable?: string },
): Promise<{ kept: ScanSignal[]; worktree: WorktreeFilter }> {
  const { worktrees, unavailable } = nested;
  // Whatever either lookup resolved is still filtered, even when the OTHER one failed — see
  // `mergeNestedWorktrees`. Only when neither resolved anything (worktrees is empty) is there
  // nothing to filter against; `unavailable`, if set, still rides along as a caveat.
  if (worktrees.length === 0) {
    return { kept: signals, worktree: { dropped: [], worktrees: [], ...(unavailable ? { unavailable } : {}) } };
  }

  const isNested = (path: string) => worktrees.some((wt) => path === wt || path.startsWith(`${wt}${sep}`));

  const dropped: DroppedSignal[] = [];
  const kept = signals.filter((signal) => {
    if (collectorOf(signal) === DUPLICATION_COLLECTOR) {
      const locations = parseLocations(signal);
      if (locations.length >= 2) {
        const withResolved = locations.map((loc) => {
          const resolvedPath = insideRepo(repoPath, loc.path);
          return { raw: loc, resolved: resolvedPath === undefined ? undefined : { path: resolvedPath, line: loc.line } };
        });
        const real = withResolved.filter((loc) => loc.resolved !== undefined && !isNested(loc.resolved.path));
        if (real.length >= 2) {
          const ownPath = repoRelativePath(repoPath, signal);
          if (ownPath === undefined || isNested(ownPath)) {
            signal.FilePath = real[0].resolved!.path;
            signal.Line = real[0].resolved!.line;
          }
          if (real.length < locations.length) {
            const keep = new Set(real.map((loc) => `${loc.raw.path}:${loc.raw.line}`));
            // Rewrite whichever alias actually supplied the text `parseLocations` read (its own
            // `Description ?? description` order), not `Description` unconditionally: a signal that
            // only ever carried the lowercase alias has `Description` as null/undefined, and writing
            // an empty string there would outrank `description` in that same `??` chain downstream
            // (`??` only falls through on null/undefined, not on ""), silently blanking the
            // locations `filterDuplicationSignals` re-parses (anton-fj1q PR #295 review).
            if (signal.Description !== undefined && signal.Description !== null) {
              signal.Description = reanchorDescription(signal.Description, keep);
            } else if (signal.description !== undefined && signal.description !== null) {
              signal.description = reanchorDescription(signal.description, keep);
            }
          }
          return true;
        }
        const ownPath = repoRelativePath(repoPath, signal);
        dropped.push({
          path: ownPath ?? withResolved[0]?.resolved?.path ?? "",
          kind: kindOf(signal),
          severity: severityOfSignal(signal),
        });
        return false;
      }
      // Description carried fewer than two locations (or none stringer's list format covers), so
      // there is nothing to vote over — fall back to the single-path check every other signal gets.
    }

    const path = repoRelativePath(repoPath, signal);
    const under = path !== undefined && isNested(path);
    if (!under) return true;
    dropped.push({ path: path as string, kind: kindOf(signal), severity: severityOfSignal(signal) });
    return false;
  });
  return { kept, worktree: { dropped, worktrees, ...(unavailable ? { unavailable } : {}) } };
}

/**
 * What the worktree filter removed, and which nested checkouts it found; undefined when there is
 * nothing to say (no nested worktree found, nothing dropped, and both lookups succeeded).
 *
 * `dropped`/`worktrees` and `unavailable` are reported independently rather than one gating the
 * other: a partial failure (one of the pre-/post-scan lookups down, the other one resolved) can
 * carry both at once — see {@link mergeNestedWorktrees} — and collapsing that case into just the
 * "unavailable" branch would silently drop the record of what the successful half actually found
 * and filtered (anton-fj1q PR #295 review).
 */
export function describeWorktreeFilter(filter: WorktreeFilter): string | undefined {
  const parts: string[] = [];
  if (filter.dropped.length > 0) {
    const { paths, list } = formatDroppedSignals(filter.dropped);
    parts.push(
      `dropped ${filter.dropped.length} signal(s) under ${filter.worktrees.length} nested worktree(s) ` +
        `(${filter.worktrees.join(", ")}) about ${paths} path(s): ${list}`,
    );
  }
  if (filter.unavailable) {
    parts.push(
      `git worktree list could not be fully read (${filter.unavailable}) — findings under a nested ` +
        `checkout neither lookup saw, if any, are still counted this pass`,
    );
  }
  return parts.length === 0 ? undefined : parts.join("; ");
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
 * {@link dropUntrackedSignals}, {@link filterSecretSignals}, {@link filterCouplingSignals},
 * {@link filterDuplicationSignals} and {@link filterDeadcodeSignals}.
 */
async function readAnnotatedSignals(
  scanFile: string,
  repoPath: string,
  opts: {
    exclude: readonly string[];
    /**
     * The union of {@link scan}'s pre-scan enumeration (it already needs one to build stringer's
     * --exclude) and its post-scan re-enumeration, via {@link mergeNestedWorktrees} — not the
     * pre-scan snapshot alone, or a worktree created mid-scan would be invisible to this backstop too.
     */
    nested: { worktrees: string[]; unavailable?: string };
    /** The scan's own outer deadline (absolute), charged against the `realpath` probe below. */
    deadline: number;
    abort?: AbortSignal;
  },
): Promise<{
  signals: ScanSignal[];
  worktree: WorktreeFilter;
  untracked: UntrackedFilter;
  coupling: CouplingFilter;
  duplication: DuplicationFilter;
  secrets: SecretFilter;
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

  // Canonicalized once, up front: every filter below classifies an absolute signal `FilePath`
  // against this root via `insideRepo`'s plain `path.relative`, which is lexical and never resolves
  // symlinks itself. `listNestedWorktrees` already resolves the same repo for its own comparison, so
  // a `repoPath` handed in as a symlink (or a macOS `/tmp` vs `/private/tmp` spelling) would otherwise
  // make a real nested-worktree signal's canonical absolute path compare as outside the repo and
  // survive every filter here. Falls back to the given path on ANY failure here — including a
  // deadline hit or a caller abort, unlike the per-worktree probes in `listNestedWorktrees` that
  // rethrow those — since (unlike that lookup) there is no "unavailable" state for this step to
  // report: an unresolved path only degrades the lexical lookup below to what `insideRepo` already
  // does without canonicalization, so failing the whole scan over it would be worse than the drift it
  // guards against. Raced against the scan's own deadline/abort via `withBudget` so a stalled mount
  // can't hang this call forever the way a plain `realpath` would — this runs AFTER stringer has
  // already exited, so nothing else is left running to blame for the hang (PR #295 review).
  const resolvedRepoPath = await withBudget(realpath(repoPath), opts.deadline, opts.abort).catch(
    () => repoPath,
  );

  // Nested-worktree signals first, over every collector: a phantom path is never worth the cost the
  // filters below pay to read its content. `scan()` already excluded these paths from the walk
  // itself, so this is now a backstop rather than the primary defense — `opts.nested` is the union
  // of scan()'s pre- and post-scan enumerations, not just its first (pre-scan) result, so a worktree
  // created mid-scan is still caught here even though it slipped stringer's `--exclude`.
  const { kept: real, worktree } = await dropWorktreeSignals(resolvedRepoPath, signals, opts.nested);
  const { kept: tracked, untracked } = await dropUntrackedSignals(resolvedRepoPath, real);
  // Secrets next, while the githygiene findings are together: it reads the flagged line, so it
  // should never be paid for a finding the index already contradicted.
  const { kept: unfaked, secrets } = await filterSecretSignals(resolvedRepoPath, tracked);
  // Coupling after that: it reads the source of the modules a signal names, so it should never be
  // paid for a finding the index already contradicted.
  const { kept: coupled, coupling } = await filterCouplingSignals(resolvedRepoPath, unfaked);
  // Same reason, same order: reading the source at a reported clone window is only worth paying for
  // a finding the index hasn't already contradicted.
  const { kept: deduped, duplication } = await filterDuplicationSignals(resolvedRepoPath, coupled);
  // Deadcode last: one `git grep` per symbol is cheap but not free, so it runs over only what every
  // cheaper filter left.
  const { kept, deadcode } = await filterDeadcodeSignals(resolvedRepoPath, deduped, {
    exclude: opts.exclude,
    abort: opts.abort,
  });
  for (const signal of kept) annotateSignal(signal);
  await writeFile(scanFile, JSON.stringify(withSignals(parsed, kept)), "utf8");
  return { signals: kept, worktree, untracked, coupling, duplication, secrets, deadcode };
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
/**
 * `gh auth token` — the same credential anton already uses for `gh pr`/`gh issue` calls (see
 * git/ops.ts, git/pr.ts). stringer's `github` collector (open issues/PRs/review-todos) reads its
 * own `GITHUB_TOKEN` env var rather than shelling out to `gh`, so without this it silently logs
 * "GITHUB_TOKEN not set, skipping GitHub collector" and that whole signal source is dark — every
 * other collector still runs. Best-effort: `gh` missing or unauthenticated just means no GitHub
 * signals this scan, not a failed scan.
 *
 * Bounded by (and cancellable via) the caller's own scan deadline/signal — this lookup must not
 * outlive a scan a caller already gave up on, so it never adds its own independent wait past that.
 * `timeoutMs` is the caller's REMAINING budget, not a fresh one: a budget already exhausted by an
 * earlier step (the nested-worktree lookup) must skip the `gh` call outright rather than spawn it
 * with a zero/negative timeout, which `execFile` would read as "no timeout" and hang past the
 * scan's own deadline (anton-fj1q PR #295 review).
 */
async function githubToken(timeoutMs: number, signal?: AbortSignal): Promise<string | undefined> {
  if (timeoutMs <= 0) return undefined;
  const gh = process.env[GH_BIN_ENV] ?? "gh";
  try {
    // stringer's github collector always calls api.github.com, never an enterprise host -- so
    // without --hostname, a machine whose `gh` default host is a GHE instance would hand stringer
    // that host's token, which api.github.com rejects (or worse, silently mismatches an account).
    const { stdout } = await execFileAsync(gh, ["auth", "token", "--hostname", "github.com"], {
      timeout: Math.min(10_000, timeoutMs),
      maxBuffer: 1024 * 1024,
      signal,
    });
    const token = stdout.trim();
    return token || undefined;
  } catch (err) {
    // A caller abort must propagate, not collapse into "no token": swallowing it here would let
    // scan() spawn stringer with an already-aborted signal and then run the baseline-unwind path
    // for what should have short-circuited as cancellation (see toScanError's own AbortError check).
    const e = err as { name?: string; code?: unknown } | null;
    if (e?.name === "AbortError" || e?.code === "ABORT_ERR") throw err;
    return undefined;
  }
}

/**
 * stringer's `-e/--exclude` is a Go pflag string-slice: every value handed to it (including the
 * single comma-joined argument `scan()` builds) is parsed with `encoding/csv`, not a naive
 * `string.split(",")`. A glob with an unescaped comma -- e.g. a nested worktree checked out at a
 * path containing one -- would otherwise split into two patterns, silently truncating the exclude
 * and leaving stringer free to walk (and pay the cost of) whatever the truncated remainder names.
 * Quote only when a glob actually needs it, so every existing plain glob's argv stays byte-identical.
 */
function csvEscapeExclude(glob: string): string {
  if (!/[",\r\n]/.test(glob)) return glob;
  return `"${glob.replace(/"/g, '""')}"`;
}

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

  // Computed BEFORE the nested-worktree lookup below, not after: that lookup shells out to git and
  // must be charged against the scan's own deadline/signal like every other step, not given an
  // independent wait on top of it (anton-fj1q PR #295 review).
  const timeoutMs = scanTimeoutMs();
  const deadline = Date.now() + timeoutMs;

  // Enumerated BEFORE stringer is spawned, not after it exits: excluding a nested worktree from the
  // walk is the only fix that actually keeps it from costing anything. Filtering its signals out
  // afterward (dropWorktreeSignals, below) is too late once a large one has already run every
  // collector past its --collector-timeout budget — a collector that times out mid-walk omits its
  // REAL findings too, not just the phantom ones (anton-fj1q: a 60s budget, and 759 phantom signals
  // from one nested checkout). This snapshot is re-taken after stringer exits (below, right before
  // `readAnnotatedSignals`) and the two are unioned, so a worktree created after this lookup but
  // before stringer finishes walking still gets caught by the post-scan backstop.
  const nested = await listNestedWorktrees(opts.repoPath, {
    timeoutMs: deadline - Date.now(),
    signal: opts.signal,
  });

  const args = ["scan", opts.repoPath, "--format", "json", "-o", opts.scanFile];
  if (delta) args.push("--delta");
  // Skip build output / caches so the walk stays on source (the .next build dir alone made this scan
  // time out), and cap each collector so a runaway one can't hang the whole scan past the timeout.
  const exclude = [
    ...DEFAULT_SCAN_EXCLUDES,
    ...(Array.isArray(nested) ? nested.map((wt) => `${wt}/**`) : []),
    ...(opts.exclude ?? []),
  ];
  args.push("--exclude", exclude.map(csvEscapeExclude).join(","));
  args.push("--collector-timeout", COLLECTOR_TIMEOUT);
  // Keep stderr free of ANSI escapes so the collector-failure parse stays reliable when a TTY leaks in.
  args.push("--no-color");
  // A caller's own GITHUB_TOKEN (CI, an operator's shell) wins — `gh auth token` is only a
  // fallback for when nothing already set it, and only set when it actually resolves. Charged
  // against what's LEFT of the deadline, not the outer timeoutMs again: the nested-worktree lookup
  // above already spent part of that budget, and handing this call the full timeoutMs would let a
  // short ANTON_STRINGER_TIMEOUT_MS be exceeded by another full lookup on top of it (anton-fj1q PR
  // #295 review).
  const env = { ...process.env };
  // Tracks whichever preflight step actually ran last, so the deadline-exhaustion error below (if
  // any) names the real culprit instead of always blaming `gh auth token`: when GITHUB_TOKEN is
  // already set, or the budget is already gone before this step starts (githubToken's own
  // `timeoutMs <= 0` guard then skips the spawn entirely), `gh` is never invoked and staying pinned
  // to it points operators at the wrong CLI (PR #295 review).
  let lastPreflightStep = "the nested-worktree lookup (git worktree list)";
  if (!env.GITHUB_TOKEN) {
    const tokenBudget = deadline - Date.now();
    if (tokenBudget > 0) {
      lastPreflightStep = "the gh auth token lookup";
      const token = await githubToken(tokenBudget, opts.signal);
      if (token) env.GITHUB_TOKEN = token;
    }
  }
  // The lookup above can itself consume part of the outer deadline -- charge that against what's
  // left rather than handing stringer the full timeoutMs again, or a slow `gh auth token` lets the
  // whole scan overrun ANTON_STRINGER_TIMEOUT_MS by however long the lookup took.
  const remainingMs = deadline - Date.now();
  // execFile treats `timeout: 0` as "no timeout" (Node and Bun both), so a budget already
  // exhausted by a preflight step must reject here instead of spawning stringer uncapped. This is
  // BEFORE the try below on purpose: stringer never ran, so the baseline is untouched and doesn't
  // need unwinding -- routing it through rejectWithBaselineRestored would risk turning a harmless
  // preflight timeout into a poison error if that (unneeded) restore itself failed.
  if (remainingMs <= 0) {
    // Not toScanError -- that formatter's message says stringer was killed, but stringer was
    // never spawned here; blaming it would send an operator chasing the wrong executable.
    throw new Error(
      `${lastPreflightStep} consumed the scan's ${formatTimeout(timeoutMs)} deadline before stringer could start (no output written).`,
    );
  }
  let stderr = "";
  try {
    ({ stderr } = await execFileAsync(bin, args, {
      env,
      timeout: remainingMs,
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
    // Report the budget stringer actually ran under (remainingMs, after the token lookup's own
    // share was deducted), not the outer timeoutMs -- otherwise a slow `gh auth token` makes the
    // error claim a much longer deadline than what killed the process.
    throw await rejectWithBaselineRestored(toScanError(err, { timeoutMs: remainingMs }), unwind);
  }

  let read: Awaited<ReturnType<typeof readAnnotatedSignals>>;
  try {
    // Re-enumerated AFTER stringer exits, inside the same try as the read below: the pre-scan
    // `nested` above is a snapshot from before the walk started, so a worktree another process
    // creates while stringer runs is invisible to it — passing that stale snapshot to the post-scan
    // backstop would mean the backstop can't recognize the very race it exists to catch (anton-fj1q
    // PR #295 review). A caller abort during this second lookup must unwind the baseline exactly
    // like one during the read itself, hence sharing this try rather than its own.
    const nestedAfter = await listNestedWorktrees(opts.repoPath, {
      timeoutMs: deadline - Date.now(),
      signal: opts.signal,
    });
    // Filtered against the union of both reads, not the fresher one alone, so a worktree that
    // existed pre-scan but (for whatever reason) drops out of this second listing is still caught.
    const nestedForFilter = mergeNestedWorktrees(nested, nestedAfter);
    read = await readAnnotatedSignals(opts.scanFile, opts.repoPath, {
      exclude,
      nested: nestedForFilter,
      deadline,
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
    worktree: read.worktree,
    untracked: read.untracked,
    coupling: read.coupling,
    duplication: read.duplication,
    secrets: read.secrets,
    deadcode: read.deadcode,
    deltaState: {
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
      ...(baselineScan === undefined ? {} : { baselineScan }),
    },
    restoreBaseline: unwind,
  };
}
