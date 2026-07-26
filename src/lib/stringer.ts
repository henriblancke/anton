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
import { readFile, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

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
 * it's listed anyway as belt-and-suspenders.
 *
 * Nested build dirs are NOT covered here and cannot be -- see `discoverRepoExcludes`, which asks git
 * for them per repo. The COLLECTOR_TIMEOUT backstop above is not sufficient on its own: it bounds
 * each collector, but a tree big enough to pin every collector at its deadline still ran past the
 * 10-minute outer timeout and was SIGTERM-killed with no output.
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
 * Cap on discovered globs, so a pathological repo can't build an argv that blows ARG_MAX. Measured:
 * a 4.2 GB repo with six stale worktrees yielded 14 ignored dirs, so this is ~10x headroom.
 */
const MAX_DISCOVERED_EXCLUDES = 200;

/** Real path where possible; a path that doesn't exist yet just resolves lexically. */
async function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

/** Run git in `repoPath` and return its non-empty stdout lines. */
async function gitLines(repoPath: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.split("\n").filter(Boolean);
}

/**
 * Ask git what this repo's scan should skip (anton-84z3 follow-up). The static list above can only
 * ever cover repo-ROOT dirs, because stringer's globs are root-relative and its `**\/` prefix form
 * matches nothing (measured on a real repo: `**\/.wt/**` left 4793 todo signals, `.wt/**` left 1018).
 * Nested build output is therefore invisible to a fixed list -- the case that motivated this: six
 * stale worktree copies under `.wt/` holding 1.5 GB of nested `.next` and a 727 MB nested
 * `node_modules` that `node_modules/**` never matched, so 38,676 of the 49,166 walked files were
 * junk. Every heavy collector then pinned at its deadline and the scan blew the 10-minute timeout
 * below; excluding those dirs took the same scan to 7.1s with no collector timing out.
 *
 * git already tracks all of this, so ask it instead of guessing:
 *   - `ls-files --others --ignored --directory` -- every ignored dir at any depth, collapsed to its
 *     shallowest entry (`.wt/`, `apps/web/.next/`). Ignored content is by definition not source.
 *     Directories only: ignored *files* are cheap to walk and listing each would bloat the argv.
 *   - `worktree list` -- worktrees registered INSIDE the repo. A worktree need not be gitignored,
 *     and scanning one means re-reporting the same signals against a second copy of the tree.
 *
 * Fail-soft by design: a non-git path, a missing git, or either subcommand erroring just leaves the
 * static defaults in place -- a scan with coarser excludes beats no scan at all.
 */
export async function discoverRepoExcludes(repoPath: string): Promise<string[]> {
  const globs = new Set<string>();

  try {
    const ignored = await gitLines(repoPath, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "--no-empty-directory",
    ]);
    for (const line of ignored) {
      if (!line.endsWith("/")) continue;
      const dir = line.slice(0, -1);
      // `--directory` collapses a dir whose every entry is ignored, so a repo that ignores
      // everything would report "./" — excluding that would scan nothing at all, silently.
      if (dir === "." || dir === "") continue;
      globs.add(`${dir}/**`);
    }
  } catch {
    // Not a git repo (or no git on PATH) — the static defaults still apply.
  }

  try {
    // Canonicalize both sides: git reports canonical paths, so on macOS a repo under /var (a symlink
    // to /private/var) would otherwise look like it lives outside itself and every worktree would be
    // dropped as external. Same reason createWorktree realpaths its result.
    const root = await canonical(repoPath);
    for (const line of await gitLines(repoPath, ["worktree", "list", "--porcelain"])) {
      if (!line.startsWith("worktree ")) continue;
      const rel = relative(root, await canonical(line.slice("worktree ".length)));
      // Nested worktrees only: "" is the repo itself, ".." / absolute means it lives outside the
      // tree being scanned (anton's own run worktrees do, by design) and so is never walked.
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
      globs.add(`${rel.split(sep).join("/")}/**`);
    }
  } catch {
    // Same fail-soft rationale as above.
  }

  // stringer takes the exclude list comma-joined, so a glob containing a comma would silently split
  // into two bogus patterns. Directory names with commas are rare; drop them rather than corrupt.
  return [...globs].filter((g) => !g.includes(",")).slice(0, MAX_DISCOVERED_EXCLUDES);
}

export interface ScanResult {
  /** Absolute path to the JSON scan file written by stringer. */
  scanFile: string;
  /** Number of signals in the scan (0 means nothing to triage). */
  signalCount: number;
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
 * produced. `delta` (default true) restricts to new signals since the last scan. Throws on a
 * stringer failure (fail loud), so the job then retries/parks per the runner's policy.
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
  // Three layers, deduped: the static root-level defaults, whatever git says this repo ignores or
  // checks out as a nested worktree (the only layer that reaches nested build dirs), then caller extras.
  const discovered = await discoverRepoExcludes(opts.repoPath);
  const excludes = new Set([...DEFAULT_SCAN_EXCLUDES, ...discovered, ...(opts.exclude ?? [])]);
  args.push("--exclude", [...excludes].join(","));
  args.push("--collector-timeout", COLLECTOR_TIMEOUT);

  await execFileAsync(bin, args, {
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
  return { scanFile: opts.scanFile, signalCount };
}
