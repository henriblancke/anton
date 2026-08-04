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
import { dirname, join } from "node:path";
import { annotateSignal, type ScanSignal } from "./scan-severity";

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
  // vcs / anton's own state
  ".git/**",
  ".anton/**",
  ".beads/**",
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
  /** Which baseline this scan measured against, and which one it left (see {@link DeltaState}). */
  deltaState: DeltaState;
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
 * Put the baseline back exactly as the scan found it. Returns why it couldn't, or undefined on success.
 *
 * stringer advances `.stringer/last-scan.json` on its way out, so a scan anton then REJECTS
 * (unreadable output — see {@link readAnnotatedSignals}) has already consumed the window it failed
 * to report. Left alone, the runner's `--delta` retry measures against the ADVANCED baseline, finds
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
 */
async function rejectWithBaselineRestored(
  err: unknown,
  repoPath: string,
  baseline: BaselineSnapshot,
): Promise<unknown> {
  const problem = await restoreBaseline(repoPath, baseline);
  if (!problem) return err;
  return new Error(
    `${err instanceof Error ? err.message : String(err)}. Worse, stringer's --delta baseline could ` +
      `not be restored (${problem}): a retry will measure against the baseline this scan advanced, ` +
      `so these findings will not reappear — rescan with delta off, or reset ${DELTA_STATE_FILE}`,
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
 * charts a green point for output nobody parsed. Only the caller can say what to do about that, so
 * this returns the fact rather than deciding (see {@link readAnnotatedSignals}).
 */
export function extractSignals(parsed: unknown): ScanSignal[] | undefined {
  if (Array.isArray(parsed)) return parsed as ScanSignal[];
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    for (const key of SIGNAL_ENVELOPE_KEYS) {
      if (Array.isArray(o[key])) return o[key] as ScanSignal[];
    }
  }
  return undefined;
}

/** What the unrecognized output looked like, so an operator can tell a rename from a broken write. */
function describeShape(parsed: unknown): string {
  if (parsed === null) return "null";
  if (typeof parsed !== "object") return typeof parsed;
  const keys = Object.keys(parsed as Record<string, unknown>);
  return keys.length > 0 ? `object with keys: ${keys.join(", ")}` : "empty object";
}

/**
 * Read the scan stringer just wrote, stamp anton's derived severity onto every signal, and write it
 * back. Two guarantees ride on this one parse:
 *
 * - **Unreadable output is a failed scan, not a clean one.** stringer exits 0 having written the
 *   `-o` file even for zero new signals, so a missing or truncated file is a process-boundary
 *   failure. Reading it as "no signals" would skip triage, chart a zero-signal point, and end the
 *   session `done` — the board would report a clean scan nobody could read. So it throws, and the
 *   runner retries or parks the job. The caller unwinds the `--delta` baseline on the way out, so
 *   the retry measures the window this attempt consumed rather than the one after it.
 * - **Triage labels the signal anton counted.** stringer emits no severity of its own; annotating
 *   here means the agent reads anton's derivation off the file instead of re-deriving one from the
 *   raw fields and drifting from the trend (see {@link annotateSignal}).
 */
async function readAnnotatedSignals(scanFile: string): Promise<ScanSignal[]> {
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

  // Loud but not fatal: an unrecognized envelope is far more likely a stringer version bump than a
  // broken scan, so the pass continues on zero signals — with a line an operator can trace, instead
  // of a silently green health point.
  const extracted = extractSignals(parsed);
  if (!extracted) {
    console.warn(
      `[stringer] ${scanFile} carries no recognized signal array (${describeShape(parsed)}; ` +
        `expected a top-level array or one of ${SIGNAL_ENVELOPE_KEYS.join("/")}) — counted as zero ` +
        `signals. If stringer renamed its envelope key, this pass's clean scan is false.`,
    );
  }

  const signals = extracted ?? [];
  for (const signal of signals) annotateSignal(signal);
  await writeFile(scanFile, JSON.stringify(parsed), "utf8");
  return signals;
}

/**
 * Run `stringer scan <repo> --delta --format json -o <scanFile>` and return the signals it produced,
 * plus any collector that died mid-scan (stringer exits 0 either way — see
 * `parseCollectorFailures`) and the baseline this pass measured against (see {@link DeltaState}).
 * `delta` (default true) restricts to new signals since the last scan.
 * Throws on a stringer failure OR on output it can't read (fail loud — see
 * `readAnnotatedSignals`), so the job then retries/parks per the runner's policy; a deadline kill
 * throws a distinct "timed out" error rather than stringer's misleading partial stderr. A rejected
 * scan leaves the `--delta` baseline where it found it, so the retry rescans the same window rather
 * than the empty one this attempt advanced past (see `restoreBaseline`).
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

  const args = ["scan", opts.repoPath, "--format", "json", "-o", opts.scanFile];
  if (delta) args.push("--delta");
  // Skip build output / caches so the walk stays on source (the .next build dir alone made this scan
  // time out), and cap each collector so a runaway one can't hang the whole scan past the timeout.
  args.push("--exclude", [...DEFAULT_SCAN_EXCLUDES, ...(opts.exclude ?? [])].join(","));
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
    throw toScanError(err, { timeoutMs });
  }

  let signals: ScanSignal[];
  try {
    signals = await readAnnotatedSignals(opts.scanFile);
  } catch (err) {
    // Refusing the output means refusing the whole pass, baseline included: the retry has to see the
    // same window this attempt consumed, or its findings are lost to a clean-looking rescan.
    throw baseline ? await rejectWithBaselineRestored(err, opts.repoPath, baseline) : err;
  }

  const after = delta ? await deltaStateId(opts.repoPath) : undefined;
  return {
    scanFile: opts.scanFile,
    signals,
    collectorFailures: parseCollectorFailures(stderr),
    deltaState: { ...(before ? { before } : {}), ...(after ? { after } : {}) },
  };
}
