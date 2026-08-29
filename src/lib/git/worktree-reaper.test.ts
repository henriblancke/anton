/**
 * The reaper's two policies (anton-hrun.1): what a stopped run owes back, and what the janitor sweep
 * may reclaim from residue already on disk. The plans are pure, so they are asserted directly; the
 * sweep itself runs against a REAL temp repo — including a locked checkout, which is the one case
 * git refuses and anton must never force.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openPrNotice,
  planReap,
  planRunTeardown,
  reapCandidates,
  reapWorktrees,
  releaseRunWorktree,
  type ReapCandidate,
} from "./worktree-reaper";
import { createWorktree, listBranches, listWorktrees, WORKTREES_ROOT_ENV } from "./worktree";

function candidate(over: Partial<ReapCandidate> = {}): ReapCandidate {
  return { branch: "anton/anton-0oi", beadId: "anton-0oi", runLive: false, bead: "settled", ...over };
}

describe("planReap — what the janitor sweep may reclaim", () => {
  it("reaps a settled bead's worktree and branch when no open PR needs them", () => {
    const plan = planReap(candidate({ path: "/wt/anton-0oi" }), undefined);
    expect(plan).toMatchObject({ removeWorktree: true, deleteBranch: true });
    expect(plan.reason).toContain("anton-0oi is closed");
  });

  it("SKIPS a checkout locked by another owner and names the lock", () => {
    const plan = planReap(candidate({ path: "/wt/x", lock: "supacode" }), undefined);
    expect(plan).toMatchObject({ removeWorktree: false, deleteBranch: false });
    expect(plan.reason).toContain("locked by another owner (supacode)");
  });

  it("names a lock with no reason rather than reading it as unlocked", () => {
    const plan = planReap(candidate({ path: "/wt/x", lock: "" }), undefined);
    expect(plan.removeWorktree).toBe(false);
    expect(plan.reason).toContain("no reason given");
  });

  it("never touches a worktree a run is executing in", () => {
    const plan = planReap(candidate({ runLive: true }), undefined);
    expect(plan).toMatchObject({ removeWorktree: false, deleteBranch: false });
    expect(plan.reason).toContain("a run is executing on it");
  });

  it("leaves an open bead's worktree alone — the run may still resume in it", () => {
    const plan = planReap(candidate({ bead: "open" }), undefined);
    expect(plan.removeWorktree).toBe(false);
    expect(plan.reason).toContain("still open");
  });

  it("leaves a branch no bead on the board owns alone", () => {
    const plan = planReap(candidate({ bead: "unknown", beadId: undefined }), undefined);
    expect(plan.removeWorktree).toBe(false);
    expect(plan.reason).toContain("no bead on the board owns it");
  });

  it("releases the worktree but KEEPS a branch that still carries an open PR", () => {
    const plan = planReap(candidate({ path: "/wt/x" }), "it still carries open PR gh-42");
    expect(plan).toMatchObject({ removeWorktree: true, deleteBranch: false });
    expect(plan.reason).toContain("open PR gh-42");
  });
});

describe("planRunTeardown — what a stopped run owes back", () => {
  const run = { branch: "anton/anton-1ao", path: "/wt/anton-1ao", beadId: "anton-1ao" };

  it("releases the worktree on delivery, keeping the branch its PR is built on", () => {
    const plan = planRunTeardown({ ...run, status: "done", beadSettled: false }, undefined);
    expect(plan).toMatchObject({ removeWorktree: true, deleteBranch: false });
    expect(plan.reason).toContain("anton-1ao is still open");
  });

  it("releases the worktree on FAILURE too — the branch survives for the retry", () => {
    const plan = planRunTeardown({ ...run, status: "failed", beadSettled: false }, undefined);
    expect(plan).toMatchObject({ removeWorktree: true, deleteBranch: false });
  });

  it("takes the branch with it once the bead is closed or abandoned (a kill, an abandon)", () => {
    const plan = planRunTeardown({ ...run, status: "failed", beadSettled: true }, undefined);
    expect(plan).toMatchObject({ removeWorktree: true, deleteBranch: true });
    expect(plan.reason).toContain("anton-1ao is closed");
  });

  it("keeps an abandoned run's branch while an unmerged PR still points at it", () => {
    const plan = planRunTeardown(
      { ...run, status: "failed", beadSettled: true },
      "it still carries open PR gh-7",
    );
    expect(plan).toMatchObject({ removeWorktree: true, deleteBranch: false });
    expect(plan.reason).toContain("open PR gh-7");
  });

  it("keeps both for a park that resumes here — the resumed attempt continues in this worktree", () => {
    const plan = planRunTeardown({ ...run, status: "parked", beadSettled: false }, undefined);
    expect(plan).toMatchObject({ removeWorktree: false, deleteBranch: false });
    expect(plan.reason).toContain("parked and resumes here");
  });

  it("reaps a park whose bead was settled underneath it — nothing will come back to it", () => {
    const plan = planRunTeardown({ ...run, status: "parked", beadSettled: true }, undefined);
    expect(plan).toMatchObject({ removeWorktree: true, deleteBranch: true });
  });

  it("touches nothing when the run is live on another machine", () => {
    const plan = planRunTeardown(
      { ...run, status: "parked", beadSettled: true, foreign: true },
      undefined,
    );
    expect(plan).toMatchObject({ removeWorktree: false, deleteBranch: false });
    expect(plan.reason).toContain("live on another machine");
  });
});

describe("openPrNotice — a check that could not answer keeps the branch", () => {
  it("reports the open PR it found", async () => {
    const notice = await openPrNotice("/repo", "anton/x", async () => ({
      pr: { url: "u", ref: "gh-9" },
    }));
    expect(notice).toContain("gh-9");
  });

  it("returns nothing when gh confirmed there is no open PR", async () => {
    expect(await openPrNotice("/repo", "anton/x", async () => ({}))).toBeUndefined();
  });

  it("fails CLOSED when gh could not answer — a failed check is not 'no PR'", async () => {
    const notice = await openPrNotice("/repo", "anton/x", async () => ({ failed: true }));
    expect(notice).toContain("open-PR check failed");
  });

  it("fails closed on a lookup that throws outright", async () => {
    const notice = await openPrNotice("/repo", "anton/x", async () => {
      throw new Error("gh: not found");
    });
    expect(notice).toContain("open-PR check failed");
  });
});

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const suite = has("git") ? describe : describe.skip;

suite("the sweep over real residue (real git)", () => {
  let repo: string;
  let worktreesRoot: string;
  let prevRoot: string | undefined;
  const noPr = async () => ({});

  const branches = (): string[] =>
    execFileSync("git", ["-C", repo, "branch", "--format=%(refname:short)"], { encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "anton-reap-repo-")));
    worktreesRoot = realpathSync(mkdtempSync(join(tmpdir(), "anton-reap-root-")));
    prevRoot = process.env[WORKTREES_ROOT_ENV];
    process.env[WORKTREES_ROOT_ENV] = worktreesRoot;

    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "anton-test"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "# tmp\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  });

  afterAll(() => {
    if (prevRoot === undefined) delete process.env[WORKTREES_ROOT_ENV];
    else process.env[WORKTREES_ROOT_ENV] = prevRoot;
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktreesRoot, { recursive: true, force: true });
  });

  it("reclaims closed beads' checkouts and branches, and nothing else", async () => {
    const closed = await createWorktree({ repoPath: repo, branch: "anton/anton-0oi" });
    const open = await createWorktree({ repoPath: repo, branch: "anton/anton-287p" });
    const live = await createWorktree({ repoPath: repo, branch: "anton/anton-albm" });
    const locked = await createWorktree({ repoPath: repo, branch: "anton/anton-ffmw" });
    writeFileSync(join(locked.path, "theirs.txt"), "another tool's work\n");
    execFileSync("git", ["-C", repo, "worktree", "lock", "--reason", "supacode", locked.path]);

    // A branch whose checkout is long gone — the shape 9 of this repo's own stale branches had.
    execFileSync("git", ["-C", repo, "branch", "anton/anton-3n5"]);

    const settled = new Set(["anton-0oi", "anton-3n5", "anton-ffmw", "anton-albm"]);
    const candidates = reapCandidates({
      repoPath: repo,
      worktrees: await listWorktrees(repo),
      branches: await listBranches(repo, "anton"),
      runs: [
        { branch: closed.branch, worktreePath: closed.path, status: "done", epicBeadId: "anton-0oi" },
        { branch: open.branch, worktreePath: open.path, status: "parked", epicBeadId: "anton-287p" },
        { branch: live.branch, worktreePath: live.path, status: "running", epicBeadId: "anton-albm" },
        { branch: "anton/anton-3n5", worktreePath: null, status: "done", epicBeadId: "anton-3n5" },
      ],
      beadStatus: (id) => (settled.has(id) ? "settled" : "open"),
      branchPrefix: "anton",
    });

    try {
      const report = await reapWorktrees({ repoPath: repo, candidates, lookupPr: noPr });

      // Reaped: the closed bead's checkout + branch, and the branch whose checkout was already gone.
      expect(existsSync(closed.path)).toBe(false);
      expect(branches()).not.toContain("anton/anton-0oi");
      expect(branches()).not.toContain("anton/anton-3n5");
      expect(report.reaped.map((e) => e.branch).sort()).toEqual([
        "anton/anton-0oi",
        "anton/anton-3n5",
      ]);

      // Untouched: the open bead's parked run, the executing run, the locked checkout.
      expect(existsSync(open.path)).toBe(true);
      expect(existsSync(live.path)).toBe(true);
      expect(existsSync(join(locked.path, "theirs.txt"))).toBe(true);
      expect(branches()).toEqual(
        expect.arrayContaining(["anton/anton-287p", "anton/anton-albm", "anton/anton-ffmw"]),
      );

      // …and every skip says why, by name.
      const why = Object.fromEntries(report.skipped.map((e) => [e.branch, e.reason]));
      expect(why["anton/anton-287p"]).toContain("anton-287p is still open");
      expect(why["anton/anton-albm"]).toContain("a run is executing on it");
      expect(why["anton/anton-ffmw"]).toContain("locked by another owner (supacode)");
    } finally {
      execFileSync("git", ["-C", repo, "worktree", "unlock", locked.path]);
    }
  });

  it("scopes the sweep to anton's worktrees root — an agent checkout elsewhere is not a candidate", async () => {
    const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), "anton-reap-other-")));
    const outside = join(outsideRoot, "claude-worktree");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", outside, "-b", "claude/scratch"]);

    try {
      const candidates = reapCandidates({
        repoPath: repo,
        worktrees: await listWorktrees(repo),
        branches: await listBranches(repo, "anton"),
        runs: [],
        beadStatus: () => "settled",
        branchPrefix: "anton",
      });

      expect(candidates.map((c) => c.branch)).not.toContain("claude/scratch");
      expect(candidates.every((c) => c.path?.startsWith(worktreesRoot))).toBe(true);
    } finally {
      execFileSync("git", ["-C", repo, "worktree", "remove", "--force", outside]);
      execFileSync("git", ["-C", repo, "branch", "-D", "claude/scratch"]);
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("drops a settled run row whose checkout and branch are both already gone", async () => {
    const candidates = reapCandidates({
      repoPath: repo,
      worktrees: [],
      branches: [],
      // The shape every finished run leaves behind forever: the row outlives what it named.
      runs: [
        { branch: "anton/anton-old", worktreePath: "/gone/anton-old", status: "done", epicBeadId: "anton-old" },
      ],
      beadStatus: () => "settled",
      branchPrefix: "anton",
    });

    expect(candidates).toEqual([]);
  });

  it("finds a branch with no run row at all — the residue a recreated anton.db leaves", () => {
    const candidates = reapCandidates({
      repoPath: repo,
      worktrees: [],
      branches: ["anton/anton-orph"],
      runs: [],
      beadStatus: (id) => (id === "anton-orph" ? "settled" : "unknown"),
      branchPrefix: "anton",
    });

    // The bead id is derived from the branch name, which is how anton composed it in the first place.
    expect(candidates).toEqual([
      { branch: "anton/anton-orph", beadId: "anton-orph", path: undefined, lock: undefined, runLive: false, bead: "settled" },
    ]);
  });

  it("releaseRunWorktree reads the bead at teardown — an abandon that landed mid-run takes the branch", async () => {
    const wt = await createWorktree({ repoPath: repo, branch: "anton/anton-8wk" });

    const entry = await releaseRunWorktree({
      repoPath: repo,
      run: { branch: wt.branch, path: wt.path, beadId: "anton-8wk", status: "failed" },
      // The abandon closed the bead while the run it killed was still unwinding.
      isBeadSettled: async () => true,
      lookupPr: noPr,
    });

    expect(entry).toMatchObject({ worktreeRemoved: true, branchDeleted: true });
    expect(existsSync(wt.path)).toBe(false);
    expect(branches()).not.toContain("anton/anton-8wk");
  });

  it("releaseRunWorktree keeps both when the bead read fails — it never guesses 'settled'", async () => {
    const wt = await createWorktree({ repoPath: repo, branch: "anton/anton-d8f" });

    const entry = await releaseRunWorktree({
      repoPath: repo,
      run: { branch: wt.branch, path: wt.path, beadId: "anton-d8f", status: "parked" },
      isBeadSettled: async () => {
        throw new Error("bd is locked");
      },
      lookupPr: noPr,
    });

    expect(entry).toMatchObject({ worktreeRemoved: false, branchDeleted: false });
    expect(existsSync(wt.path)).toBe(true);
    expect(branches()).toContain("anton/anton-d8f");
  });
});
