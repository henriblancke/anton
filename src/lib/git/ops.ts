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

/** Fetch refs from origin (all refs when none given). */
export async function fetchOrigin(repoPath: string, refs: string[] = []): Promise<void> {
  await git(repoPath, ["fetch", "origin", ...refs]);
}

/**
 * Resolve the freshest usable base ref for a new worktree (anton-l0h). Fetches `origin/<base>` and
 * returns `"origin/<base>"` so the job layer can branch off the remote tip. Best-effort: if the
 * repo has no `origin` remote, or the fetch fails (offline, auth, deleted ref), it logs loudly and
 * falls back to the local `<base>` so a run is never blocked on network access. Only updates the
 * remote-tracking ref — no local branch is mutated.
 */
export async function resolveFreshBase(repoPath: string, base: string): Promise<string> {
  if (!(await hasRemote(repoPath))) {
    // No origin (e.g. a local-only repo) — nothing to fetch; branch off the local base.
    return base;
  }
  const trackingRef = `refs/remotes/origin/${base}`;
  try {
    // Explicit destination refspec: a bare `git fetch origin <base>` honours origin's configured
    // fetch refspec, so in repos with a custom or missing refspec it can succeed while only
    // updating FETCH_HEAD — leaving `origin/<base>` stale or absent. Naming the destination forces
    // the remote-tracking ref to be written; `+` allows a non-fast-forward update.
    await fetchOrigin(repoPath, [`+refs/heads/${base}:${trackingRef}`]);
    // Confirm the ref actually resolves before branching a run off it (throws → fall back).
    await git(repoPath, ["rev-parse", "--verify", "--quiet", trackingRef]);
    return `origin/${base}`;
  } catch (e) {
    console.warn(
      `[git] fetch of origin/${base} in ${repoPath} failed; falling back to local ${base}`,
      e,
    );
    return base;
  }
}

/**
 * Merge `ref` into the branch checked out in `worktreePath`. A conflicted merge is left in
 * progress (markers in the tree, MERGE_HEAD set) and the conflicted paths are returned — the
 * caller has claude resolve the markers and a later `commitAll` concludes the merge. A merge that
 * fails for any other reason (e.g. untracked files in the way) is aborted and rethrown.
 */
export async function mergeIntoCurrent(
  worktreePath: string,
  ref: string,
  opts?: { ffOnly?: boolean },
): Promise<{ ok: boolean; conflicts: string[] }> {
  try {
    await git(worktreePath, ["merge", "--no-edit", ...(opts?.ffOnly ? ["--ff-only"] : []), ref]);
    return { ok: true, conflicts: [] };
  } catch (e) {
    const out = await git(worktreePath, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
    const conflicts = out.split("\n").map((l) => l.trim()).filter(Boolean);
    if (conflicts.length === 0) {
      await git(worktreePath, ["merge", "--abort"]).catch(() => {});
      throw e;
    }
    return { ok: false, conflicts };
  }
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

function prFromUrl(url: string): PullRequest {
  const m = url.match(/\/pull\/(\d+)/);
  const number = m ? Number(m[1]) : undefined;
  return { url, ref: number ? `gh-${number}` : url, number };
}

/**
 * Return the open PR already tracking `branch`, or undefined if there is none. Idempotency guard
 * for openPullRequest: a resumed execute-epic run re-reaches the PR step against a branch whose PR
 * already exists (the first run opened it), and `gh pr create` would otherwise error.
 */
async function findOpenPullRequest(
  repoPath: string,
  branch: string,
): Promise<PullRequest | undefined> {
  const gh = process.env[GH_BIN_ENV] ?? "gh";
  try {
    const { stdout } = await execFileAsync(
      gh,
      ["pr", "view", branch, "--json", "url,number,state"],
      { cwd: repoPath, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const pr = JSON.parse(stdout) as { url?: string; number?: number; state?: string };
    // `gh pr view <branch>` resolves the PR for that head branch; only reuse an OPEN one.
    if (!pr?.url || (pr.state && pr.state !== "OPEN")) return undefined;
    return { url: pr.url, ref: pr.number ? `gh-${pr.number}` : pr.url, number: pr.number };
  } catch {
    // No PR for the branch (gh exits non-zero) → nothing to reuse.
    return undefined;
  }
}

/** Lifecycle state of a GitHub PR, plus `unknown` when it can't be read (no remote/gh error). */
export type PullRequestState = "open" | "merged" | "closed" | "unknown";

/**
 * Report the lifecycle state of the PR named by a beads external ref (`gh-<n>`, a bare number, or
 * a PR url). Returns `"unknown"` when the state can't be determined — no `gh`, a network/CLI error,
 * or an unparseable ref — so callers can fail closed rather than mistake a transient failure for a
 * definitive state.
 *
 * Used by execute-epic to tell a STALE ref (a PR that was closed WITHOUT merging — which review-fix
 * deliberately leaves on the bead so a Run/Force run can recover the epic) apart from a ref that
 * proves another run already finished the epic (its PR is open or merged) (anton-jz1).
 */
export async function pullRequestState(
  repoPath: string,
  ref: string,
): Promise<PullRequestState> {
  // `gh pr view` accepts a number or url; `gh-<n>` is the beads form, so strip the prefix.
  const selector = ref.startsWith("gh-") ? ref.slice(3) : ref;
  if (!selector) return "unknown";
  const gh = process.env[GH_BIN_ENV] ?? "gh";
  try {
    const { stdout } = await execFileAsync(gh, ["pr", "view", selector, "--json", "state"], {
      cwd: repoPath,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    // gh reports state as OPEN | CLOSED | MERGED (a closed-then-merged PR reports MERGED).
    const state = (JSON.parse(stdout) as { state?: string }).state?.toUpperCase();
    if (state === "OPEN") return "open";
    if (state === "MERGED") return "merged";
    if (state === "CLOSED") return "closed";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Push the branch and open a PR with `gh`. Requires an `origin` remote. Parses the PR number
 * from the returned URL (…/pull/<n>). Throws a clear Error when there is no remote.
 *
 * Idempotent: if an open PR already tracks the branch (a resumed run that re-reaches this step),
 * the branch is still pushed (to carry any new commits) and the existing PR is reused instead of
 * calling `gh pr create`, which would error on a duplicate.
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

  const existing = await findOpenPullRequest(opts.repoPath, opts.branch);
  if (existing) return existing;

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
  return prFromUrl(url);
}
