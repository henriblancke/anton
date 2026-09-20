/**
 * anton-5bpd — {@link warmRunWorktree} pins the commit the branch forked from at worktree CREATION,
 * and a resume REUSES that pin rather than recomputing (PR #238 review).
 *
 * The bug it forecloses: dispatch partitions the run's tickets against `<fork>..HEAD`. Recomputed
 * with `merge-base <base> HEAD`, the base is `origin/<base>` — a ref a sibling run's fetch can rewind
 * behind the true fork point, widening the delta into pre-fork history where an old `<id>:` commit
 * reads as this run's delivery. Resolving once when the ref is fresh and persisting it is what keeps
 * every ticket (and every resume) measured against the commit the checkout was actually cut from.
 *
 * Mocked at the git seam: creation and fork resolution are the calls under test, and a real repo
 * can't be rewound on demand. The runs table is real, so the persist/read round-trip is exercised.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "../db/testing";
import * as schema from "../db/schema";
import type { Bead } from "../beads/bd";

const createWorktreeMock = vi.fn();
const acquireClaimMock = vi.fn<(...a: unknown[]) => Promise<void>>();
const releaseClaimMock = vi.fn<(...a: unknown[]) => Promise<void>>();
const removeWorktreeMock = vi.fn();
const updateRunMock = vi.fn();
const getRunBaseForkShaMock = vi.fn();
const findRunBaseForkShaForBranchMock = vi.fn();
const branchExistsMock = vi.fn<(...a: unknown[]) => Promise<boolean>>();
vi.mock("../git/worktree", async () => {
  const actual = await vi.importActual<typeof import("../git/worktree")>("../git/worktree");
  return {
    ...actual,
    acquireWorktreeClaim: (...a: unknown[]) => acquireClaimMock(...a),
    releaseWorktreeClaim: (...a: unknown[]) => releaseClaimMock(...a),
    removeWorktree: (...a: unknown[]) => removeWorktreeMock(...a),
    createWorktree: (...a: unknown[]) => createWorktreeMock(...a),
    branchExists: (...a: unknown[]) => branchExistsMock(...a),
  };
});

const resolveFreshBaseMock = vi.fn();
const resolveForkPointMock = vi.fn();
const isAncestorMock = vi.fn<(...a: unknown[]) => Promise<boolean>>();
const resolveCommitShaMock = vi.fn<(...a: unknown[]) => Promise<string>>();
const commitParentShasMock = vi.fn<(...a: unknown[]) => Promise<string[]>>();
const gitMock = vi.fn<(...a: unknown[]) => Promise<string>>();
vi.mock("../git/ops", async () => {
  const actual = await vi.importActual<typeof import("../git/ops")>("../git/ops");
  return {
    ...actual,
    resolveFreshBase: (...a: unknown[]) => resolveFreshBaseMock(...a),
    resolveForkPoint: (...a: unknown[]) => resolveForkPointMock(...a),
    isAncestor: (...a: unknown[]) => isAncestorMock(...a),
    resolveCommitSha: (...a: unknown[]) => resolveCommitShaMock(...a),
    commitParentShas: (...a: unknown[]) => commitParentShasMock(...a),
    git: (...a: unknown[]) => gitMock(...a),
  };
});

vi.mock("../runs", async () => {
  const actual = await vi.importActual<typeof import("../runs")>("../runs");
  return {
    ...actual,
    getRunBaseForkSha: (...a: unknown[]) => getRunBaseForkShaMock(...a),
    findRunBaseForkShaForBranch: (...a: unknown[]) => findRunBaseForkShaForBranchMock(...a),
    updateRun: (...a: unknown[]) => updateRunMock(...a),
  };
});

const { warmRunWorktree } = await import("./execute-epic-claim");
const actualRuns = await vi.importActual<typeof import("../runs")>("../runs");
const { createRun, getRunBaseForkSha } = actualRuns;
import type { EpicRun } from "./execute-epic-run";
import type { Clock } from "./queue";

let t: TestDb;
const PROJECT = "p1";
const RUN_ID = "run-1";
const EPIC = "anton-abc";
const BRANCH = "anton/anton-abc";
const WORKTREE = "/tmp/wt";
const FRESH_BASE = "origin/main";
const clock: Clock = { now: () => 1_800_000_000_000 };

function makeRun(runId = RUN_ID, overrides: Partial<EpicRun> = {}): EpicRun {
  return {
    db: t.db,
    clock,
    ctx: { signal: new AbortController().signal, heartbeat: vi.fn(async () => {}), report: vi.fn(), attempt: 1 },
    projectId: PROJECT,
    repo: "/repo",
    runId,
    branch: BRANCH,
    targetId: EPIC,
    project: { defaultBranch: "main" },
    settings: {},
    lease: { assertHeld: () => {} },
    target: { id: EPIC, title: EPIC } as Bead,
    tickets: [],
    ...overrides,
  } as unknown as EpicRun;
}

beforeEach(async () => {
  t = makeTestDb();
  await t.db.insert(schema.projects).values({ id: PROJECT, slug: "p1", name: "P1", repoPath: "/repo" });
  await createRun(t.db, clock, { id: RUN_ID, projectId: PROJECT, epicBeadId: EPIC });
  createWorktreeMock.mockReset().mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: true,
    repoPath: "/repo",
  });
  acquireClaimMock.mockReset().mockResolvedValue(undefined);
  releaseClaimMock.mockReset().mockResolvedValue(undefined);
  removeWorktreeMock.mockReset().mockResolvedValue({ removed: true, branchDeleted: true });
  getRunBaseForkShaMock.mockReset().mockImplementation(actualRuns.getRunBaseForkSha);
  findRunBaseForkShaForBranchMock.mockReset().mockImplementation(actualRuns.findRunBaseForkShaForBranch);
  updateRunMock.mockReset().mockImplementation(actualRuns.updateRun);
  resolveFreshBaseMock.mockReset().mockResolvedValue({ ref: FRESH_BASE, baseIsAuthoritative: true });
  resolveForkPointMock.mockReset().mockResolvedValue("f0f0f0forkcommit");
  // Ordinary forward motion by default — the freshly-resolved base still descends from whatever
  // fallback base an already-shipped claim would be checked against (PR #279 review). The one test
  // that means to exercise a rewritten-behind fallback overrides this itself.
  isAncestorMock.mockReset().mockResolvedValue(true);
  resolveCommitShaMock.mockReset();
  commitParentShasMock.mockReset();
  gitMock.mockReset();
  // The branch is present by default; the branch-deleted regression test overrides this itself.
  branchExistsMock.mockReset().mockResolvedValue(true);
});
afterEach(() => t.close());

it("pins the fork commit against the freshly-fetched base on a first creation", async () => {
  const { runStep } = await warmRunWorktree(makeRun());

  expect(resolveForkPointMock).toHaveBeenCalledExactlyOnceWith(WORKTREE, FRESH_BASE);
  expect(runStep.baseForkSha).toBe("f0f0f0forkcommit");
  // Persisted, so the resume below can read it back.
  expect(await getRunBaseForkSha(t.db, RUN_ID)).toBe("f0f0f0forkcommit");
});

it("marks the base authoritative when the repo has no origin remote, even though resolveFreshBase falls back to the local branch name (PR #279 review, sixth round)", async () => {
  // No origin at all — resolveFreshBase's fallback here isn't a possibly-stale fetch failure, it's
  // the ONLY source of truth this repo has, so a rewind behind the branch's fork point must be
  // treated as authoritative rather than lumped in with the failed-fetch case. `resolveFreshBase`
  // itself is what decides this now (PR #279 review, P1) — the caller no longer re-probes
  // `hasRemote` on its own to derive it.
  resolveFreshBaseMock.mockResolvedValue({ ref: "main", baseIsAuthoritative: true });

  await warmRunWorktree(makeRun());

  expect(createWorktreeMock).toHaveBeenLastCalledWith(
    expect.objectContaining({ baseIsAuthoritative: true }),
  );
});

it("leaves the base non-authoritative when origin exists but the fetch just failed", async () => {
  resolveFreshBaseMock.mockResolvedValue({ ref: "main", baseIsAuthoritative: false });

  await warmRunWorktree(makeRun());

  expect(createWorktreeMock).toHaveBeenLastCalledWith(
    expect.objectContaining({ baseIsAuthoritative: false }),
  );
});

it("propagates a creation failure when the locked reuse detection cannot inspect refs", async () => {
  createWorktreeMock.mockRejectedValue(new Error("ref database unavailable"));

  await expect(warmRunWorktree(makeRun())).rejects.toThrow("ref database unavailable");
});

it("reuses the pinned fork on resume instead of recomputing over a moved HEAD", async () => {
  // A prior attempt already pinned the true fork; the base has since rewound, so recomputing now
  // would answer behind it. The resume must read the stored value and never call the resolver.
  await actualRuns.updateRun(t.db, clock, RUN_ID, { baseForkSha: "trueforkcommit" });
  resolveForkPointMock.mockRejectedValue(new Error("resolver must not run on resume"));

  const { runStep } = await warmRunWorktree(makeRun());

  expect(resolveForkPointMock).not.toHaveBeenCalled();
  expect(runStep.baseForkSha).toBe("trueforkcommit");
});

it("recovers the BRANCH's pin when an ordinary failure retried onto a fresh run row (PR #238 review)", async () => {
  // An ordinary handler error settles the row `failed`, so `findOpenRunForEpic` returns nothing and
  // the retry opens a FRESH row over the SAME branch and worktree. Keyed by run id alone it would
  // find no pin and recompute against a base a sibling fetch may have rewound since — the exact
  // widening the pin exists to prevent.
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "trueforkcommit",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
  });
  resolveForkPointMock.mockRejectedValue(new Error("resolver must not run over a reused branch"));

  const { runStep } = await warmRunWorktree(makeRun(RETRY));

  expect(resolveForkPointMock).not.toHaveBeenCalled();
  expect(runStep.baseForkSha).toBe("trueforkcommit");
});

it("resolves its OWN fork point when it just created the branch, ignoring another branch's pin", async () => {
  // A run standing on a branch it cut itself forks HERE, at the freshly-fetched base. A pin from an
  // earlier run of the same epic on a DIFFERENT branch describes a checkout this one does not share.
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "oldbranchfork",
    branch: "anton/old",
    status: "failed",
  });
  const FRESH = "run-3";
  await createRun(t.db, clock, { id: FRESH, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: true,
    repoPath: "/repo",
  });

  const { runStep } = await warmRunWorktree(makeRun(FRESH));

  expect(resolveForkPointMock).toHaveBeenCalledExactlyOnceWith(WORKTREE, FRESH_BASE);
  expect(runStep.baseForkSha).toBe("f0f0f0forkcommit");
  expect(await getRunBaseForkSha(t.db, FRESH)).toBe("f0f0f0forkcommit");
});

it("replaces a deleted checkout's stale fork pin with the recreated branch's creation fork", async () => {
  // A parked run can retain its row after an operator deletes its checkout and branch. This next
  // attempt is a new branch, so the old pin no longer describes its history and must be overwritten.
  await actualRuns.updateRun(t.db, clock, RUN_ID, { baseForkSha: "deleted-checkout-fork" });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: true,
    repoPath: "/repo",
    forkSha: "recreated-branch-fork",
  });
  resolveForkPointMock.mockRejectedValue(new Error("resolver must not run when the checkout returned its own fork"));

  const { runStep } = await warmRunWorktree(makeRun());

  expect(resolveForkPointMock).not.toHaveBeenCalled();
  expect(runStep.baseForkSha).toBe("recreated-branch-fork");
  expect(await getRunBaseForkSha(t.db, RUN_ID)).toBe("recreated-branch-fork");
});

it("ignores a reused checkout's forkSha — it reads the branch's current HEAD, not the fork (PR #238 review)", async () => {
  // The locked checkout operation reports `createdBranch: false`, and the branch carries prior-
  // attempt commits, so its `forkSha` is the branch's current HEAD rather than its fork.
  // Preferring it would partition this run against `<HEAD>..HEAD>` (dropping every already-committed
  // ticket); the recovered pin — another attempt's row on the same branch — has to win instead.
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "trueforkcommit",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
    // The reused checkout's own HEAD — the branch tip with prior-attempt commits on it.
    forkSha: "head-of-reused-branch",
  });
  resolveForkPointMock.mockRejectedValue(new Error("resolver must not run when a recovered fork exists"));

  const { runStep } = await warmRunWorktree(makeRun(RETRY));

  expect(resolveForkPointMock).not.toHaveBeenCalled();
  expect(runStep.baseForkSha).toBe("trueforkcommit");
});

it("removes a newly created checkout and branch when fork-pin persistence fails", async () => {
  updateRunMock.mockRejectedValueOnce(new Error("database unavailable"));

  await expect(warmRunWorktree(makeRun())).rejects.toThrow("database unavailable");

  expect(releaseClaimMock).toHaveBeenCalledWith("/repo", BRANCH, "execute-epic#run-1");
  expect(removeWorktreeMock).toHaveBeenCalledWith(
    expect.objectContaining({ path: WORKTREE, branch: BRANCH }),
    { deleteBranch: true },
  );
});

it("removes a fresh checkout and branch when reading its fork pin fails", async () => {
  getRunBaseForkShaMock.mockRejectedValueOnce(new Error("database unavailable"));

  await expect(warmRunWorktree(makeRun())).rejects.toThrow("database unavailable");

  expect(releaseClaimMock).toHaveBeenCalledWith("/repo", BRANCH, "execute-epic#run-1");
  expect(removeWorktreeMock).toHaveBeenCalledWith(
    expect.objectContaining({ path: WORKTREE, branch: BRANCH }),
    { deleteBranch: true },
  );
});

it("preserves a reused checkout and branch when fork-pin persistence fails", async () => {
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
  });
  updateRunMock.mockRejectedValueOnce(new Error("database unavailable"));

  await expect(warmRunWorktree(makeRun())).rejects.toThrow("database unavailable");

  expect(releaseClaimMock).not.toHaveBeenCalled();
  expect(removeWorktreeMock).not.toHaveBeenCalled();
});

it("pins alreadyShippedBase to baseForkSha on a fresh creation — nothing to refresh", async () => {
  const { runStep } = await warmRunWorktree(makeRun());

  expect(runStep.alreadyShippedBase).toBe(runStep.baseForkSha);
});

it("falls back to the frozen baseForkSha, not the mutable freshBase ref, on a fresh creation once ancestry genuinely diverges (PR #279 review)", async () => {
  // A fresh creation never runs a refresh, so `refreshOutcome` is undefined and `pinnedBase` must
  // fall back to something. `freshBase` here is `origin/main` — a REF NAME, not a resolved commit —
  // so passing it straight through re-resolves against whatever `origin/main` points to at the
  // instant `isAncestor` runs, not what it pointed to when this attempt started. A sibling run's
  // force-fetch during `warmWorktreeBestEffort` (which runs for minutes) can rewrite that ref in
  // between, letting a stale re-resolution stand in for the checkout's actual, frozen fork. Forcing
  // the ancestor check to fail both ways (the shape a genuine divergence — or a rewritten ref caught
  // mid-flight — leaves) proves the fallback is the frozen `baseForkSha`, never the bare ref.
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: true,
    repoPath: "/repo",
    forkSha: "creation-fork-sha",
  });
  isAncestorMock.mockResolvedValue(false);

  const { runStep } = await warmRunWorktree(makeRun());

  expect(runStep.baseForkSha).toBe("creation-fork-sha");
  expect(runStep.alreadyShippedBase).toBe("creation-fork-sha");
});

it("ignores a stale branch-scoped refresh record on a freshly RECREATED checkout, using its own fork instead (PR #279 review)", async () => {
  // An earlier attempt refreshed this branch onto `stale-recorded-base` and recorded it on its row
  // (now dead — an operator deleted the checkout and branch after it parked). This attempt's
  // `createWorktree` therefore creates a brand-new branch, forked straight off the fresh base — it
  // shares none of the deleted checkout's history. `priorEffectiveRefreshSha` is read from the DEAD
  // row's branch-scoped record, not from the checkout, so it still resolves to the stale value; using
  // it here would check a truthful already-shipped claim against a commit the recreated branch never
  // had, since the old base normally remains an ancestor of the fresh one and the ancestor guard below
  // would accept it rather than catch it.
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseRefreshOutcome: "merged",
    baseRefreshSha: "stale-recorded-base",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockImplementation(async (opts: { beforeCreate?: (createdBranch: boolean) => Promise<void> }) => {
    await opts.beforeCreate?.(true);
    return {
      path: WORKTREE,
      branch: BRANCH,
      baseBranch: FRESH_BASE,
      createdBranch: true,
      repoPath: "/repo",
      forkSha: "recreated-branch-fork",
    };
  });

  const { runStep } = await warmRunWorktree(makeRun(RETRY));

  expect(runStep.baseForkSha).toBe("recreated-branch-fork");
  expect(runStep.alreadyShippedBase).toBe("recreated-branch-fork");
});

it("clears a stale refresh record on its own row when its branch is recreated (PR #279 review)", async () => {
  // This run's row already recorded an effective refresh from an earlier attempt (a reused checkout
  // brought onto `stale-recorded-base`). Before this attempt, that checkout and branch were deleted
  // and this call's `createWorktree` cuts a brand-new branch straight off the fresh base — nothing
  // ran a refresh this time, so `refreshOutcome` is undefined and there is nothing fresh to record.
  // Leaving the row's old pair in place would let a later `findRunBaseRefreshShaForBranch` on this
  // branch prefer that stale boundary over the recreated branch's own fork as the next refresh's
  // `--onto` boundary, replaying whatever the deletion/recreation dropped. A tombstone is written
  // rather than a plain null (anton-nyz1v, PR #279 review, fifth round) — see
  // `BRANCH_RECREATED_REFRESH_TOMBSTONE`'s own doc comment for why a plain null can't do this job.
  // Written via `beforeCreate`, BEFORE `createWorktree` resolves (PR #279 review, P1 re-review) — the
  // mock invokes it itself, mirroring how the real `createWorktree` fires it ahead of `git worktree
  // add -b` so the tombstone lands before the branch can exist to survive a crash.
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseRefreshOutcome: "merged",
    baseRefreshSha: "stale-recorded-base",
    branch: BRANCH,
  });
  createWorktreeMock.mockImplementation(async (opts: { beforeCreate?: (createdBranch: boolean) => Promise<void> }) => {
    await opts.beforeCreate?.(true);
    return {
      path: WORKTREE,
      branch: BRANCH,
      baseBranch: FRESH_BASE,
      createdBranch: true,
      repoPath: "/repo",
      forkSha: "recreated-branch-fork",
    };
  });

  await warmRunWorktree(makeRun(RUN_ID));

  const row = await actualRuns.getRunById(t.db, RUN_ID);
  expect(row?.baseRefreshOutcome).toBe(actualRuns.BRANCH_RECREATED_REFRESH_TOMBSTONE);
  expect(row?.baseRefreshSha).toBeNull();
});

it("persists the recreation tombstone via beforeCreate before the branch can survive a crash, recoverable if the process dies before the fork-pin write (PR #279 review, P1 re-review)", async () => {
  // The bug this closes: the old code wrote the tombstone only in the post-creation `updateRun` call,
  // AFTER `createWorktree` had already cut the new branch on disk. A process killed in that window
  // left the branch existing (so a resume's `createWorktree` treats it as already-there, not
  // recreated) with the tombstone never written — silently resurrecting the deleted branch's stale
  // `baseRefreshOutcome`/`baseRefreshSha` pair for a rebase `--onto` boundary the recreated branch
  // never actually had. Simulating that crash directly: the mock's `beforeCreate` call must be the
  // ONLY write that lands — nothing after it runs.
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseRefreshOutcome: "merged",
    baseRefreshSha: "stale-recorded-base",
    branch: BRANCH,
  });
  createWorktreeMock.mockImplementation(async (opts: { beforeCreate?: (createdBranch: boolean) => Promise<void> }) => {
    await opts.beforeCreate?.(true);
    throw new Error("simulated crash right after the tombstone lands, before the branch materializes");
  });

  await expect(warmRunWorktree(makeRun(RUN_ID))).rejects.toThrow(/simulated crash/);

  const row = await actualRuns.getRunById(t.db, RUN_ID);
  expect(row?.baseRefreshOutcome).toBe(actualRuns.BRANCH_RECREATED_REFRESH_TOMBSTONE);
  expect(row?.baseRefreshSha).toBeNull();
});

it("does not resurrect a pre-recreation refresh boundary once the recreation row tombstones it (PR #279 review, P1)", async () => {
  // Attempt 1 refreshed this branch onto `stale-recorded-base` and recorded it on its row, now dead
  // (an ordinary failure). Attempt 2 finds the checkout deleted, recreates the branch, and tombstones
  // its own row instead of leaving a plain null — `isNotNull(baseRefreshSha)` alone would skip that
  // tombstone row (its `baseRefreshSha` stays null) and hand attempt 3 attempt 1's now-invalid
  // boundary, replaying whatever the deletion/recreation dropped back onto the recreated branch.
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseRefreshOutcome: "merged",
    baseRefreshSha: "stale-recorded-base",
    branch: BRANCH,
    status: "failed",
  });
  const RECREATED = "run-2";
  await createRun(t.db, clock, { id: RECREATED, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockImplementationOnce(
    async (opts: { beforeCreate?: (createdBranch: boolean) => Promise<void> }) => {
      await opts.beforeCreate?.(true);
      return {
        path: WORKTREE,
        branch: BRANCH,
        baseBranch: FRESH_BASE,
        createdBranch: true,
        repoPath: "/repo",
        forkSha: "recreated-branch-fork",
      };
    },
  );
  await warmRunWorktree(makeRun(RECREATED));
  const recreatedRow = await actualRuns.getRunById(t.db, RECREATED);
  expect(recreatedRow?.baseRefreshOutcome).toBe(actualRuns.BRANCH_RECREATED_REFRESH_TOMBSTONE);

  // Attempt 3 retries over the recreated (now reused) checkout — its `--onto` boundary must come
  // from the recreated branch's own fork, never attempt 1's tombstoned `stale-recorded-base`.
  const RETRY = "run-3";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockResolvedValueOnce({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
  });

  await warmRunWorktree(makeRun(RETRY));

  expect(createWorktreeMock).toHaveBeenLastCalledWith(
    expect.objectContaining({ forkSha: "recreated-branch-fork" }),
  );
});

it("advances alreadyShippedBase to the refreshed base when a stale reused checkout was brought forward (PR #279 review)", async () => {
  // A resume reuses a branch pinned to an OLD fork — baseForkSha stays frozen at it, by design, so
  // dispatch keeps partitioning against the checkout's true fork. But the refresh that just merged
  // this checkout onto the freshly-fetched base brought commits into its history that a truthful
  // already-shipped claim can now cite, and alreadyShippedBase must track that newer base rather
  // than reject a claim the tree actually already contains.
  await actualRuns.updateRun(t.db, clock, RUN_ID, { baseForkSha: "old-fork-commit" });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
    refreshOutcome: { outcome: "merged", baseSha: "fresh-base-commit" },
  });

  const { runStep } = await warmRunWorktree(makeRun());

  expect(runStep.baseForkSha).toBe("old-fork-commit");
  expect(runStep.alreadyShippedBase).toBe("fresh-base-commit");
});

it("keeps alreadyShippedBase at the frozen fork when the refresh skipped a dirty tree", async () => {
  // `skipped_dirty` means the branch was NOT actually brought forward — the checkout dispatches
  // against whatever it already had, so the base it verifies already-shipped claims against must
  // stay the one the tree actually reflects.
  await actualRuns.updateRun(t.db, clock, RUN_ID, { baseForkSha: "old-fork-commit" });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
    refreshOutcome: { outcome: "skipped_dirty", baseSha: "fresh-base-commit" },
  });

  const { runStep } = await warmRunWorktree(makeRun());

  expect(runStep.alreadyShippedBase).toBe("old-fork-commit");
});

it("falls back alreadyShippedBase to a prior resume's recorded refresh when this attempt is skipped_dirty, without clobbering that record (PR #279 review)", async () => {
  // Attempt 1 refreshed this reused checkout onto a fresh base (recorded as `merged` on the row).
  // Attempt 2 (this one) finds the checkout dirty — `refreshOntoBase` reports `skipped_dirty`, its
  // own no-op. `alreadyShippedBase` must fall back to attempt 1's recorded base, not the frozen
  // `baseForkSha`, and the write must leave attempt 1's record alone rather than overwrite it with
  // this attempt's non-move.
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: "merged",
    baseRefreshSha: "prior-base",
    branch: BRANCH,
  });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
    refreshOutcome: { outcome: "skipped_dirty", baseSha: "this-attempt-dirty-base" },
  });

  const { runStep } = await warmRunWorktree(makeRun(RUN_ID));

  expect(runStep.baseForkSha).toBe("old-fork-commit");
  expect(runStep.alreadyShippedBase).toBe("prior-base");

  const row = await actualRuns.getRunById(t.db, RUN_ID);
  expect(row?.baseRefreshOutcome).toBe("merged");
  expect(row?.baseRefreshSha).toBe("prior-base");
});

it("keeps the prior resume's recorded refresh when an offline dirty resume's fallback base is merely BEHIND it (PR #279 review)", async () => {
  // Attempt 1 refreshed this reused checkout onto `prior-base` (recorded as `merged`) while online.
  // Attempt 2 (this one) is a DIRTY resume that also can't reach the network, so `resolveFreshBase`
  // falls back to the local, stale base ref — and `refreshOntoBase` pins that same stale value as
  // its `skipped_dirty` base sha before ever fetching. `prior-base` is AHEAD of that stale pin (the
  // checkout still carries it from the earlier successful refresh) rather than genuinely diverged
  // from it, so `alreadyShippedBase` must keep citing `prior-base` — checking only whether
  // `prior-base` descends from the stale pin (and not the reverse) would wrongly answer no here and
  // fall through to the stale pin, rejecting a truthful already-shipped claim that cites commits the
  // checkout still has.
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: "merged",
    baseRefreshSha: "prior-base",
    branch: BRANCH,
  });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
    refreshOutcome: { outcome: "skipped_dirty", baseSha: "stale-offline-base" },
  });
  isAncestorMock.mockImplementation(async (...args: unknown[]) => {
    const [, a, b] = args as [string, string, string];
    return a === "stale-offline-base" && b === "prior-base";
  });

  const { runStep } = await warmRunWorktree(makeRun(RUN_ID));

  expect(runStep.baseForkSha).toBe("old-fork-commit");
  expect(runStep.alreadyShippedBase).toBe("prior-base");
});

it("verifies against the pinned dirty-resume base, not a stale recorded refresh, once neither descends from the other (PR #279 review)", async () => {
  // Attempt 1 refreshed this reused checkout onto `prior-base` (recorded as `merged`). Before
  // attempt 2, origin's base was force-pushed past `prior-base` — dropping a commit an
  // already-shipped claim could cite — and this attempt finds the checkout dirty, so
  // `refreshOntoBase` reports `skipped_dirty` without re-fetching, returning the base sha it
  // resolved and pinned before finding the checkout dirty. `prior-base` and that pinned base
  // share no ancestry in either direction (the force-push truly diverged them), so
  // `alreadyShippedBase` must ask the pinned base `refreshOntoBase` itself reasoned about —
  // never a `freshBase` re-resolved here, which a sibling run's fetch could have moved on to a
  // different commit in the two `await`s since.
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: "merged",
    baseRefreshSha: "prior-base",
    branch: BRANCH,
  });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
    refreshOutcome: { outcome: "skipped_dirty", baseSha: "this-attempt-dirty-base" },
  });
  isAncestorMock.mockResolvedValue(false);

  const { runStep } = await warmRunWorktree(makeRun(RUN_ID));

  expect(runStep.baseForkSha).toBe("old-fork-commit");
  expect(runStep.alreadyShippedBase).toBe("this-attempt-dirty-base");
});

it("prefers the newer resolved base over an older recorded refresh once the branch already carries it (PR #279 review, P1)", async () => {
  // Attempt 1 refreshed this reused checkout onto `prior-base` (recorded as `merged`). Before this
  // attempt, a prior resume ALSO landed the branch on the newer `fresh-base` (e.g. its own refresh
  // succeeded but crashed before the row could record it) — so the branch already carries
  // `fresh-base`'s commits. This attempt is a dirty resume, so `refreshOntoBase` doesn't move
  // anything and reports `skipped_dirty` with the same `fresh-base` it independently resolved.
  // `fresh-base` descends from `prior-base` (they're ancestor-comparable, not diverged), and it is
  // reachable from the branch tip — so citing the older `prior-base` here would leave base-only
  // commits in `prior-base..fresh-base` eligible for false attribution to this branch's delivery.
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: "merged",
    baseRefreshSha: "prior-base",
    branch: BRANCH,
  });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
    refreshOutcome: { outcome: "skipped_dirty", baseSha: "fresh-base" },
  });
  isAncestorMock.mockImplementation(async (...args: unknown[]) => {
    const [, ancestor, descendant] = args as [string, string, string];
    if (ancestor === "prior-base" && descendant === "fresh-base") return true;
    if (ancestor === "fresh-base" && descendant === `refs/heads/${BRANCH}`) return true;
    return false;
  });

  const { runStep } = await warmRunWorktree(makeRun(RUN_ID));

  expect(runStep.alreadyShippedBase).toBe("fresh-base");
});

it("keeps the older recorded refresh when the newer resolved base was never actually merged onto the branch", async () => {
  // Same setup as above, but this time the branch does NOT already carry `fresh-base` — this is an
  // ordinary `skipped_dirty` that never applied it. Citing `fresh-base` here would check an
  // already-shipped claim against a commit the checkout doesn't actually have, so the older but
  // confirmed-landed `prior-base` must still win.
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: "merged",
    baseRefreshSha: "prior-base",
    branch: BRANCH,
  });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
    refreshOutcome: { outcome: "skipped_dirty", baseSha: "fresh-base" },
  });
  isAncestorMock.mockImplementation(async (...args: unknown[]) => {
    const [, ancestor, descendant] = args as [string, string, string];
    if (ancestor === "prior-base" && descendant === "fresh-base") return true;
    return false;
  });

  const { runStep } = await warmRunWorktree(makeRun(RUN_ID));

  expect(runStep.alreadyShippedBase).toBe("prior-base");
});

it("passes the last EFFECTIVE refresh's base as the --onto boundary, in preference to the original fork (PR #279 review)", async () => {
  // Attempt 1 refreshed this reused checkout with `--onto` the original fork, landing on
  // `first-refresh-base`, then failed for an ordinary reason (its row settles `failed`). Attempt 2
  // opens a FRESH row over the same branch: the original fork point is no longer reachable on the
  // branch at all (attempt 1's `--onto` rebase replayed only what came after it), so passing that
  // stale fork forward would make refreshOntoBase silently fall back to the plain, unsafe rebase
  // form. The most recently applied base is what must be forwarded instead.
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "original-fork-commit",
    baseRefreshOutcome: "rebased",
    baseRefreshSha: "first-refresh-base",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
  });

  await warmRunWorktree(makeRun(RETRY));

  expect(createWorktreeMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ forkSha: "first-refresh-base" }),
  );
});

// anton-s55u (PR #279 review, P1): a process killed between `createWorktree`'s refresh actually
// mutating the branch and this function's own finalize write leaves nothing behind for a plain
// exception-catch to recover, since a hard kill runs no catch at all. `beforeMutate` closes that
// gap by persisting a "pending" marker naming the boundary the mutation is ABOUT to apply, before
// the mutating git call ever runs — see PENDING_REFRESH_OUTCOME's own doc comment.
it("persists a pending refresh boundary via beforeMutate before the mutating git call resolves, recoverable if the process dies before finalize", async () => {
  let rowDuringMutation:
    | { baseRefreshOutcome: string | null; pendingRefreshFromSha: string | null; pendingRefreshKind: string | null }
    | undefined;
  createWorktreeMock.mockImplementation(
    async (opts: {
      beforeMutate?: (baseSha: string, branchSha: string, kind: "fast_forwarded" | "merged" | "rebased") => Promise<void>;
    }) => {
      await opts.beforeMutate?.("about-to-refresh-onto-this", "branch-tip-before-mutation", "rebased");
      rowDuringMutation = await actualRuns.getRunById(t.db, RUN_ID);
      return {
        path: WORKTREE,
        branch: BRANCH,
        baseBranch: FRESH_BASE,
        createdBranch: false,
        repoPath: "/repo",
        refreshOutcome: { outcome: "rebased", baseSha: "about-to-refresh-onto-this" },
      };
    },
  );

  await warmRunWorktree(makeRun());

  // The pending marker, AND the branch's pre-mutation tip, were durably on the row DURING the
  // (simulated) mutation window — a kill right there would leave this behind for a resume to
  // reconcile, instead of nothing at all (see the reconciliation tests below).
  expect(rowDuringMutation?.baseRefreshOutcome).toBe(actualRuns.PENDING_REFRESH_OUTCOME);
  expect(rowDuringMutation?.pendingRefreshFromSha).toBe("branch-tip-before-mutation");
  expect(rowDuringMutation?.pendingRefreshKind).toBe("rebased");
  // The normal finalize write still overwrites it with the real outcome once createWorktree returns.
  const row = await actualRuns.getRunById(t.db, RUN_ID);
  expect(row?.baseRefreshOutcome).toBe("rebased");
  expect(row?.baseRefreshSha).toBe("about-to-refresh-onto-this");
});

// anton-s55u (PR #279 review, P1, re-review): a resumed run calls warmRunWorktree again on the SAME
// row that already carries a confirmed refresh from an earlier warm — beforeMutate's pending write is
// about to overwrite that row's own baseRefreshOutcome/baseRefreshSha, so it must snapshot the
// boundary onto priorBaseRefreshSha first, or a crash in the mutation window that follows loses it
// for good (see findRunBaseRefreshShaForBranch's read-back of this same column).
it("snapshots this row's own prior confirmed boundary onto priorBaseRefreshSha before overwriting it with the pending marker", async () => {
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: "rebased",
    baseRefreshSha: "earlier-confirmed-base",
    branch: BRANCH,
  });
  let rowDuringMutation: { baseRefreshOutcome: string | null; priorBaseRefreshSha: string | null } | undefined;
  createWorktreeMock.mockImplementation(
    async (opts: {
      beforeMutate?: (baseSha: string, branchSha: string, kind: "fast_forwarded" | "merged" | "rebased") => Promise<void>;
    }) => {
      await opts.beforeMutate?.("second-refresh-target", "branch-tip-before-second-mutation", "rebased");
      rowDuringMutation = await actualRuns.getRunById(t.db, RUN_ID);
      return {
        path: WORKTREE,
        branch: BRANCH,
        baseBranch: FRESH_BASE,
        createdBranch: false,
        repoPath: "/repo",
        refreshOutcome: { outcome: "rebased", baseSha: "second-refresh-target" },
      };
    },
  );

  await warmRunWorktree(makeRun(RUN_ID));

  expect(rowDuringMutation?.baseRefreshOutcome).toBe(actualRuns.PENDING_REFRESH_OUTCOME);
  expect(rowDuringMutation?.priorBaseRefreshSha).toBe("earlier-confirmed-base");
});

// anton-s55u (PR #279 review, P1, second re-review): this row's own reconciliation above can ALREADY
// have promoted a crashed-but-landed pending refresh into `reconciledRefreshSha` before this same call
// starts a SECOND mutation of its own — snapshotting the pre-reconciliation `priorEffectiveRefreshSha`
// instead would lose that just-recovered boundary the moment this new pending write lands, and a later
// crash would fall back to the stale value reconciliation already proved outdated.
it("snapshots the reconciled boundary, not the pre-reconciliation one, when this call both recovers a crashed refresh and starts a new one", async () => {
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: actualRuns.PENDING_REFRESH_OUTCOME,
    baseRefreshSha: "landed-base-b",
    pendingRefreshFromSha: "branch-tip-before-first-mutation",
    pendingRefreshKind: "rebased",
    // This row's own earlier confirmed boundary, from before the crashed attempt's pending write
    // overwrote it — what `priorEffectiveRefreshSha` resolves to BEFORE reconciliation runs.
    priorBaseRefreshSha: "very-old-base-a",
    branch: BRANCH,
  });
  let rowDuringSecondMutation:
    | { baseRefreshOutcome: string | null; priorBaseRefreshSha: string | null }
    | undefined;
  createWorktreeMock.mockImplementation(
    async (opts: {
      beforeMutate?: (baseSha: string, branchSha: string, kind: "fast_forwarded" | "merged" | "rebased") => Promise<void>;
    }) => {
      await opts.beforeMutate?.("new-mutation-target-c", "branch-tip-before-second-mutation", "rebased");
      rowDuringSecondMutation = await actualRuns.getRunById(t.db, RUN_ID);
      return {
        path: WORKTREE,
        branch: BRANCH,
        baseBranch: FRESH_BASE,
        createdBranch: false,
        repoPath: "/repo",
        refreshOutcome: { outcome: "rebased", baseSha: "new-mutation-target-c" },
      };
    },
  );
  // The crashed attempt's mutation onto `landed-base-b` actually landed: the branch moved off its
  // recorded pre-mutation tip, and `landed-base-b` is now reachable from its current tip.
  isAncestorMock.mockImplementation(async (...args: unknown[]) => {
    const [, ancestor, descendant] = args as [string, string, string];
    if (ancestor === "branch-tip-before-first-mutation" || descendant === "branch-tip-before-first-mutation") {
      return false;
    }
    return ancestor === "landed-base-b" && descendant === `refs/heads/${BRANCH}`;
  });

  await warmRunWorktree(makeRun(RUN_ID));

  expect(rowDuringSecondMutation?.baseRefreshOutcome).toBe(actualRuns.PENDING_REFRESH_OUTCOME);
  expect(rowDuringSecondMutation?.priorBaseRefreshSha).toBe("landed-base-b");
});

// anton-s55u (PR #279 review, P2): swallowing this write's failure used to let refreshOntoBase's
// mutating call proceed with no write-ahead record at all — the exact unrecorded-mutation gap
// `beforeMutate` exists to close. The rejection must propagate instead, so the mutation never runs.
it("propagates a failure to persist the pending refresh boundary, instead of letting the mutation proceed unrecorded", async () => {
  updateRunMock.mockReset().mockImplementation(async (...args: Parameters<typeof actualRuns.updateRun>) => {
    const patch = args[3];
    if (patch.baseRefreshOutcome === actualRuns.PENDING_REFRESH_OUTCOME) {
      throw new Error("database unavailable");
    }
    return actualRuns.updateRun(...args);
  });
  let mutationAttempted = false;
  createWorktreeMock.mockImplementation(
    async (opts: {
      beforeMutate?: (baseSha: string, branchSha: string, kind: "fast_forwarded" | "merged" | "rebased") => Promise<void>;
    }) => {
      await opts.beforeMutate?.("about-to-refresh-onto-this", "branch-tip-before-mutation", "rebased");
      // Unreachable if beforeMutate's rejection is propagated rather than swallowed.
      mutationAttempted = true;
      return {
        path: WORKTREE,
        branch: BRANCH,
        baseBranch: FRESH_BASE,
        createdBranch: false,
        repoPath: "/repo",
        refreshOutcome: { outcome: "rebased", baseSha: "about-to-refresh-onto-this" },
      };
    },
  );

  await expect(warmRunWorktree(makeRun())).rejects.toThrow("database unavailable");
  expect(mutationAttempted).toBe(false);
});

it("reconciles a pending refresh onto the boundary a crashed attempt actually applied, once the branch's own history confirms it landed", async () => {
  // Attempt 1 started (but never lived to finalize) a refresh onto `pending-base` — its row is
  // still stuck on PENDING_REFRESH_OUTCOME. The branch's own history now confirms it actually
  // landed (the mutation succeeded; only the finalize write never ran): `pending-base` was NOT an
  // ancestor of the branch's own pre-mutation tip (genuine forward motion), but IS one now.
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: actualRuns.PENDING_REFRESH_OUTCOME,
    baseRefreshSha: "pending-base",
    pendingRefreshFromSha: "branch-tip-before-mutation",
    pendingRefreshKind: "rebased",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
  });
  isAncestorMock.mockImplementation(async (...args: unknown[]) => {
    const [, ancestor, descendant] = args as [string, string, string];
    if (ancestor === "pending-base" && descendant === "branch-tip-before-mutation") return false;
    return ancestor === "pending-base" && descendant === `refs/heads/${BRANCH}`;
  });

  await warmRunWorktree(makeRun(RETRY));

  expect(createWorktreeMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ forkSha: "pending-base" }),
  );
});

// anton-s55u (PR #279 review, P1, seventh round): the false positive THIS closes — the old,
// kind-blind check trusted `pending-base` here because SOME commit moved the branch off its
// recorded pre-mutation tip and the rewind target was already reachable, without checking that the
// movement was actually the rebase it claimed. A `pre-rebase` hook that commits a side effect (e.g.
// writing generated state) before rejecting the rebase produces exactly that shape: the branch moves
// off `fromSha`, but onto a commit built directly ON TOP of it — so `fromSha` stays reachable from
// the new tip, unlike a genuine `--onto` rebase, which always replays onto brand-new commit objects
// and leaves the old tip unreachable.
it("does not trust a pending rebase when the branch moved for an unrelated reason (e.g. a pre-rebase hook side effect), even though the target is reachable", async () => {
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: actualRuns.PENDING_REFRESH_OUTCOME,
    baseRefreshSha: "rewound-base",
    pendingRefreshFromSha: "branch-tip-before-mutation",
    pendingRefreshKind: "rebased",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
  });
  // `rewound-base` is reachable from the branch's new tip (it always was, that's the rewind's
  // premise) — but so is `branch-tip-before-mutation`, since the hook's stray commit was built
  // directly on top of it rather than through an actual rebase replay.
  isAncestorMock.mockImplementation(async (...args: unknown[]) => {
    const [, ancestor, descendant] = args as [string, string, string];
    if (descendant !== `refs/heads/${BRANCH}`) return false;
    return ancestor === "rewound-base" || ancestor === "branch-tip-before-mutation";
  });

  await warmRunWorktree(makeRun(RETRY));

  expect(createWorktreeMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ forkSha: "old-fork-commit" }),
  );
});

// anton-s55u (PR #279 review): a landed fast-forward reaches the target base exactly unless its
// post-merge hook commits immediately afterward. In the latter case, the branch reflog's adjacent
// pre-mutation → target transition is the operation-specific evidence, not generic ancestry.
it("confirms a pending fast-forward only when the branch tip is EXACTLY the target base", async () => {
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: actualRuns.PENDING_REFRESH_OUTCOME,
    baseRefreshSha: "ff-target",
    pendingRefreshFromSha: "branch-tip-before-ff",
    pendingRefreshKind: "fast_forwarded",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
  });
  resolveCommitShaMock.mockResolvedValue("ff-target");

  await warmRunWorktree(makeRun(RETRY));

  expect(createWorktreeMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ forkSha: "ff-target" }),
  );
});

it("does not trust a pending fast-forward when the branch tip is merely a descendant of the target, not exactly it", async () => {
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: actualRuns.PENDING_REFRESH_OUTCOME,
    baseRefreshSha: "ff-target",
    pendingRefreshFromSha: "branch-tip-before-ff",
    pendingRefreshKind: "fast_forwarded",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
  });
  // Some OTHER commit landed on the branch after `ff-target` — without the fast-forward's own reflog
  // transition, a descendant tip cannot prove the pending operation landed.
  resolveCommitShaMock.mockResolvedValue("some-later-commit");
  gitMock.mockResolvedValue("some-later-commit\nff-target\nnot-the-recorded-pre-mutation-tip");

  await warmRunWorktree(makeRun(RETRY));

  expect(createWorktreeMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ forkSha: "old-fork-commit" }),
  );
});

it("confirms a pending fast-forward followed by a post-merge hook commit", async () => {
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: actualRuns.PENDING_REFRESH_OUTCOME,
    baseRefreshSha: "ff-target",
    pendingRefreshFromSha: "branch-tip-before-ff",
    pendingRefreshKind: "fast_forwarded",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockResolvedValue({ path: WORKTREE, branch: BRANCH, baseBranch: FRESH_BASE, createdBranch: false, repoPath: "/repo" });
  resolveCommitShaMock.mockResolvedValue("post-merge-hook-commit");
  gitMock.mockResolvedValue("post-merge-hook-commit\nff-target\nbranch-tip-before-ff");

  await warmRunWorktree(makeRun(RETRY));

  expect(createWorktreeMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ forkSha: "ff-target" }));
});

// PR #279 review, P2: an operator can delete a crashed attempt's checkout AND branch before the
// next resume. Reconciliation must fail closed on the missing ref rather than throw — the operation-
// specific probes below (`rev-parse --verify`, `merge-base --is-ancestor`) all read `refs/heads/
// <branch>` directly and throw on a ref that doesn't exist, which would otherwise abort the resume
// before `createWorktree` ever gets a chance to recreate the branch.
it("treats a pending refresh as unconfirmed, without probing it, when the branch itself no longer exists", async () => {
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: actualRuns.PENDING_REFRESH_OUTCOME,
    baseRefreshSha: "ff-target",
    pendingRefreshFromSha: "branch-tip-before-ff",
    pendingRefreshKind: "fast_forwarded",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  // The operator deleted the branch along with the old checkout — `createWorktree` recreates it fresh.
  branchExistsMock.mockResolvedValue(false);
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: true,
    repoPath: "/repo",
  });

  await expect(warmRunWorktree(makeRun(RETRY))).resolves.toBeDefined();

  expect(branchExistsMock).toHaveBeenCalledWith("/repo", BRANCH);
  // Never reaches the fast-forward-specific probe — the branch is gone, so there's nothing to check
  // (unrelated `isAncestor` calls still fire further down, for the always-on fork-pin reconciliation).
  expect(resolveCommitShaMock).not.toHaveBeenCalled();
  expect(createWorktreeMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ forkSha: "old-fork-commit" }),
  );
});

// anton-s55u (PR #279 review, P1, seventh round): a landed merge's own specific trace — its tip is a
// commit whose parents are exactly the pre-mutation tip and the merged-in base.
it("confirms a pending merge only when the branch tip's parents are exactly the pre-mutation tip and the merged base", async () => {
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: actualRuns.PENDING_REFRESH_OUTCOME,
    baseRefreshSha: "merge-target",
    pendingRefreshFromSha: "branch-tip-before-merge",
    pendingRefreshKind: "merged",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
  });
  resolveCommitShaMock.mockResolvedValue("merge-commit-tip");
  commitParentShasMock.mockResolvedValue(["branch-tip-before-merge", "merge-target"]);

  await warmRunWorktree(makeRun(RETRY));

  expect(createWorktreeMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ forkSha: "merge-target" }),
  );
});

it("does not trust a pending merge when the tip's parents don't include the pre-mutation tip", async () => {
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: actualRuns.PENDING_REFRESH_OUTCOME,
    baseRefreshSha: "merge-target",
    pendingRefreshFromSha: "branch-tip-before-merge",
    pendingRefreshKind: "merged",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
  });
  resolveCommitShaMock.mockResolvedValue("unrelated-commit");
  // Some unrelated commit, not a merge of the pre-mutation tip at all.
  commitParentShasMock.mockResolvedValue(["some-other-parent"]);

  await warmRunWorktree(makeRun(RETRY));

  expect(createWorktreeMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ forkSha: "old-fork-commit" }),
  );
});

// anton-s55u (PR #279 review, P1, seventh round): a pending row written before `pendingRefreshKind`
// existed has no confirmation shape to check against — fails closed, same discipline as an undefined
// `fromSha` already gets, even though ancestry alone would suggest the mutation landed.
it("fails closed on a legacy pending refresh with no recorded kind, even though ancestry alone would suggest it landed", async () => {
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: actualRuns.PENDING_REFRESH_OUTCOME,
    baseRefreshSha: "pending-base",
    pendingRefreshFromSha: "branch-tip-before-mutation",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
  });
  // Reachability alone looks exactly like a landed rebase — the branch moved off its pre-mutation
  // tip, and the target is now reachable. Without a recorded `kind`, none of that is trusted.
  isAncestorMock.mockImplementation(async (...args: unknown[]) => {
    const [, ancestor, descendant] = args as [string, string, string];
    if (ancestor === "branch-tip-before-mutation" && descendant === `refs/heads/${BRANCH}`) return false;
    return ancestor === "pending-base" && descendant === `refs/heads/${BRANCH}`;
  });

  await warmRunWorktree(makeRun(RETRY));

  expect(createWorktreeMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ forkSha: "old-fork-commit" }),
  );
});

// anton-s55u (PR #279 review, P1 fix): an OPERATIONAL failure on this probe — not git's own exit-1
// "no" — must fail the resume rather than read as "mutation unconfirmed". Swallowing it used to fall
// back silently to the stale pre-mutation boundary, which a later rewind-then-rewrite of the base
// could rebase onto with `--onto`, resurrecting the very commit the rewrite dropped.
it("propagates an operational failure from the mutation-confirmation ancestry probe instead of treating it as unconfirmed", async () => {
  // Attempt 1's mutation onto `pending-base` genuinely moved the branch off its pre-mutation tip
  // (confirmed below), but confirming `pending-base` is now reachable from the branch's tip fails for
  // an operational reason, not because it's actually unreachable.
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: actualRuns.PENDING_REFRESH_OUTCOME,
    baseRefreshSha: "pending-base",
    pendingRefreshFromSha: "branch-tip-before-mutation",
    pendingRefreshKind: "rebased",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  isAncestorMock.mockImplementation(async (...args: unknown[]) => {
    const [, ancestor, descendant] = args as [string, string, string];
    if (ancestor === "pending-base" && descendant === "branch-tip-before-mutation") return false;
    if (descendant === "branch-tip-before-mutation") return false;
    if (ancestor === "pending-base" && descendant === `refs/heads/${BRANCH}`) {
      throw new Error("git process killed");
    }
    return false;
  });

  await expect(warmRunWorktree(makeRun(RETRY))).rejects.toThrow("git process killed");
  expect(createWorktreeMock).not.toHaveBeenCalled();
});

// anton-s55u (PR #279 review, fourth re-review): a NEWER `skipped_dirty` row between a dead attempt's
// pending write-ahead record and this resume must be treated as a barrier, not walked through. The
// dirty attempt still dispatched and committed real work onto the branch despite skipping its own
// refresh, moving the branch's tip for reasons that have nothing to do with whether attempt 1's
// pending mutation ever landed — reconciling against the stale `fromSha` here would let the dirty
// attempt's unrelated commits masquerade as proof the pending rebase actually ran.
it("does not reconcile a pending refresh past a newer skipped_dirty attempt that may have moved the branch on its own", async () => {
  // Attempt 1 started (but never lived to finalize) a refresh onto `pending-base` and crashed.
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: actualRuns.PENDING_REFRESH_OUTCOME,
    baseRefreshSha: "pending-base",
    pendingRefreshFromSha: "branch-tip-before-mutation",
    branch: BRANCH,
    status: "failed",
  });
  // Attempt 2 resumed, found the checkout dirty (its own refresh reports `skipped_dirty`), but still
  // dispatched and committed new work onto the branch — moving its tip on its own.
  const ATTEMPT_2 = "run-2";
  await createRun(t.db, clock, { id: ATTEMPT_2, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  await actualRuns.updateRun(t.db, clock, ATTEMPT_2, {
    baseRefreshOutcome: "skipped_dirty",
    baseRefreshSha: "attempt-2-dirty-base",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-3";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
  });
  // If reconciliation wrongly walked through attempt 2's skipped_dirty row to attempt 1's pending
  // record, this would look confirmed: the branch is no longer at its pre-mutation tip (attempt 2
  // moved it on its own), and `pending-base` happens to still be an ancestor of the branch regardless.
  isAncestorMock.mockImplementation(async (...args: unknown[]) => {
    const [, ancestor, descendant] = args as [string, string, string];
    if (ancestor === "pending-base" && descendant === `refs/heads/${BRANCH}`) return true;
    if (ancestor === "branch-tip-before-mutation" && descendant === `refs/heads/${BRANCH}`) return false;
    if (ancestor === `refs/heads/${BRANCH}` && descendant === "branch-tip-before-mutation") return false;
    return false;
  });

  await warmRunWorktree(makeRun(RETRY));

  // Must NOT reconcile onto attempt 1's stale pending boundary — falls back to the original fork.
  expect(createWorktreeMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ forkSha: "old-fork-commit" }),
  );
});

// anton-s55u (PR #279 review, third re-review): the dead attempt above is this branch's very FIRST
// refresh ever, so there is no OLDER settled row for `priorEffectiveRefreshSha` to find — it reads
// undefined even once the reconciliation above (same call) has confirmed the pending write actually
// landed. THIS same attempt's own checkout is additionally dirty (e.g. a post-merge/post-rewrite hook
// left generated edits), so its OWN refresh reports `skipped_dirty`. Falling back on the
// pre-reconciliation `priorEffectiveRefreshSha` here would treat the branch as having no confirmed
// refresh at all, rejecting a truthful already-shipped claim citing commits the reconciled refresh
// already brought onto the branch — `reconciledRefreshSha` is what must be consulted instead.
it("keeps alreadyShippedBase at the reconciled boundary, not the frozen fork, when this attempt's own refresh is skipped_dirty", async () => {
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: actualRuns.PENDING_REFRESH_OUTCOME,
    baseRefreshSha: "pending-base",
    pendingRefreshFromSha: "branch-tip-before-mutation",
    pendingRefreshKind: "rebased",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
    refreshOutcome: { outcome: "skipped_dirty", baseSha: "this-attempt-dirty-base" },
  });
  isAncestorMock.mockImplementation(async (...args: unknown[]) => {
    const [, ancestor, descendant] = args as [string, string, string];
    // The branch moved off its recorded pre-mutation tip (the dead attempt's mutation landed).
    if (ancestor === "branch-tip-before-mutation" && descendant === `refs/heads/${BRANCH}`) return false;
    // The reconciled boundary is confirmed on the branch, and is itself an ancestor of the dirty
    // resume's own resolved base — ordinary forward motion between the two.
    return true;
  });

  const { runStep } = await warmRunWorktree(makeRun(RETRY));

  expect(createWorktreeMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ forkSha: "pending-base" }),
  );
  expect(runStep.baseForkSha).toBe("old-fork-commit");
  expect(runStep.alreadyShippedBase).toBe("pending-base");
});

it("ignores a pending refresh that never actually landed on the branch, falling back to the last confirmed boundary", async () => {
  // Same shape as above, but the crashed attempt's mutation never actually reached the branch (it
  // died before the git call ran, or the operation was aborted) — the pending sha must NOT be
  // trusted as an `--onto` boundary the branch was never really moved onto.
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: actualRuns.PENDING_REFRESH_OUTCOME,
    baseRefreshSha: "pending-base-never-applied",
    pendingRefreshFromSha: "branch-tip-before-mutation",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
  });
  isAncestorMock.mockResolvedValue(false);

  await warmRunWorktree(makeRun(RETRY));

  expect(createWorktreeMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ forkSha: "old-fork-commit" }),
  );
});

// anton-s55u (PR #279 review, P1, re-review): this row itself, not just an older one, can already
// carry a genuinely confirmed boundary — a resumed run calls warmRunWorktree again on the SAME row,
// and its beforeMutate write-ahead hook overwrites baseRefreshOutcome/baseRefreshSha with the pending
// marker the instant it starts a SECOND refresh. Losing that prior boundary would make a crash right
// after this overwrite fall all the way back to the original fork, even though the branch's own
// history already carries a later, confirmed base this row itself applied.
it("falls back to this row's own prior confirmed boundary, not the original fork, when its pending refresh never landed", async () => {
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: actualRuns.PENDING_REFRESH_OUTCOME,
    baseRefreshSha: "pending-base-never-applied",
    pendingRefreshFromSha: "branch-tip-before-mutation",
    // This row's OWN last effective refresh, snapshotted by beforeMutate right before the pending
    // write above overwrote baseRefreshOutcome/baseRefreshSha with it.
    priorBaseRefreshSha: "this-rows-own-earlier-confirmed-base",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
  });
  isAncestorMock.mockResolvedValue(false);

  await warmRunWorktree(makeRun(RETRY));

  expect(createWorktreeMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ forkSha: "this-rows-own-earlier-confirmed-base" }),
  );
});

// anton-s55u (PR #279 review, P1): the false positive this closes — a base REWOUND from `A-B` back
// to `A` leaves `A` (the pending target) already an ancestor of a branch cut at `A-B-W`, before any
// rebase ever ran. Reachability against the branch's CURRENT history alone can't tell that apart from
// a mutation that actually landed; only comparing against the branch's recorded PRE-mutation tip can.
it("does not trust a pending refresh whose target base was already an ancestor of the branch BEFORE the mutation ran (a rewound base) when the branch never actually moved", async () => {
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: actualRuns.PENDING_REFRESH_OUTCOME,
    baseRefreshSha: "rewound-base",
    pendingRefreshFromSha: "branch-tip-before-mutation",
    pendingRefreshKind: "rebased",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
  });
  // `rewound-base` was ALREADY an ancestor of the branch's pre-mutation tip (the rewind's whole
  // premise) — and the dead attempt never actually mutated anything, so the branch's CURRENT tip is
  // still exactly `branch-tip-before-mutation`. Trusting reachability against the current branch
  // alone (the old check) would wrongly treat this as landed.
  isAncestorMock.mockImplementation(async (...args: unknown[]) => {
    const [, ancestor, descendant] = args as [string, string, string];
    if (ancestor === "rewound-base") return true;
    // The branch is unchanged: its current tip and the recorded pre-mutation tip are the same
    // commit, so each is trivially an ancestor of the other.
    return (
      (ancestor === "branch-tip-before-mutation" && descendant === `refs/heads/${BRANCH}`) ||
      (ancestor === `refs/heads/${BRANCH}` && descendant === "branch-tip-before-mutation")
    );
  });

  await warmRunWorktree(makeRun(RETRY));

  expect(createWorktreeMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ forkSha: "old-fork-commit" }),
  );
});

// anton-s55u (PR #279 review, P2 re-review): the false NEGATIVE the ancestry-alone check left behind
// — when the rewind target was already reachable from the pre-mutation tip, the old check always
// treated the pending refresh as unconfirmed, even once the rebase/merge/fast-forward it recorded
// actually landed. A landed mutation always moves the branch off its recorded pre-mutation tip, so
// that's what must be checked instead of re-testing reachability from a now-stale snapshot.
it("trusts a pending refresh onto a rewound base once the branch's tip has moved off its recorded pre-mutation state", async () => {
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: actualRuns.PENDING_REFRESH_OUTCOME,
    baseRefreshSha: "rewound-base",
    pendingRefreshFromSha: "branch-tip-before-mutation",
    pendingRefreshKind: "rebased",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
  });
  // `rewound-base` was already reachable from the pre-mutation tip (the rewind's premise), but this
  // time the mutation actually completed: the branch's CURRENT tip is no longer
  // `branch-tip-before-mutation` in either direction, while `rewound-base` remains reachable from
  // wherever the branch landed.
  isAncestorMock.mockImplementation(async (...args: unknown[]) => {
    const [, ancestor] = args as [string, string, string];
    return ancestor === "rewound-base";
  });

  await warmRunWorktree(makeRun(RETRY));

  expect(createWorktreeMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ forkSha: "rewound-base" }),
  );
});

// anton-s55u (PR #279 review, P1): a pending row written before `pendingRefreshFromSha` existed has
// no pre-mutation tip to reconcile against at all — reachability alone can't distinguish an applied
// mutation from pre-existing ancestry, so this must fail closed rather than guess.
it("fails closed on a legacy pending refresh with no recorded pre-mutation tip, even when reachability alone would suggest it landed", async () => {
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "old-fork-commit",
    baseRefreshOutcome: actualRuns.PENDING_REFRESH_OUTCOME,
    baseRefreshSha: "pending-base",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
  });
  isAncestorMock.mockImplementation(async (...args: unknown[]) => {
    const [, ancestor, descendant] = args as [string, string, string];
    return ancestor === "pending-base" && descendant === `refs/heads/${BRANCH}`;
  });

  await warmRunWorktree(makeRun(RETRY));

  expect(createWorktreeMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ forkSha: "old-fork-commit" }),
  );
});

it("falls back to the original fork as the --onto boundary when no branch row ever recorded an effective refresh", async () => {
  await actualRuns.updateRun(t.db, clock, RUN_ID, { baseForkSha: "trueforkcommit", branch: BRANCH });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: false,
    repoPath: "/repo",
  });

  await warmRunWorktree(makeRun());

  expect(createWorktreeMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ forkSha: "trueforkcommit" }),
  );
});

it("poisons the run when failed fork-pin cleanup cannot prove complete removal", async () => {
  updateRunMock.mockRejectedValueOnce(new Error("database unavailable"));
  removeWorktreeMock.mockResolvedValue({
    removed: false,
    skipped: "locked by another owner",
    branchDeleted: false,
    branchSkipped: "branch is checked out",
  });

  await expect(warmRunWorktree(makeRun())).rejects.toThrow(
    "newly-created checkout could not be fully removed",
  );
  expect(releaseClaimMock).toHaveBeenCalledWith("/repo", BRANCH, "execute-epic#run-1");
  expect(removeWorktreeMock).toHaveBeenCalledOnce();
});
