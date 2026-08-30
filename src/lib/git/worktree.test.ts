/**
 * Real-git round-trip for the worktree manager (anton-dzh.2): create/warm/find/remove against a
 * temp repo. Skipped when `git` isn't installed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  createWorktree,
  findWorktree,
  listWorktrees,
  removeWorktree,
  resolveWarmCommand,
  WARM_COMMAND_ENV,
  WARM_ENV,
  withBranchLock,
  withWorktreeClaim,
  worktreeClaimHolder,
  worktreePathFor,
  WORKTREES_ROOT_ENV,
  type Worktree,
} from "./worktree";

/** Above every platform's pid_max, so `process.kill(pid, 0)` is guaranteed to report it gone. */
const DEAD_PID = 4_194_305;

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const suite = has("git") ? describe : describe.skip;

suite("worktree manager (real git)", () => {
  let repo: string;
  let worktreesRoot: string;
  let prevRoot: string | undefined;

  const listPorcelain = () =>
    execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" });

  /**
   * A `git` ahead of the real one on PATH, applying `rules` (sh, with `$FLAG` free for a one-shot
   * marker file) before delegating. How a transient git failure is made deterministic.
   */
  function gitShim(rules: string[]): { restore: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "anton-wt-shim-"));
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(dir, "git"),
      ["#!/bin/sh", `FLAG=${join(dir, "tried")}`, ...rules, `exec ${realGit} "$@"`, ""].join("\n"),
      { mode: 0o755 },
    );
    const prevPath = process.env.PATH;
    process.env.PATH = `${dir}:${prevPath ?? ""}`;
    return {
      restore: () => {
        if (prevPath === undefined) delete process.env.PATH;
        else process.env.PATH = prevPath;
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "anton-wt-repo-"));
    worktreesRoot = mkdtempSync(join(tmpdir(), "anton-wt-root-"));
    prevRoot = process.env[WORKTREES_ROOT_ENV];
    process.env[WORKTREES_ROOT_ENV] = worktreesRoot;

    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "anton-test"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "# tmp\n");
    // A lockfile in every checkout, so the warm cases below run against a worktree that really does
    // look installable — proving the vitest guard, not an absent lockfile, is what skips the install.
    writeFileSync(join(repo, "package.json"), '{ "name": "tmp", "private": true }\n');
    writeFileSync(join(repo, "bun.lock"), "{}\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  });

  afterAll(() => {
    if (prevRoot === undefined) delete process.env[WORKTREES_ROOT_ENV];
    else process.env[WORKTREES_ROOT_ENV] = prevRoot;
    if (repo) rmSync(repo, { recursive: true, force: true });
    if (worktreesRoot) rmSync(worktreesRoot, { recursive: true, force: true });
  });

  it("creates an isolated worktree on a new branch", async () => {
    const branch = "anton/run-1";
    const wt = await createWorktree({ repoPath: repo, branch });

    expect(wt.repoPath).toBe(repo);
    expect(wt.branch).toBe(branch);
    expect(existsSync(wt.path)).toBe(true);
    expect(realpathSync(wt.path)).toBe(realpathSync(worktreePathFor(repo, branch)));

    const branchList = execFileSync(
      "git",
      ["-C", repo, "branch", "--list", branch],
      { encoding: "utf8" },
    );
    expect(branchList).toMatch(branch);
  });

  it("is idempotent — calling twice returns the same worktree", async () => {
    const branch = "anton/run-2";
    const first = await createWorktree({ repoPath: repo, branch });
    const second = await createWorktree({ repoPath: repo, branch });

    expect(second.path).toBe(first.path);
    expect(existsSync(second.path)).toBe(true);
  });

  // anton-2wvb: `git worktree list` reports an administrative record, which outlives a checkout
  // deleted out from under git. Returning such a path handed a non-existent cwd to `spawn`, which
  // surfaces as ENOENT naming the *executable* — reading as a missing `claude` binary.
  it("recreates the checkout when the worktree directory was deleted (prunable record)", async () => {
    const branch = "anton/run-stale";
    const first = await createWorktree({ repoPath: repo, branch });
    rmSync(first.path, { recursive: true, force: true });
    expect(listPorcelain()).toContain("prunable");

    const second = await createWorktree({ repoPath: repo, branch });

    expect(second.path).toBe(first.path);
    expect(existsSync(second.path)).toBe(true);
  });

  // The nastier variant: git skips prunability checks on locked worktrees, so a locked record whose
  // directory is gone never reports as prunable and `git worktree prune` alone will not clear it.
  it("recreates the checkout when a locked worktree's directory was deleted", async () => {
    const branch = "anton/run-stale-locked";
    const first = await createWorktree({ repoPath: repo, branch });
    execFileSync("git", ["worktree", "lock", first.path], { cwd: repo });
    rmSync(first.path, { recursive: true, force: true });
    expect(listPorcelain()).toContain("locked");

    const second = await createWorktree({ repoPath: repo, branch });

    expect(second.path).toBe(first.path);
    expect(existsSync(second.path)).toBe(true);
  });

  // The guard the unit suite below asserts on, exercised end-to-end: `warm: true` under vitest must
  // never shell out to a real package manager, however installable the checkout looks.
  it("warm: true is a no-op under vitest even with a lockfile present", async () => {
    const branch = "anton/run-warm";
    const wt = await createWorktree({ repoPath: repo, branch, warm: true });

    expect(existsSync(join(wt.path, "bun.lock"))).toBe(true);
    expect(existsSync(join(wt.path, "node_modules"))).toBe(false);
  });

  it("warm: true runs the pinned setup command inside the worktree and stamps it complete", async () => {
    process.env[WARM_COMMAND_ENV] = "mkdir -p node_modules && echo warmed > node_modules/.warm";
    try {
      const wt = await createWorktree({ repoPath: repo, branch: "anton/run-warm-pinned", warm: true });
      expect(readFileSync(join(wt.path, "node_modules", ".warm"), "utf8").trim()).toBe("warmed");
      expect(existsSync(join(wt.path, "node_modules", ".anton-warm"))).toBe(true);
    } finally {
      delete process.env[WARM_COMMAND_ENV];
    }
  });

  // Warming is an accelerator, not a gate: an install anton can't complete must not lose the run.
  // The half-written node_modules it leaves behind must NOT be stamped — that's what stops the next
  // run from mistaking a partial install for a warm one.
  it("a failing setup command is logged, not fatal, and leaves no completion stamp", async () => {
    process.env[WARM_COMMAND_ENV] = "mkdir -p node_modules; echo 'registry unreachable' >&2; exit 3";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const wt = await createWorktree({ repoPath: repo, branch: "anton/run-warm-fails", warm: true });
      expect(existsSync(wt.path)).toBe(true);
      expect(warn.mock.calls.flat().join(" ")).toContain("registry unreachable");
      expect(existsSync(join(wt.path, "node_modules"))).toBe(true);
      expect(existsSync(join(wt.path, "node_modules", ".anton-warm"))).toBe(false);
    } finally {
      warn.mockRestore();
      delete process.env[WARM_COMMAND_ENV];
    }
  });

  // An operator's kill must not sit behind a 10-minute install holding the run's concurrency slot.
  it("an aborted install returns promptly and is non-fatal", async () => {
    process.env[WARM_COMMAND_ENV] = "sleep 600";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const aborted = new AbortController();
    aborted.abort();
    try {
      const wt = await createWorktree({
        repoPath: repo,
        branch: "anton/run-warm-aborted",
        warm: true,
        signal: aborted.signal,
      });
      expect(existsSync(wt.path)).toBe(true);
      expect(warn.mock.calls.flat().join(" ")).toContain("warming");
    } finally {
      warn.mockRestore();
      delete process.env[WARM_COMMAND_ENV];
    }
  });

  it("findWorktree returns the worktree after creation, null for unknown branch", async () => {
    const branch = "anton/run-3";
    const created = await createWorktree({ repoPath: repo, branch });

    const found = await findWorktree(repo, branch);
    expect(found).not.toBeNull();
    expect(found!.path).toBe(created.path);
    expect(found!.branch).toBe(branch);

    const missing = await findWorktree(repo, "anton/does-not-exist");
    expect(missing).toBeNull();
  });

  it("removeWorktree deletes the dir, deleteBranch removes the branch, and is idempotent", async () => {
    const branch = "anton/run-4";
    const wt = await createWorktree({ repoPath: repo, branch });
    expect(existsSync(wt.path)).toBe(true);

    const removal = await removeWorktree(wt, { deleteBranch: true });
    expect(removal).toEqual({ removed: true, branchDeleted: true });
    expect(existsSync(wt.path)).toBe(false);

    const branchList = execFileSync(
      "git",
      ["-C", repo, "branch", "--list", branch],
      { encoding: "utf8" },
    );
    expect(branchList.trim()).toBe("");

    // Idempotent: the second pass finds nothing to remove and no branch left to delete — and says
    // so, rather than counting an already-absent checkout as one it reclaimed.
    expect(await removeWorktree(wt, { deleteBranch: true })).toEqual({
      removed: false,
      branchDeleted: false,
    });
  });

  it("listWorktrees reports each checkout's branch and whether another owner locked it", async () => {
    const branch = "anton/run-listed";
    const wt = await createWorktree({ repoPath: repo, branch });
    execFileSync("git", ["-C", repo, "worktree", "lock", "--reason", "supacode", wt.path]);

    try {
      const records = await listWorktrees(repo);
      expect(records[0].isMain).toBe(true);
      const listed = records.find((r) => r.branch === branch)!;
      expect(listed.locked).toBe(true);
      expect(listed.lockReason).toBe("supacode");
      expect(records.filter((r) => r.locked && r.branch !== branch)).toEqual([]);
    } finally {
      execFileSync("git", ["-C", repo, "worktree", "unlock", wt.path]);
      await removeWorktree(wt, { deleteBranch: true });
    }
  });

  it("SKIPS a checkout another owner locked — never force-removed, and the branch survives", async () => {
    // anton-hrun.1: 5 of this repo's own leaked checkouts are locked by `supacode`. Force-removing
    // one would delete a directory another tool is working in — and `git worktree remove --force`
    // refuses it anyway, which used to drop the removal into the orphan `rm -rf` fallback.
    const branch = "anton/run-locked";
    const wt = await createWorktree({ repoPath: repo, branch });
    writeFileSync(join(wt.path, "in-progress.txt"), "another tool's work\n");
    execFileSync("git", ["-C", repo, "worktree", "lock", "--reason", "supacode", wt.path]);

    try {
      const removal = await removeWorktree(wt, { deleteBranch: true });

      expect(removal.removed).toBe(false);
      expect(removal.branchDeleted).toBe(false);
      expect(removal.skipped).toMatch(/locked by another owner \(supacode\)/);
      expect(existsSync(join(wt.path, "in-progress.txt"))).toBe(true);
      expect(
        execFileSync("git", ["-C", repo, "branch", "--list", branch], { encoding: "utf8" }).trim(),
      ).not.toBe("");
    } finally {
      execFileSync("git", ["-C", repo, "worktree", "unlock", wt.path]);
      await removeWorktree(wt, { deleteBranch: true });
    }
  });

  it("SKIPS a locked checkout even when `git worktree list` cannot be read", async () => {
    // An unreadable listing used to read as "nothing is locked": force-removal was then refused by
    // git for the lock, and the orphan fallback recursively deleted the owner's checkout anyway.
    const branch = "anton/run-locked-unlistable";
    const wt = await createWorktree({ repoPath: repo, branch });
    writeFileSync(join(wt.path, "in-progress.txt"), "another tool's work\n");
    execFileSync("git", ["-C", repo, "worktree", "lock", "--reason", "supacode", wt.path]);

    try {
      // A repoPath git can't list from — the moved/partially-deleted-repo shape. The lock is still
      // legible where git actually keeps it, in the checkout's own admin directory.
      const removal = await removeWorktree(
        { ...wt, repoPath: join(repo, "moved-away") },
        { deleteBranch: true },
      );

      expect(removal.removed).toBe(false);
      expect(removal.skipped).toMatch(/locked by another owner/);
      expect(existsSync(join(wt.path, "in-progress.txt"))).toBe(true);
    } finally {
      execFileSync("git", ["-C", repo, "worktree", "unlock", wt.path]);
      await removeWorktree(wt, { deleteBranch: true });
    }
  });

  it("SKIPS a checkout locked between the pre-check and the removal, instead of deleting it", async () => {
    // The remaining TOCTOU window: nothing is locked when the removal is decided, and another tool
    // takes the lock while `git worktree remove --force` is in flight. Git refuses that removal in
    // exactly the same words as a moved repo's, so every refusal used to fall into the orphan
    // `rm -rf` — destroying the uncommitted work the new lock exists to protect.
    const branch = "anton/run-locked-race";
    const wt = await createWorktree({ repoPath: repo, branch });
    writeFileSync(join(wt.path, "in-progress.txt"), "another tool's work\n");

    // A git that takes the lock DURING the removal it then refuses — the race, made deterministic.
    const shimDir = mkdtempSync(join(tmpdir(), "anton-wt-shim-"));
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(shimDir, "git"),
      [
        "#!/bin/sh",
        'if [ "$3" = "worktree" ] && [ "$4" = "remove" ]; then',
        `  gitdir=$(sed -n 's/^gitdir: //p' "$6/.git")`,
        `  printf 'supacode\\n' > "$gitdir/locked"`,
        '  echo "fatal: cannot remove a locked working tree" >&2',
        "  exit 1",
        "fi",
        `exec ${realGit} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const prevPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${prevPath ?? ""}`;

    try {
      const removal = await removeWorktree(wt, { deleteBranch: true });

      expect(removal.removed).toBe(false);
      expect(removal.branchDeleted).toBe(false);
      expect(removal.skipped).toMatch(/locked by another owner \(supacode\)/);
      expect(existsSync(join(wt.path, "in-progress.txt"))).toBe(true);
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      rmSync(shimDir, { recursive: true, force: true });
      execFileSync("git", ["-C", repo, "worktree", "unlock", wt.path]);
      await removeWorktree(wt, { deleteBranch: true });
    }
  });

  it("SKIPS a path git now registers to a DIFFERENT branch, however stale the caller's record", async () => {
    // The reaper decides from a `listWorktrees` snapshot and deletes by path seconds to minutes
    // later. If the path was re-registered in between, `--force` removal would take the replacement
    // checkout and its uncommitted work with it — so the association is re-read here, at removal.
    const holder = "anton/run-path-holder";
    const stale = "anton/run-path-stale";
    const wt = await createWorktree({ repoPath: repo, branch: holder });
    writeFileSync(join(wt.path, "in-progress.txt"), "the replacement's work\n");
    execFileSync("git", ["-C", repo, "branch", stale]);

    try {
      const removal = await removeWorktree(
        { path: wt.path, branch: stale, baseBranch: stale, repoPath: repo },
        { deleteBranch: true },
      );

      expect(removal.removed).toBe(false);
      expect(removal.branchDeleted).toBe(false);
      expect(removal.skipped).toBe(`git registers ${holder} at that checkout now, not ${stale}`);
      expect(existsSync(join(wt.path, "in-progress.txt"))).toBe(true);
      expect(
        execFileSync("git", ["-C", repo, "branch", "--list", holder], { encoding: "utf8" }).trim(),
      ).not.toBe("");
    } finally {
      await removeWorktree(wt, { deleteBranch: true });
      execFileSync("git", ["-C", repo, "branch", "-D", stale]);
    }
  });

  it("removes a verified orphan when the main repository metadata is gone", async () => {
    const orphanRepo = mkdtempSync(join(tmpdir(), "anton-wt-orphan-repo-"));
    const orphanPath = mkdtempSync(join(tmpdir(), "anton-wt-orphan-checkout-"));
    const branch = "anton/orphan";
    writeFileSync(
      join(orphanPath, ".git"),
      `gitdir: ${join(orphanRepo, ".git", "worktrees", "anton-orphan")}\n`,
    );
    rmSync(orphanRepo, { recursive: true, force: true });

    await removeWorktree({ path: orphanPath, branch, baseBranch: branch, repoPath: orphanRepo });

    expect(existsSync(orphanPath)).toBe(false);
  });

  it("resolves a RELATIVE gitdir against the checkout, not the process cwd", async () => {
    const orphanRepo = mkdtempSync(join(tmpdir(), "anton-wt-relative-repo-"));
    const orphanPath = mkdtempSync(join(tmpdir(), "anton-wt-relative-checkout-"));
    const admin = join(orphanRepo, ".git", "worktrees", "anton-relative");
    // Older git (and a moved repo) can leave a relative gitdir. Resolved from the process cwd it
    // points nowhere, and ownership then reads as unprovable — the orphan is never reclaimed.
    writeFileSync(join(orphanPath, ".git"), `gitdir: ${relative(orphanPath, admin)}\n`);
    rmSync(orphanRepo, { recursive: true, force: true });

    await removeWorktree({
      path: orphanPath,
      branch: "anton/relative",
      baseBranch: "anton/relative",
      repoPath: orphanRepo,
    });

    expect(existsSync(orphanPath)).toBe(false);
  });

  it("waits on the branch lock before registering a checkout — the reaper's half of the race", async () => {
    const branch = "anton/run-locked-create";
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));

    // Stand in for the sweep holding the branch while it re-reads and deletes.
    const holder = withBranchLock(repo, branch, () => held);
    const creating = createWorktree({ repoPath: repo, branch });
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(worktreePathFor(repo, branch))).toBe(false);

    release();
    await holder;
    const wt = await creating;

    expect(existsSync(wt.path)).toBe(true);
    await removeWorktree(wt, { deleteBranch: true });
  });

  it("SKIPS a path git now holds as a DETACHED checkout, which is no longer this branch's", async () => {
    // A historical run's canonical path reused by a detached checkout carries NO branch, so an
    // association re-read that only compares branch names would read it as "still ours" and let
    // `--force` delete somebody else's uncommitted work.
    const gone = "anton/run-detached-gone";
    const wt = await createWorktree({ repoPath: repo, branch: gone });
    writeFileSync(join(wt.path, "in-progress.txt"), "the replacement's work\n");
    execFileSync("git", ["-C", wt.path, "checkout", "--detach"]);

    try {
      const removal = await removeWorktree(
        { path: wt.path, branch: gone, baseBranch: gone, repoPath: repo },
        { deleteBranch: true },
      );

      expect(removal.removed).toBe(false);
      expect(removal.branchDeleted).toBe(false);
      expect(removal.skipped).toBe(
        `git registers a detached checkout at that checkout now, not ${gone}`,
      );
      expect(existsSync(join(wt.path, "in-progress.txt"))).toBe(true);
    } finally {
      execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt.path]);
      execFileSync("git", ["-C", repo, "branch", "-D", gone]);
    }
  });

  it("REFUSES to hand a claimed checkout to a second job, which would run two agents in one tree", async () => {
    // review-fix holds the claim; an execute run asking for the same branch must fail rather than
    // drive git, claude and tests over the working tree the fix is being written in.
    const branch = "anton/run-claim-reuse";
    const wt = await createWorktree({ repoPath: repo, branch });
    let done!: () => void;
    const using = new Promise<void>((r) => (done = r));
    let active!: () => void;
    const claimTaken = new Promise<void>((r) => (active = r));

    const claiming = withWorktreeClaim(repo, branch, "review-fix", () => {
      active();
      return using;
    });
    await claimTaken;

    try {
      await expect(createWorktree({ repoPath: repo, branch })).rejects.toThrow(
        /review-fix is using the checkout/,
      );
      // The holder itself still gets it: review-fix claims the branch, then materializes it.
      expect((await createWorktree({ repoPath: repo, branch, claimedBy: "review-fix" })).path).toBe(
        wt.path,
      );
    } finally {
      done();
      await claiming;
    }

    await removeWorktree(wt, { deleteBranch: true });
  });

  it("REFUSES reuse while ANOTHER anton process's claim lock is on the checkout", async () => {
    // The in-process map is empty in the second process, so the git lock is the only evidence the
    // checkout is in use — and reuse that ignores it mixes two processes' work in one directory.
    const branch = "anton/run-claim-reuse-foreign";
    const wt = await createWorktree({ repoPath: repo, branch });
    execFileSync("git", [
      "-C",
      repo,
      "worktree",
      "lock",
      "--reason",
      `anton-claim review-fix pid=${DEAD_PID} host=some-other-box`,
      wt.path,
    ]);

    try {
      await expect(createWorktree({ repoPath: repo, branch })).rejects.toThrow(
        /review-fix is using the checkout \(pid \d+ on some-other-box\)/,
      );
      // Not even its own owner may reuse it: that claim belongs to another process.
      await expect(
        createWorktree({ repoPath: repo, branch, claimedBy: "review-fix" }),
      ).rejects.toThrow(/is using the checkout/);
    } finally {
      execFileSync("git", ["-C", repo, "worktree", "unlock", wt.path]);
    }

    await removeWorktree(wt, { deleteBranch: true });
  });

  it("takes a worktree claim only under the branch lock, so a removal in flight is never overtaken", async () => {
    const branch = "anton/run-claimed";
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let done!: () => void;
    const using = new Promise<void>((r) => (done = r));

    // Stand in for a teardown that already holds the branch and is mid-removal.
    const holder = withBranchLock(repo, branch, () => held);
    const claiming = withWorktreeClaim(repo, branch, "review-fix", () => using);
    await new Promise((r) => setTimeout(r, 50));
    expect(worktreeClaimHolder(repo, branch)).toBeUndefined();

    release();
    await holder;
    await new Promise((r) => setTimeout(r, 50));
    expect(worktreeClaimHolder(repo, branch)).toBe("review-fix");

    done();
    await claiming;
    expect(worktreeClaimHolder(repo, branch)).toBeUndefined();
  });

  it("backs the claim with a real git worktree lock, so a SECOND anton process can see it", async () => {
    // The in-memory claim map is invisible across processes, and git locks nothing on its own: a
    // concurrent anton's teardown would force-remove the checkout review-fix is writing in.
    const branch = "anton/run-claim-lock";
    const wt = await createWorktree({ repoPath: repo, branch });
    writeFileSync(join(wt.path, "in-progress.txt"), "the review fix\n");
    let done!: () => void;
    const using = new Promise<void>((r) => (done = r));
    let active!: () => void;
    // `fn` runs only once the claim (map entry AND git lock) is in place, so this is exact.
    const claimTaken = new Promise<void>((r) => (active = r));

    const claiming = withWorktreeClaim(repo, branch, "review-fix", () => {
      active();
      return using;
    });
    await claimTaken;

    const locked = (await listWorktrees(repo)).find((r) => r.branch === branch);
    expect(locked?.locked).toBe(true);
    expect(locked?.lockReason).toBe(`anton-claim review-fix pid=${process.pid} host=${hostname()}`);

    // What the other process would do: removeWorktree consults git, never this process's map.
    const refused = await removeWorktree(wt, { deleteBranch: true });
    expect(refused).toMatchObject({ removed: false, branchDeleted: false });
    expect(refused.skipped).toContain("review-fix is using the checkout");
    expect(existsSync(join(wt.path, "in-progress.txt"))).toBe(true);

    done();
    await claiming;

    expect((await listWorktrees(repo)).find((r) => r.branch === branch)?.locked).toBe(false);
    expect(await removeWorktree(wt, { deleteBranch: true })).toMatchObject({ removed: true });
  });

  it("locks a checkout the claim was taken BEFORE — review-fix claims, then materializes", async () => {
    const branch = "anton/run-claim-then-create";
    let done!: () => void;
    const using = new Promise<void>((r) => (done = r));
    let created!: (wt: Worktree) => void;
    const materialized = new Promise<Worktree>((r) => (created = r));

    const claiming = withWorktreeClaim(repo, branch, "review-fix", async () => {
      // `claimedBy` is what tells createWorktree the caller IS the holder — exactly what review-fix
      // passes when it materializes the checkout it just claimed.
      created(await createWorktree({ repoPath: repo, branch, claimedBy: "review-fix" }));
      await using;
    });
    const wt = await materialized;

    expect((await listWorktrees(repo)).find((r) => r.branch === branch)?.lockReason).toContain(
      "anton-claim review-fix",
    );

    done();
    await claiming;
    await removeWorktree(wt, { deleteBranch: true });
  });

  it("BREAKS a claim lock left behind by a process that has since died", async () => {
    // A durable lock that nothing may ever break turns one crashed anton into a checkout and a
    // branch that leak forever. Only a dead claim from THIS host is broken — never another tool's.
    const branch = "anton/run-claim-crashed";
    const wt = await createWorktree({ repoPath: repo, branch });
    execFileSync("git", [
      "-C",
      repo,
      "worktree",
      "lock",
      "--reason",
      `anton-claim review-fix pid=${DEAD_PID} host=${hostname()}`,
      wt.path,
    ]);

    const removal = await removeWorktree(wt, { deleteBranch: true });

    expect(removal).toMatchObject({ removed: true, branchDeleted: true });
    expect(existsSync(wt.path)).toBe(false);
  });

  it("honours a claim lock recorded on ANOTHER host, whose pid says nothing here", async () => {
    const branch = "anton/run-claim-elsewhere";
    const wt = await createWorktree({ repoPath: repo, branch });
    execFileSync("git", [
      "-C",
      repo,
      "worktree",
      "lock",
      "--reason",
      `anton-claim review-fix pid=${DEAD_PID} host=some-other-box`,
      wt.path,
    ]);

    try {
      const removal = await removeWorktree(wt, { deleteBranch: true });
      expect(removal.removed).toBe(false);
      expect(removal.skipped).toContain("review-fix is using the checkout");
    } finally {
      execFileSync("git", ["-C", repo, "worktree", "unlock", wt.path]);
      await removeWorktree(wt, { deleteBranch: true });
    }
  });

  it("FAILS the claim when git cannot install its lock, instead of running unprotected", async () => {
    // The map entry is invisible to a second anton process: without the git lock, its teardown
    // force-removes the very checkout the claim exists to protect, uncommitted fix and all.
    const branch = "anton/run-claim-lock-fails";
    const wt = await createWorktree({ repoPath: repo, branch });
    const shim = gitShim(['if [ "$3" = "worktree" ] && [ "$4" = "lock" ]; then', "  exit 1", "fi"]);

    let ran = false;
    try {
      await expect(
        withWorktreeClaim(repo, branch, "review-fix", async () => {
          ran = true;
        }),
      ).rejects.toThrow(/could not lock/);
    } finally {
      shim.restore();
    }

    expect(ran).toBe(false);
    // The rolled-back map entry matters as much as the throw: a phantom claim would make every
    // later teardown in this process refuse the checkout forever.
    expect(worktreeClaimHolder(repo, branch)).toBeUndefined();
    await removeWorktree(wt, { deleteBranch: true });
  });

  it("REFUSES a second in-process claim on a branch NOT yet materialized (first claimant wins)", async () => {
    // Two review-fix jobs for one epic — a project sweep and gate-check's targeted fix — race the
    // same PR branch before its checkout exists. Refusing the claim itself is what keeps the fix
    // exclusive: refusing only at createWorktree would leave both holders in the map and fail BOTH.
    const branch = "anton/run-claim-second-owner";
    let done!: () => void;
    const using = new Promise<void>((r) => (done = r));
    let active!: () => void;
    const claimTaken = new Promise<void>((r) => (active = r));

    let created: Worktree | undefined;
    const claiming = withWorktreeClaim(repo, branch, "review-fix#job-a", () => {
      active();
      return using;
    });
    await claimTaken;

    try {
      await expect(
        withWorktreeClaim(repo, branch, "review-fix#job-b", async () => {}),
      ).rejects.toThrow(/review-fix#job-a is using the checkout/);
      // The refused job left nothing behind: the first holder still owns the branch outright, so it
      // materializes its own checkout as usual.
      created = await createWorktree({ repoPath: repo, branch, claimedBy: "review-fix#job-a" });
      expect(existsSync(created.path)).toBe(true);
    } finally {
      done();
      await claiming;
    }

    expect(worktreeClaimHolder(repo, branch)).toBeUndefined();
    if (created) await removeWorktree(created, { deleteBranch: true });
  });

  it("REFUSES to claim a checkout another owner has locked", async () => {
    const branch = "anton/run-claim-foreign-lock";
    const wt = await createWorktree({ repoPath: repo, branch });
    execFileSync("git", ["-C", repo, "worktree", "lock", "--reason", "supacode", wt.path]);

    await expect(withWorktreeClaim(repo, branch, "review-fix", async () => {})).rejects.toThrow(
      /locked by another owner \(supacode\)/,
    );
    expect(worktreeClaimHolder(repo, branch)).toBeUndefined();

    execFileSync("git", ["-C", repo, "worktree", "unlock", wt.path]);
    await removeWorktree(wt, { deleteBranch: true });
  });

  it("RETRIES a release git transiently refuses, so the claim is never left stranded", async () => {
    // The lock names this still-running process, so a swallowed unlock failure reads as a live claim
    // to every later reaper pass — leaking the worktree and its branch until anton restarts.
    const branch = "anton/run-claim-release-retry";
    const wt = await createWorktree({ repoPath: repo, branch });
    const shim = gitShim([
      'if [ "$3" = "worktree" ] && [ "$4" = "unlock" ] && [ ! -f "$FLAG" ]; then',
      '  touch "$FLAG"',
      "  exit 1",
      "fi",
    ]);

    try {
      await withWorktreeClaim(repo, branch, "review-fix", async () => {
        expect((await listWorktrees(repo)).find((r) => r.branch === branch)?.locked).toBe(true);
      });
    } finally {
      shim.restore();
    }

    expect((await listWorktrees(repo)).find((r) => r.branch === branch)?.locked).toBe(false);
    await removeWorktree(wt, { deleteBranch: true });
  });

  it("leaves an arbitrary directory untouched when orphan ownership cannot be proven", async () => {
    const arbitraryPath = mkdtempSync(join(tmpdir(), "anton-wt-unverified-"));
    writeFileSync(join(arbitraryPath, "keep.txt"), "user data\n");

    await removeWorktree({
      path: arbitraryPath,
      branch: "anton/unverified",
      baseBranch: "anton/unverified",
      repoPath: join(arbitraryPath, "missing-repo"),
    });

    expect(existsSync(join(arbitraryPath, "keep.txt"))).toBe(true);
    rmSync(arbitraryPath, { recursive: true, force: true });
  });
});

/**
 * Warming's whole decision (anton-8i5), tested without git and without a package manager: `env` and
 * `isExec` are injected, so these cases assert what anton WOULD run rather than running it.
 */
describe("resolveWarmCommand", () => {
  const BIN = "/fake/bin";
  /** Only the fake bin dir holds executables, so detection never picks up the host's real toolchain. */
  const isExec = (p: string) => p.startsWith(`${BIN}/`);
  const env = { PATH: BIN };
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A worktree-shaped temp dir containing `files` (name → contents). */
  function fixture(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "anton-warm-"));
    dirs.push(dir);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  }

  it("detects a frozen install per lockfile", () => {
    expect(resolveWarmCommand(fixture({ "bun.lock": "{}" }), env, isExec)).toEqual({
      file: `${BIN}/bun`,
      args: ["install", "--frozen-lockfile"],
      label: "bun install --frozen-lockfile",
    });
    expect(resolveWarmCommand(fixture({ "pnpm-lock.yaml": "" }), env, isExec)?.args).toEqual([
      "install",
      "--frozen-lockfile",
    ]);
    expect(resolveWarmCommand(fixture({ "yarn.lock": "" }), env, isExec)?.file).toBe(`${BIN}/yarn`);
    expect(resolveWarmCommand(fixture({ "package-lock.json": "{}" }), env, isExec)).toMatchObject({
      file: `${BIN}/npm`,
      args: ["ci"],
    });
  });

  it("is a no-op for a repo with no recognized lockfile", () => {
    expect(resolveWarmCommand(fixture({ "go.mod": "module tmp" }), env, isExec)).toBeNull();
  });

  /** A worktree whose deps carry a completion stamp, as a finished install leaves behind. */
  function stamped(dir: string): string {
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", ".anton-warm"), "bun install --frozen-lockfile\n");
    return dir;
  }

  // The reuse path: a resumed run gets its existing worktree back and must not reinstall.
  it("skips the install when a completed install is newer than the lockfile", () => {
    const dir = stamped(fixture({ "bun.lock": "{}" }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, "bun.lock"), old, old);

    expect(resolveWarmCommand(dir, env, isExec)).toBeNull();
  });

  it("installs again when the lockfile is newer than the completed install", () => {
    const dir = stamped(fixture({ "bun.lock": "{}" }));
    const stale = new Date(Date.now() - 60_000);
    utimesSync(join(dir, "node_modules", ".anton-warm"), stale, stale);

    expect(resolveWarmCommand(dir, env, isExec)?.file).toBe(`${BIN}/bun`);
  });

  // The partial-install trap: a killed install leaves node_modules NEWER than the lockfile, so a
  // directory-mtime check would call the half-populated tree current and hand the run broken deps.
  it("installs again when node_modules is newer but no install ever completed", () => {
    const dir = fixture({ "bun.lock": "{}" });
    mkdirSync(join(dir, "node_modules"));
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, "bun.lock"), old, old);

    expect(resolveWarmCommand(dir, env, isExec)?.file).toBe(`${BIN}/bun`);
  });

  // Structural guard: unit tests must stay deterministic and never shell out to a real installer.
  it("never detects an install under vitest", () => {
    expect(resolveWarmCommand(fixture({ "bun.lock": "{}" }), { ...env, VITEST: "true" }, isExec)).toBeNull();
  });

  it("runs the pinned command instead — including under vitest, which is how tests inject a fake", () => {
    const pinned = { ...env, VITEST: "true", [WARM_COMMAND_ENV]: "echo hi" };

    expect(resolveWarmCommand(fixture({ "bun.lock": "{}" }), pinned, isExec)).toEqual({
      file: "sh",
      args: ["-c", "echo hi"],
      label: "echo hi",
    });
  });

  it("honors the opt-out over both detection and the pinned command", () => {
    const off = { ...env, [WARM_ENV]: "off", [WARM_COMMAND_ENV]: "echo hi" };

    expect(resolveWarmCommand(fixture({ "bun.lock": "{}" }), off, isExec)).toBeNull();
  });

  it("warns and skips when the package manager isn't on the search path", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveWarmCommand(fixture({ "bun.lock": "{}" }), env, () => false)).toBeNull();
      expect(warn.mock.calls.flat().join(" ")).toContain("no 'bun' on the search path");
    } finally {
      warn.mockRestore();
    }
  });
});
