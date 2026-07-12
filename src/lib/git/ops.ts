/**
 * Git + PR operations for the execute-epic job (anton-dzh.4): commit a ticket's work in the
 * worktree, push the branch, and open one PR via `gh`. The `gh` binary is injectable
 * (ANTON_GH_BIN) so tests can point it at a fake. See DESIGN.md §4/§5.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Override the GitHub CLI (tests point this at a fake that echoes a PR url). */
export const GH_BIN_ENV = "ANTON_GH_BIN";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Stage everything in the worktree and commit. Returns `{ committed: false }` when there is
 * nothing to commit (claude made no changes) — the caller decides whether that's acceptable.
 */
export async function commitAll(
  worktreePath: string,
  message: string,
): Promise<{ committed: boolean }> {
  await git(worktreePath, ["add", "-A"]);
  try {
    // Exits non-zero when there ARE staged changes → there is something to commit.
    await git(worktreePath, ["diff", "--cached", "--quiet"]);
    return { committed: false };
  } catch {
    await git(worktreePath, ["commit", "-m", message]);
    return { committed: true };
  }
}

export async function hasRemote(repoPath: string, name = "origin"): Promise<boolean> {
  try {
    await git(repoPath, ["remote", "get-url", name]);
    return true;
  } catch {
    return false;
  }
}

export async function pushBranch(repoPath: string, branch: string): Promise<void> {
  await git(repoPath, ["push", "-u", "origin", branch]);
}

/**
 * True when `branch` has local commits not yet on `origin/<branch>` — i.e. there is work to push.
 * Used by review-fix to decide whether a prior (crash/retry) fix is still unpushed even when the
 * current claude run produced no new commit. If the remote-tracking ref is unknown, assume ahead
 * (safer to attempt a no-op push than to silently skip real work).
 */
export async function branchAheadOfRemote(
  repoPath: string,
  branch: string,
  remote = "origin",
): Promise<boolean> {
  try {
    const out = await git(repoPath, ["rev-list", "--count", `${remote}/${branch}..${branch}`]);
    return Number(out.trim()) > 0;
  } catch {
    return true;
  }
}

export interface PullRequest {
  url: string;
  /** beads external-ref form: `gh-<number>` when the number is parseable, else the url. */
  ref: string;
  number?: number;
}

/**
 * Push the branch and open a PR with `gh`. Requires an `origin` remote. Parses the PR number
 * from the returned URL (…/pull/<n>). Throws a clear Error when there is no remote.
 */
export async function openPullRequest(opts: {
  repoPath: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}): Promise<PullRequest> {
  if (!(await hasRemote(opts.repoPath))) {
    throw new Error(
      `no "origin" remote in ${opts.repoPath}; cannot open a PR. Add a remote or open it manually.`,
    );
  }
  await pushBranch(opts.repoPath, opts.branch);

  const gh = process.env[GH_BIN_ENV] ?? "gh";
  const { stdout } = await execFileAsync(
    gh,
    [
      "pr",
      "create",
      "--head",
      opts.branch,
      "--base",
      opts.base,
      "--title",
      opts.title,
      "--body",
      opts.body,
    ],
    { cwd: opts.repoPath, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );

  const url = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  const m = url.match(/\/pull\/(\d+)/);
  const number = m ? Number(m[1]) : undefined;
  return { url, ref: number ? `gh-${number}` : url, number };
}
