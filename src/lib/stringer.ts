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

export interface ScanResult {
  /** Absolute path to the JSON scan file written by stringer. */
  scanFile: string;
  /** Number of signals in the scan (0 means nothing to triage). */
  signalCount: number;
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
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
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

/** stringer JSON is either a top-level array or an object carrying `signals`/`issues`. */
function countSignals(parsed: unknown): number {
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    for (const key of ["signals", "issues", "results"]) {
      if (Array.isArray(o[key])) return (o[key] as unknown[]).length;
    }
  }
  return 0;
}

/**
 * Run `stringer scan <repo> --delta --format json -o <scanFile>` and report how many signals it
 * produced, plus any collector that died mid-scan (stringer exits 0 either way — see
 * `parseCollectorFailures`). `delta` (default true) restricts to new signals since the last scan.
 * Throws on a stringer failure (fail loud), so the job then retries/parks per the runner's policy.
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

  const { stderr } = await execFileAsync(bin, args, {
    timeout: 10 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
    signal: opts.signal,
  });

  let signalCount = 0;
  try {
    const raw = await readFile(opts.scanFile, "utf8");
    signalCount = countSignals(JSON.parse(raw || "[]"));
  } catch {
    // No file / unparseable output means zero signals (nothing to triage).
    signalCount = 0;
  }
  return {
    scanFile: opts.scanFile,
    signalCount,
    collectorFailures: parseCollectorFailures(stderr ?? ""),
  };
}
