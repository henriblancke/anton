/**
 * The reaper's two policies (anton-hrun.1): what a stopped run owes back, and what the janitor sweep
 * may reclaim from residue already on disk. The plans are pure, so they are asserted directly; the
 * sweep itself runs against a REAL temp repo — including a locked checkout, which is the one case
 * git refuses and anton must never force.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
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
import {
  createWorktree,
  listBranches,
  listWorktrees,
  withBranchLock,
  withWorktreeClaim,
  WORKTREES_ROOT_ENV,
} from "./worktree";

/** Above every platform's pid_max, so `process.kill(pid, 0)` is guaranteed to report it gone. */
const DEAD_PID = 4_194_305;

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

  it("SKIPS a checkout another anton process has claimed, naming the job that holds it", () => {
    const lock = `anton-claim review-fix pid=${process.pid} host=${hostname()}`;
    const plan = planReap(candidate({ path: "/wt/x", lock }), undefined);
    expect(plan).toMatchObject({ removeWorktree: false, deleteBranch: false });
    expect(plan.reason).toContain("review-fix is using the checkout");
  });

  it("reclaims a checkout whose claim lock was left by a process that has since died", () => {
    // Otherwise one crashed anton leaks that checkout and its branch permanently: nothing else ever
    // breaks the lock, and every later sweep reads the leftovers as an owner still at work.
    const lock = `anton-claim review-fix pid=${DEAD_PID} host=${hostname()}`;
    const plan = planReap(candidate({ path: "/wt/x", lock }), undefined);
    expect(plan).toMatchObject({ removeWorktree: true, deleteBranch: true });
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

  it("keeps a checkout holding work the run could not roll back — the operator was sent to it", () => {
    const plan = planRunTeardown(
      { ...run, status: "failed", beadSettled: false, holdsPartialWork: true },
      undefined,
    );
    expect(plan).toMatchObject({ removeWorktree: false, deleteBranch: false });
    expect(plan.reason).toContain("could not roll back");
  });

  it("keeps that checkout even once the bead settles — removal is --force, and this is the only copy", () => {
    const plan = planRunTeardown(
      { ...run, status: "failed", beadSettled: true, holdsPartialWork: true },
      undefined,
    );
    expect(plan).toMatchObject({ removeWorktree: false, deleteBranch: false });
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

  it("reports a lock that appears AFTER planning as skipped, not as reaped", async () => {
    const wt = await createWorktree({ repoPath: repo, branch: "anton/anton-late" });
    // The candidate as planning saw it: unlocked, settled, reapable.
    const candidates = [
      { branch: wt.branch, path: wt.path, beadId: "anton-late", runLive: false, bead: "settled" as const },
    ];
    // The window this closes: another tool locks the checkout between the plan and the removal.
    execFileSync("git", ["-C", repo, "worktree", "lock", "--reason", "supacode", wt.path]);

    try {
      const report = await reapWorktrees({ repoPath: repo, candidates, lookupPr: noPr });

      expect(report.reaped).toEqual([]);
      expect(report.skipped.map((e) => e.reason)).toEqual([
        expect.stringContaining("locked by another owner (supacode)"),
      ]);
      expect(existsSync(wt.path)).toBe(true);
      expect(branches()).toContain("anton/anton-late");
    } finally {
      execFileSync("git", ["-C", repo, "worktree", "unlock", wt.path]);
      execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt.path]);
      execFileSync("git", ["-C", repo, "branch", "-D", wt.branch]);
    }
  });

  it("re-reads a candidate immediately before deleting it, and spares one that came back to life", async () => {
    const wt = await createWorktree({ repoPath: repo, branch: "anton/anton-race" });
    const candidates = [
      { branch: wt.branch, path: wt.path, beadId: "anton-race", runLive: false, bead: "settled" as const },
    ];

    try {
      const report = await reapWorktrees({
        repoPath: repo,
        candidates,
        lookupPr: noPr,
        // The window this closes: the bead was reopened and a new run checked this branch out again
        // while the per-branch `gh` lookup was in flight.
        revalidate: async () => "a run started on it during the sweep",
      });

      expect(report.reaped).toEqual([]);
      expect(report.skipped.map((e) => e.reason)).toEqual([
        expect.stringContaining("a run started on it during the sweep"),
      ]);
      expect(existsSync(wt.path)).toBe(true);
      expect(branches()).toContain("anton/anton-race");
    } finally {
      execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt.path]);
      execFileSync("git", ["-C", repo, "branch", "-D", wt.branch]);
    }
  });

  it("stops on an aborted job instead of running the remaining deletions", async () => {
    const first = await createWorktree({ repoPath: repo, branch: "anton/anton-stop1" });
    const second = await createWorktree({ repoPath: repo, branch: "anton/anton-stop2" });
    const candidates = [first, second].map((wt) => ({
      branch: wt.branch,
      path: wt.path,
      beadId: wt.branch.slice("anton/".length),
      runLive: false,
      bead: "settled" as const,
    }));
    const controller = new AbortController();

    try {
      const report = await reapWorktrees({
        repoPath: repo,
        candidates,
        // The operator's cancel (or the no-progress timeout) lands while the SECOND candidate's `gh`
        // lookup is in flight: the first candidate is already reaped and reported, and the sweep must
        // stop before the deletion the abort interrupted.
        lookupPr: async (_repo: string, branch: string) => {
          if (branch === second.branch) controller.abort();
          return {};
        },
        signal: controller.signal,
      });

      expect(report.reaped.map((e) => e.branch)).toEqual(["anton/anton-stop1"]);
      expect(report.skipped).toEqual([]);
      // The partial account must SAY it is partial: the caller turns it into a failed attempt, and a
      // sweep reported as successful strands the unjudged residue until the next daily schedule.
      expect(report.aborted).toBe(true);
      expect(existsSync(second.path)).toBe(true);
      expect(branches()).toContain("anton/anton-stop2");
    } finally {
      execFileSync("git", ["-C", repo, "worktree", "remove", "--force", second.path]);
      execFileSync("git", ["-C", repo, "branch", "-D", second.branch]);
    }
  });

  it("stops on a cancel that lands INSIDE the lock, after the re-read and before the deletion", async () => {
    const wt = await createWorktree({ repoPath: repo, branch: "anton/anton-stop3" });
    const candidates = [
      { branch: wt.branch, path: wt.path, beadId: "anton-stop3", runLive: false, bead: "settled" as const },
    ];
    const controller = new AbortController();

    try {
      const report = await reapWorktrees({
        repoPath: repo,
        candidates,
        lookupPr: noPr,
        // Waiting for the branch lock and re-reading the board are both slow, and the cancel lands
        // across them — after the last check the sweep used to make, and before the deletion.
        revalidate: async () => {
          controller.abort();
          return undefined;
        },
        signal: controller.signal,
      });

      expect(report.reaped).toEqual([]);
      expect(report.skipped.map((e) => e.reason)).toEqual([
        expect.stringContaining("the sweep was cancelled before deletion"),
      ]);
      expect(report.aborted).toBe(true);
      expect(existsSync(wt.path)).toBe(true);
      expect(branches()).toContain("anton/anton-stop3");
    } finally {
      execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt.path]);
      execFileSync("git", ["-C", repo, "branch", "-D", wt.branch]);
    }
  });

  it("holds the branch lock across the re-read and the deletion, so a starting run can't slip between", async () => {
    const wt = await createWorktree({ repoPath: repo, branch: "anton/anton-lock" });
    const candidates = [
      { branch: wt.branch, path: wt.path, beadId: "anton-lock", runLive: false, bead: "settled" as const },
    ];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    // A run that already holds the branch — the checkout it is about to create must survive.
    const holder = withBranchLock(repo, wt.branch, () => held);

    const sweeping = reapWorktrees({ repoPath: repo, candidates, lookupPr: noPr });
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(wt.path)).toBe(true);

    release();
    await holder;
    const report = await sweeping;

    expect(report.reaped.map((e) => e.branch)).toEqual([wt.branch]);
    expect(existsSync(wt.path)).toBe(false);
  });

  it("reports a branch git REFUSED to delete as skipped, never as already gone", async () => {
    const wt = await createWorktree({ repoPath: repo, branch: "anton/anton-lok" });
    // A ref lock is the everyday shape of "git would not delete it" — as is a branch checked out in
    // a worktree outside this sweep. Either way the branch survives, and a log saying it was already
    // gone would hide residue that comes back on every later sweep.
    const refLock = join(repo, ".git", "refs", "heads", "anton", "anton-lok.lock");
    writeFileSync(refLock, "");

    try {
      const report = await reapWorktrees({
        repoPath: repo,
        candidates: [
          { branch: wt.branch, path: wt.path, beadId: "anton-lok", runLive: false, bead: "settled" as const },
        ],
        lookupPr: noPr,
      });

      expect(report.reaped).toEqual([]);
      expect(report.skipped[0].reason).toContain(`branch ${wt.branch} could not be deleted`);
      expect(report.skipped[0].reason).not.toContain("already gone");
      // The half that DID happen is still recorded, so the pass's count stays true.
      expect(report.skipped[0]).toMatchObject({ worktreeRemoved: true, branchDeleted: false });
      expect(branches()).toContain("anton/anton-lok");
    } finally {
      rmSync(refLock, { force: true });
      execFileSync("git", ["-C", repo, "branch", "-D", wt.branch]);
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

  it("drops a run row's recorded path once git says another branch is checked out there", async () => {
    // A historical run's branch outlives its checkout, and the path it remembers is later reused by
    // another run. Removal is by path and `git worktree remove --force` never checks what is on it,
    // so carrying the stale path would delete the LIVE checkout — uncommitted work and all — while
    // reaping the old branch. The old row must contribute branch-only residue.
    const live = await createWorktree({ repoPath: repo, branch: "anton/anton-new" });
    execFileSync("git", ["-C", repo, "branch", "anton/anton-stale"]);

    try {
      const candidates = reapCandidates({
        repoPath: repo,
        worktrees: await listWorktrees(repo),
        branches: ["anton/anton-stale", "anton/anton-new"],
        runs: [
          // The stale row still points at what is now `anton/anton-new`'s checkout.
          { branch: "anton/anton-stale", worktreePath: live.path, status: "done", epicBeadId: "anton-stale" },
          { branch: live.branch, worktreePath: live.path, status: "done", epicBeadId: "anton-new" },
        ],
        beadStatus: () => "settled",
        branchPrefix: "anton",
      });

      const stale = candidates.find((c) => c.branch === "anton/anton-stale");
      expect(stale).toMatchObject({ beadId: "anton-stale", path: undefined });
      // The branch that actually owns the checkout keeps it — the guard drops the stale claim only.
      expect(candidates.find((c) => c.branch === live.branch)?.path).toBe(live.path);
    } finally {
      execFileSync("git", ["-C", repo, "worktree", "remove", "--force", live.path]);
      execFileSync("git", ["-C", repo, "branch", "-D", "anton/anton-new", "anton/anton-stale"]);
    }
  });

  it("keeps a run row's path when git has no record of it — the pruned orphan is still ours to reap", () => {
    const orphan = join(worktreesRoot, "anton-anton-orphan");
    const candidates = reapCandidates({
      repoPath: repo,
      worktrees: [],
      branches: ["anton/anton-orphan"],
      runs: [
        { branch: "anton/anton-orphan", worktreePath: orphan, status: "done", epicBeadId: "anton-orphan" },
      ],
      beadStatus: () => "settled",
      branchPrefix: "anton",
    });

    expect(candidates[0].path).toBe(orphan);
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

  it("releaseRunWorktree refuses a checkout a claim-holding job is still using", async () => {
    const wt = await createWorktree({ repoPath: repo, branch: "anton/anton-clm" });
    let done!: () => void;
    const fixing = new Promise<void>((r) => (done = r));
    // review-fix writes no run row, so the claim is the ONLY evidence this checkout is live.
    const claimed = withWorktreeClaim(repo, wt.branch, "review-fix", () => fixing);
    await new Promise((r) => setTimeout(r, 50));

    const teardown = () =>
      releaseRunWorktree({
        repoPath: repo,
        run: { branch: wt.branch, path: wt.path, beadId: "anton-clm", status: "done" },
        isBeadSettled: async () => true,
        lookupPr: noPr,
      });

    const refused = await teardown();
    expect(refused).toMatchObject({ outcome: "refused", worktreeRemoved: false, branchDeleted: false });
    expect(refused.reason).toContain("review-fix is using the checkout");
    expect(existsSync(wt.path)).toBe(true);
    expect(branches()).toContain("anton/anton-clm");

    done();
    await claimed;

    // The claim released, the same teardown reclaims both.
    expect(await teardown()).toMatchObject({ worktreeRemoved: true, branchDeleted: true });
    expect(existsSync(wt.path)).toBe(false);
    expect(branches()).not.toContain("anton/anton-clm");
  });

  it("releaseRunWorktree refuses when the re-read says another run took the branch", async () => {
    const wt = await createWorktree({ repoPath: repo, branch: "anton/anton-rtk" });

    const entry = await releaseRunWorktree({
      repoPath: repo,
      run: { branch: wt.branch, path: wt.path, beadId: "anton-rtk", status: "done" },
      // The bead was reopened and a new run is already checked out here — an open bead alone would
      // read as "release the checkout", so only the re-read can save it.
      isBeadSettled: async () => false,
      lookupPr: noPr,
      revalidate: async () => "another run took the branch while this one was tearing down",
    });

    expect(entry).toMatchObject({ outcome: "refused", worktreeRemoved: false, branchDeleted: false });
    expect(entry.reason).toContain("another run took the branch");
    expect(existsSync(wt.path)).toBe(true);
    expect(branches()).toContain("anton/anton-rtk");

    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt.path]);
    execFileSync("git", ["-C", repo, "branch", "-D", wt.branch]);
  });

  it("releaseRunWorktree reads the bead and the PR UNDER the branch lock, not before it", async () => {
    const wt = await createWorktree({ repoPath: repo, branch: "anton/anton-lck" });
    const reads: string[] = [];
    let release!: () => void;
    const holding = new Promise<void>((r) => (release = r));
    // A new run creating its checkout holds this same lock (see createWorktree); nothing the plan is
    // made from may be read while it does, or the plan describes a branch that has already moved on.
    const held = withBranchLock(repo, wt.branch, () => holding);
    await new Promise((r) => setTimeout(r, 50));

    const teardown = releaseRunWorktree({
      repoPath: repo,
      run: { branch: wt.branch, path: wt.path, beadId: "anton-lck", status: "done" },
      isBeadSettled: async () => {
        reads.push("bead");
        return true;
      },
      lookupPr: async () => {
        reads.push("pr");
        return {};
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(reads).toEqual([]);

    release();
    await held;
    expect(await teardown).toMatchObject({ worktreeRemoved: true, branchDeleted: true });
    expect(reads).toEqual(["bead", "pr"]);
    expect(existsSync(wt.path)).toBe(false);
  });

  it("the sweep spares a claimed checkout even when everything else says residue", async () => {
    const wt = await createWorktree({ repoPath: repo, branch: "anton/anton-clm2" });
    let done!: () => void;
    const fixing = new Promise<void>((r) => (done = r));
    const claimed = withWorktreeClaim(repo, wt.branch, "review-fix", () => fixing);
    await new Promise((r) => setTimeout(r, 50));

    try {
      const report = await reapWorktrees({
        repoPath: repo,
        candidates: [
          { branch: wt.branch, path: wt.path, beadId: "anton-clm2", runLive: false, bead: "settled" as const },
        ],
        lookupPr: noPr,
      });

      expect(report.reaped).toEqual([]);
      expect(report.skipped.map((e) => e.reason)).toEqual([
        expect.stringContaining("review-fix is using the checkout"),
      ]);
      expect(existsSync(wt.path)).toBe(true);
      expect(branches()).toContain("anton/anton-clm2");
    } finally {
      done();
      await claimed;
      execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt.path]);
      execFileSync("git", ["-C", repo, "branch", "-D", wt.branch]);
    }
  });
});
