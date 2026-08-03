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
import { promisify } from "node:util";
import { readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ScanSignal } from "./scan-severity";

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

export interface ScanResult {
  /** Absolute path to the JSON scan file written by stringer. */
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

/**
 * stringer JSON is either a top-level array or an object carrying `signals`/`issues`/`results`.
 * The ONE place that shape is known: every reader takes its signals from here, so a stringer that
 * renames its envelope key can't leave the scan dispatching triage while the health record counts zero.
 */
export function extractSignals(parsed: unknown): ScanSignal[] {
  if (Array.isArray(parsed)) return parsed as ScanSignal[];
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    for (const key of ["signals", "issues", "results"]) {
      if (Array.isArray(o[key])) return o[key] as ScanSignal[];
    }
  }
  return [];
}

/**
 * Run `stringer scan <repo> --delta --format json -o <scanFile>` and return the signals it produced,
 * plus any collector that died mid-scan (stringer exits 0 either way — see
 * `parseCollectorFailures`). `delta` (default true) restricts to new signals since the last scan.
 * Throws on a stringer failure (fail loud), so the job then retries/parks per the runner's policy --
 * a deadline kill throws a distinct "timed out" error rather than stringer's misleading partial stderr.
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

  const args = ["scan", opts.repoPath, "--format", "json", "-o", opts.scanFile];
  if (opts.delta ?? true) args.push("--delta");
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

  let signals: ScanSignal[] = [];
  try {
    const raw = await readFile(opts.scanFile, "utf8");
    signals = extractSignals(JSON.parse(raw || "[]"));
  } catch {
    // No file / unparseable output means zero signals (nothing to triage).
    signals = [];
  }
  return {
    scanFile: opts.scanFile,
    signals,
    collectorFailures: parseCollectorFailures(stderr),
  };
}
