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
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";

const execFileAsync = promisify(execFile);

/** Allow tests / config to override where worktrees are created. Default: sibling dir of repo. */
export const WORKTREES_ROOT_ENV = "ANTON_WORKTREES_ROOT";

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

/** Where a worktree for `branch` should live. Outside the main working tree to avoid bd noise. */
export function worktreePathFor(repoPath: string, branch: string): string {
  const root =
    process.env[WORKTREES_ROOT_ENV] ??
    join(dirname(repoPath), ".anton-worktrees", basenameOf(repoPath));
  return join(root, sanitizeBranch(branch));
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
 * (supports crash recovery / resumable runs). `warm: true` may run project setup (e.g. deps)
 * but must be a no-op when nothing is needed.
 */
export async function createWorktree(opts: {
  repoPath: string;
  branch: string;
  baseBranch?: string;
  warm?: boolean;
}): Promise<Worktree> {
  const { repoPath, branch, warm } = opts;

  const existing = await findWorktree(repoPath, branch);
  if (existing) {
    if (warm) await warmWorktree(existing);
    return existing;
  }

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
  if (warm) await warmWorktree(wt);
  return wt;
}

/** Resolve the repo's current HEAD branch, falling back to "HEAD" (detached HEAD). */
async function currentBranch(repoPath: string): Promise<string> {
  try {
    return await git(repoPath, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    return "HEAD";
  }
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
 * TODO(anton-dzh.2): warm the worktree with project setup (e.g. `bun install`) so the first
 * step in a run doesn't pay cold-start cost. Deliberately a no-op for now — keep this fast and
 * deterministic (tests rely on it not shelling out). Wire up real warming in a follow-up bead.
 */
async function warmWorktree(wt: Worktree): Promise<void> {
  void wt; // no-op today; the seam exists so real warming (deps install) can land in a follow-up.
}

/** Return the existing worktree for `branch`, or null. Parses `git worktree list --porcelain`. */
export async function findWorktree(repoPath: string, branch: string): Promise<Worktree | null> {
  const out = await git(repoPath, ["worktree", "list", "--porcelain"]);
  const blocks = out.split(/\n\n+/);
  const refName = `refs/heads/${branch}`;

  for (const block of blocks) {
    const lines = block.split("\n");
    const pathLine = lines.find((l) => l.startsWith("worktree "));
    const branchLine = lines.find((l) => l.startsWith("branch "));
    if (!pathLine || !branchLine) continue;
    if (branchLine.slice("branch ".length) !== refName) continue;

    const path = pathLine.slice("worktree ".length);
    return { path, branch, baseBranch: branch, repoPath };
  }
  return null;
}

/**
 * Remove the worktree (force, so dirty state is discarded) and prune. If `deleteBranch` is set,
 * also delete the branch. Safe to call when the worktree is already gone (idempotent).
 */
export async function removeWorktree(
  wt: Worktree,
  opts?: { deleteBranch?: boolean },
): Promise<void> {
  if (existsSync(wt.path)) {
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

  if (opts?.deleteBranch) {
    try {
      await git(wt.repoPath, ["branch", "-D", wt.branch]);
    } catch {
      // branch already gone
    }
  }
}
