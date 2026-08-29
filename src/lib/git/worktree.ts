/**
 * Git worktree manager (anton-dzh.2). Each autonomous run executes in an isolated worktree +
 * branch off the project's default branch; the worktree is removed when the run ends. See
 * DESIGN.md §4/§7. This module is the ONLY place anton runs `git worktree`.
 *
 * ── CONTRACT (locked — implement the bodies, keep these signatures) ──
 * The job runner + execute-epic job depend on exactly these exports.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { extraBinDirs, findOnPath, isExecutableFile } from "../bin";

const execFileAsync = promisify(execFile);

/** Allow tests / config to override where worktrees are created. Default: sibling dir of repo. */
export const WORKTREES_ROOT_ENV = "ANTON_WORKTREES_ROOT";

/** Opt out of warming: an install needing credentials anton doesn't have is worse than a cold start. */
export const WARM_ENV = "ANTON_WARM_WORKTREE";

/** Pin the exact setup command warming runs, overriding detection. Also how tests inject a fake. */
export const WARM_COMMAND_ENV = "ANTON_WARM_COMMAND";

export interface Worktree {
  /** Absolute path to the checked-out worktree. */
  path: string;
  /** The branch checked out in the worktree. */
  branch: string;
  /** Branch the worktree was created from. */
  baseBranch: string;
  /** The main repo the worktree belongs to. */
  repoPath: string;
}

/** Run a git command in `repoPath`, returning trimmed stdout. */
async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * The directory anton creates this repo's run worktrees under. Also what the reaper scopes its sweep
 * to — a checkout outside it is not anton's to judge, whatever branch it holds.
 */
export function worktreesRootFor(repoPath: string): string {
  return (
    process.env[WORKTREES_ROOT_ENV] ??
    join(dirname(repoPath), ".anton-worktrees", basenameOf(repoPath))
  );
}

/** Where a worktree for `branch` should live. Outside the main working tree to avoid bd noise. */
export function worktreePathFor(repoPath: string, branch: string): string {
  return join(worktreesRootFor(repoPath), sanitizeBranch(branch));
}

function basenameOf(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || "repo";
}

/** Branch names → filesystem-safe segment (no slashes, etc.). */
export function sanitizeBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

/**
 * Create (or reuse) an isolated worktree + branch off `baseBranch` (default: the repo's current
 * HEAD branch). Idempotent: if a worktree for `branch` already exists it is returned as-is
 * (supports crash recovery / resumable runs). `warm: true` runs project setup (deps install — see
 * {@link resolveWarmCommand}), and is a no-op when nothing is needed.
 */
export async function createWorktree(opts: {
  repoPath: string;
  branch: string;
  baseBranch?: string;
  warm?: boolean;
  /** Abort an in-flight install so an operator's kill doesn't hold the run's slot for the full warm timeout. */
  signal?: AbortSignal;
}): Promise<Worktree> {
  const { repoPath, branch, warm, signal } = opts;

  const existing = await findWorktree(repoPath, branch);
  // A registration can outlive its checkout: `git worktree list` reports an administrative record,
  // and the directory may already be gone (anton-2wvb). Reusing such a path hands a non-existent
  // cwd to `spawn`, which fails as ENOENT naming the *executable* — an error that reads as a
  // missing `claude` binary and sends debugging in entirely the wrong direction. Verify on disk.
  if (existing && existsSync(existing.path)) {
    if (warm) await warmWorktree(existing, signal);
    return existing;
  }
  // Drop the stale record so `git worktree add` below isn't rejected as "already registered".
  if (existing) await forgetStaleWorktree(repoPath, existing.path);

  const baseBranch = opts.baseBranch ?? (await currentBranch(repoPath));
  const path = worktreePathFor(repoPath, branch);
  await mkdir(dirname(path), { recursive: true });

  if (await branchExists(repoPath, branch)) {
    await git(repoPath, ["worktree", "add", path, branch]);
  } else {
    await git(repoPath, ["worktree", "add", path, "-b", branch, baseBranch]);
  }

  // Canonicalize so the path matches what `git worktree list --porcelain` reports (symlinked
  // tmp dirs on macOS otherwise make repeat lookups return a different-looking path).
  const resolvedPath = await realpath(path);
  const wt: Worktree = { path: resolvedPath, branch, baseBranch, repoPath };
  if (warm) await warmWorktree(wt, signal);
  return wt;
}

/**
 * Deregister a worktree whose directory no longer exists. `--force` twice is deliberate: the first
 * discards dirty state, the second is what lets the removal proceed on a *locked* worktree. Locked
 * entries are the reason `git worktree prune` alone is not enough — git skips prunability checks on
 * them, so a locked record whose checkout was deleted is never reported as prunable and would
 * otherwise be reused forever. Best-effort: recreation below is what actually has to succeed.
 */
async function forgetStaleWorktree(repoPath: string, path: string): Promise<void> {
  try {
    await git(repoPath, ["worktree", "remove", "--force", "--force", path]);
  } catch {
    // Fall through to prune, which clears an unlocked record whose gitdir is dangling.
  }
  try {
    await git(repoPath, ["worktree", "prune"]);
  } catch {
    // best-effort
  }
}

/** Resolve the repo's current HEAD branch, falling back to "HEAD" (detached HEAD). */
async function currentBranch(repoPath: string): Promise<string> {
  try {
    return await git(repoPath, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    return "HEAD";
  }
}

/**
 * Every local branch under `prefix/`. This is the reaper's proof that a branch still EXISTS: a run
 * row outlives the branch it names, so without it every settled run this project ever ran stays a
 * sweep candidate — and a permanent `gh` call — forever. It is also the only way branch-only residue
 * is seen at all, since a branch whose run row is gone (a recreated `anton.db`) has nothing else
 * pointing at it.
 */
export async function listBranches(repoPath: string, prefix: string): Promise<string[]> {
  const out = await git(repoPath, [
    "for-each-ref",
    "--format=%(refname:short)",
    `refs/heads/${prefix}/`,
  ]);
  return out.split("\n").filter(Boolean);
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install can pull a whole dependency tree over the network on a cold cache; a slow warm still beats
 * the first verify gate failing on missing modules.
 */
const WARM_TIMEOUT_MS = 10 * 60_000;

/**
 * Lockfile → the install that materializes it, first match wins. Detection is lockfile-driven on
 * purpose: a repo with no recognized lockfile (go, rust, python) warms to a no-op instead of anton
 * guessing at a setup command.
 *
 * Every install is FROZEN. anton commits the worktree once a ticket's checks pass, so an install
 * that resolves a fresh dependency graph would quietly land its lockfile churn in the run's PR. A
 * lockfile out of sync with package.json fails the install instead — logged, non-fatal, and the run
 * merely pays the cold start it would have paid anyway.
 */
const INSTALL_BY_LOCKFILE: ReadonlyArray<{ lockfile: string; bin: string; args: string[] }> = [
  { lockfile: "bun.lock", bin: "bun", args: ["install", "--frozen-lockfile"] },
  { lockfile: "bun.lockb", bin: "bun", args: ["install", "--frozen-lockfile"] },
  { lockfile: "pnpm-lock.yaml", bin: "pnpm", args: ["install", "--frozen-lockfile"] },
  // Berry accepts `--frozen-lockfile` as a deprecated alias of `--immutable`, so one flag covers v1 too.
  { lockfile: "yarn.lock", bin: "yarn", args: ["install", "--frozen-lockfile"] },
  { lockfile: "package-lock.json", bin: "npm", args: ["ci"] },
];

/** A resolved warm command: an absolute executable plus its argv, and a label for logs. */
export interface WarmCommand {
  file: string;
  args: string[];
  label: string;
}

/**
 * The project-setup command `worktreePath` needs, or null when there is nothing to run. Null covers
 * every "no-op when nothing is needed" case: warming turned off, no recognized lockfile, a completed
 * install already newer than the lockfile (a resumed run reusing its worktree), or no package
 * manager on the search path. Exported as the single testable seam — the shell-out itself is a
 * one-liner; `env` and `isExec` are injectable so the decision can be tested without a machine's
 * real toolchain.
 */
export function resolveWarmCommand(
  worktreePath: string,
  env: Record<string, string | undefined> = process.env,
  isExec: (p: string) => boolean = isExecutableFile,
): WarmCommand | null {
  const off = env[WARM_ENV]?.trim().toLowerCase();
  if (off === "0" || off === "off" || off === "false" || off === "no") return null;

  const pinned = env[WARM_COMMAND_ENV]?.trim();
  if (pinned) return { file: "sh", args: ["-c", pinned], label: pinned };

  // Structural guard, mirroring the claude driver: never shell out to a real package manager under
  // vitest. A test that wants the warm path pins WARM_COMMAND_ENV at a fake above.
  if (env.VITEST) return null;

  const install = INSTALL_BY_LOCKFILE.find((i) => existsSync(join(worktreePath, i.lockfile)));
  if (!install || !installNeeded(worktreePath, install.lockfile)) return null;

  // A background-launched server inherits a minimal PATH that omits where bun/pnpm live, so resolve
  // the absolute path the way every other anton spawn does (see ../bin).
  const file = findOnPath(install.bin, env.PATH ?? "", extraBinDirs(), isExec);
  if (!file) {
    console.warn(
      `[worktree] cannot warm ${worktreePath}: no '${install.bin}' on the search path (${install.lockfile} present) — ` +
        `the run's first step will pay the cold start, and fail on missing dependencies if it needs them.`,
    );
    return null;
  }
  return { file, args: [...install.args], label: `${install.bin} ${install.args.join(" ")}` };
}

/**
 * Written by {@link warmWorktree} only after an install exits 0. Living inside `node_modules` ties
 * its lifetime to the tree it vouches for: `rm -rf node_modules` takes the proof with it.
 */
const WARM_STAMP = ".anton-warm";

/**
 * True unless a COMPLETED install is on record newer than the lockfile. The stamp, not `node_modules`
 * itself, is the witness: an install killed partway (OOM, SIGKILL, dropped network) has already
 * written into `node_modules`, so its mtime is newer than the lockfile and a directory-mtime check
 * would call the half-populated tree current — surfacing later as `Cannot find module` inside a
 * supposedly pre-warmed worktree, with no further warming attempt.
 */
function installNeeded(worktreePath: string, lockfile: string): boolean {
  try {
    const warmed = statSync(join(worktreePath, "node_modules", WARM_STAMP)).mtimeMs;
    return warmed < statSync(join(worktreePath, lockfile)).mtimeMs;
  } catch {
    return true; // no stamp (fresh worktree, partial install, pre-stamp worktree) → install
  }
}

/**
 * Run project setup in the worktree so a run's first step doesn't pay cold-start cost (anton-8i5).
 * `node_modules` is gitignored, so a fresh worktree has none and the first verify gate fails as
 * `Cannot find module 'vitest/config'` — an error that reads as a broken test config rather than as
 * uninstalled dependencies.
 *
 * Best-effort by design: a failed install is logged loudly and the run continues. Warming is an
 * accelerator, not a gate — the verify gates still fail on the real error if the deps were genuinely
 * required, and an install anton can't complete (private registry, no network) must not be able to
 * lose an otherwise-good run.
 */
async function warmWorktree(wt: Worktree, signal?: AbortSignal): Promise<void> {
  const cmd = resolveWarmCommand(wt.path);
  if (!cmd) return;

  try {
    await execFileAsync(cmd.file, cmd.args, {
      cwd: wt.path,
      timeout: WARM_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      // Postinstall scripts shell out to node/git themselves; hand them the same augmented path the
      // package manager was resolved against, not the daemon's minimal one.
      env: { ...process.env, PATH: [process.env.PATH ?? "", ...extraBinDirs()].filter(Boolean).join(delimiter) },
      // An operator's kill must not be stuck behind a 10-minute install; aborting degrades into the
      // logged, non-fatal path below, exactly like a registry timeout.
      signal,
    });
    await stampWarmed(wt.path, cmd.label);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr?.trim() || e.message || String(err)).slice(-2000);
    console.warn(
      `[worktree] warming ${wt.path} with \`${cmd.label}\` failed — the run continues, but its first ` +
        `step may fail on missing dependencies: ${detail}`,
    );
  }
}

/**
 * Record that the install completed, so the next run can tell a finished tree from a half-written
 * one. Best-effort: a setup command that installs nothing into `node_modules` leaves nowhere to
 * write, and the only cost of a missing stamp is warming again.
 */
async function stampWarmed(worktreePath: string, label: string): Promise<void> {
  try {
    await writeFile(join(worktreePath, "node_modules", WARM_STAMP), `${label}\n`);
  } catch {
    // no node_modules / read-only tree → next warm re-runs the install
  }
}

/** One registered checkout, as `git worktree list --porcelain` reports it. */
export interface WorktreeRecord {
  path: string;
  /** The checked-out branch; absent for a detached or bare checkout. */
  branch?: string;
  /** Locked — by whichever tool created it. A locked checkout is never anton's to remove. */
  locked: boolean;
  /** The lock's reason when git carries one (`git worktree lock --reason`). */
  lockReason?: string;
  /** The repo's own working tree, which is never a run worktree. */
  isMain: boolean;
}

/** Every checkout git has registered for `repoPath`, main worktree first. */
export async function listWorktrees(repoPath: string): Promise<WorktreeRecord[]> {
  const out = await git(repoPath, ["worktree", "list", "--porcelain"]);
  const records: WorktreeRecord[] = [];
  for (const block of out.split(/\n\n+/)) {
    const lines = block.split("\n").filter(Boolean);
    const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (!path) continue;
    const ref = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length);
    // git writes a bare `locked` line, or `locked <reason>` when one was given.
    const lock = lines.find((l) => l === "locked" || l.startsWith("locked "));
    records.push({
      path,
      branch: ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined,
      locked: lock !== undefined,
      lockReason: lock?.slice("locked ".length).trim() || undefined,
      isMain: records.length === 0,
    });
  }
  return records;
}

/** Return the existing worktree for `branch`, or null. */
export async function findWorktree(repoPath: string, branch: string): Promise<Worktree | null> {
  const record = (await listWorktrees(repoPath)).find((w) => w.branch === branch);
  return record ? { path: record.path, branch, baseBranch: branch, repoPath } : null;
}

/** What {@link removeWorktree} actually did — the evidence a reaper's log is written from. */
export interface WorktreeRemoval {
  /**
   * True only when a checkout that WAS there is now gone. A path that was already absent reports
   * false: a report that counts it as reclaimed inflates every sweep with residue nobody removed.
   */
  removed: boolean;
  /** Why the checkout was left alone. Absent when it was removed (or was never there). */
  skipped?: string;
  branchDeleted: boolean;
}

/**
 * Whether the checkout is locked, read from the `locked` file in the admin directory its own `.git`
 * marker points at. This needs neither the repo's index nor `git worktree list`, so it is what still
 * settles the question when the listing itself is unreadable. Undefined means "cannot tell" — never
 * "not locked".
 */
async function lockedInAdminDir(wt: Worktree): Promise<boolean | undefined> {
  try {
    const marker = await readFile(join(wt.path, ".git"), "utf8");
    const gitDir = marker.match(/^gitdir:\s*(.+)\s*$/m)?.[1];
    return gitDir ? existsSync(join(resolve(gitDir), "locked")) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why `wt` must be left alone, or undefined when it is anton's to remove. Today that is exactly one
 * case: another tool locked the checkout. `git worktree remove --force` refuses a locked worktree,
 * and the orphan fallback below would then delete a directory another owner is working in — the lock
 * is precisely the statement that it must not.
 *
 * An unreadable listing erases that evidence, so for a checkout still ON DISK it fails CLOSED: the
 * lock is re-read from the admin directory, and one that can be neither proven nor ruled out is left
 * for a later pass rather than force-deleted. A path that is already gone has nothing to destroy, so
 * pruning and branch deletion still proceed — that is the moved/deleted-repo case the fallback below
 * exists to serve.
 */
async function removalBlocker(wt: Worktree): Promise<string | undefined> {
  const target = resolve(wt.path);
  const records = await listWorktrees(wt.repoPath).catch(() => null);
  if (records === null) {
    if (!existsSync(wt.path)) return undefined;
    const locked = await lockedInAdminDir(wt);
    if (locked === false) return undefined;
    return locked
      ? "locked by another owner (its lock file, read directly — git's worktree list was unreadable)"
      : "git's worktree list is unreadable, so another owner's lock cannot be ruled out";
  }
  const record = records.find((r) => resolve(r.path) === target);
  if (!record?.locked) return undefined;
  return `locked by another owner (${record.lockReason ?? "no reason given"})`;
}

/**
 * Remove the worktree (force, so dirty state is discarded) and prune. If `deleteBranch` is set,
 * also delete the branch. Safe to call when the worktree is already gone (idempotent), and a no-op
 * that REPORTS itself when the checkout is locked by another owner.
 */
export async function removeWorktree(
  wt: Worktree,
  opts?: { deleteBranch?: boolean },
): Promise<WorktreeRemoval> {
  const blocker = await removalBlocker(wt);
  if (blocker) return { removed: false, skipped: blocker, branchDeleted: false };

  const existed = existsSync(wt.path);
  if (existed) {
    try {
      await git(wt.repoPath, ["worktree", "remove", "--force", wt.path]);
    } catch {
      // The main repository may have been moved or partially deleted before anton is asked to
      // forget it. In that case git cannot remove the worktree, but the checkout is still ours if
      // its .git file points into this repo's worktree administration directory. Remove only that
      // narrowly verified orphan; never recursively delete an arbitrary path from a database row.
      try {
        const gitFile = await readFile(join(wt.path, ".git"), "utf8");
        const adminRoot = resolve(wt.repoPath, ".git", "worktrees") + sep;
        const gitDir = gitFile.match(/^gitdir:\s*(.+)\s*$/m)?.[1];
        if (gitDir && resolve(gitDir).startsWith(adminRoot)) {
          await rm(wt.path, { recursive: true, force: true });
        }
      } catch {
        // Missing/unreadable marker means ownership cannot be proven; leave it for residue
        // verification to report instead of risking user data.
      }
    }
  }

  try {
    await git(wt.repoPath, ["worktree", "prune"]);
  } catch {
    // best-effort
  }

  let branchDeleted = false;
  if (opts?.deleteBranch) {
    try {
      await git(wt.repoPath, ["branch", "-D", wt.branch]);
      branchDeleted = true;
    } catch {
      // branch already gone, or still checked out somewhere git won't let us delete from under
    }
  }
  return { removed: existed && !existsSync(wt.path), branchDeleted };
}
