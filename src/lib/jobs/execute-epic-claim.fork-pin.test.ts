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
vi.mock("../git/worktree", async () => {
  const actual = await vi.importActual<typeof import("../git/worktree")>("../git/worktree");
  return {
    ...actual,
    acquireWorktreeClaim: (...a: unknown[]) => acquireClaimMock(...a),
    releaseWorktreeClaim: (...a: unknown[]) => releaseClaimMock(...a),
    removeWorktree: (...a: unknown[]) => removeWorktreeMock(...a),
    createWorktree: (...a: unknown[]) => createWorktreeMock(...a),
  };
});

const resolveFreshBaseMock = vi.fn();
const resolveForkPointMock = vi.fn();
const isAncestorMock = vi.fn<(...a: unknown[]) => Promise<boolean>>();
vi.mock("../git/ops", async () => {
  const actual = await vi.importActual<typeof import("../git/ops")>("../git/ops");
  return {
    ...actual,
    resolveFreshBase: (...a: unknown[]) => resolveFreshBaseMock(...a),
    resolveForkPoint: (...a: unknown[]) => resolveForkPointMock(...a),
    isAncestor: (...a: unknown[]) => isAncestorMock(...a),
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
  resolveFreshBaseMock.mockReset().mockResolvedValue(FRESH_BASE);
  resolveForkPointMock.mockReset().mockResolvedValue("f0f0f0forkcommit");
  // Ordinary forward motion by default — the freshly-resolved base still descends from whatever
  // fallback base an already-shipped claim would be checked against (PR #279 review). The one test
  // that means to exercise a rewritten-behind fallback overrides this itself.
  isAncestorMock.mockReset().mockResolvedValue(true);
});
afterEach(() => t.close());

it("pins the fork commit against the freshly-fetched base on a first creation", async () => {
  const { runStep } = await warmRunWorktree(makeRun());

  expect(resolveForkPointMock).toHaveBeenCalledExactlyOnceWith(WORKTREE, FRESH_BASE);
  expect(runStep.baseForkSha).toBe("f0f0f0forkcommit");
  // Persisted, so the resume below can read it back.
  expect(await getRunBaseForkSha(t.db, RUN_ID)).toBe("f0f0f0forkcommit");
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
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: true,
    repoPath: "/repo",
    forkSha: "recreated-branch-fork",
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
  // `--onto` boundary, replaying whatever the deletion/recreation dropped.
  await actualRuns.updateRun(t.db, clock, RUN_ID, {
    baseRefreshOutcome: "merged",
    baseRefreshSha: "stale-recorded-base",
    branch: BRANCH,
  });
  createWorktreeMock.mockResolvedValue({
    path: WORKTREE,
    branch: BRANCH,
    baseBranch: FRESH_BASE,
    createdBranch: true,
    repoPath: "/repo",
    forkSha: "recreated-branch-fork",
  });

  await warmRunWorktree(makeRun(RUN_ID));

  const row = await actualRuns.getRunById(t.db, RUN_ID);
  expect(row?.baseRefreshOutcome).toBeNull();
  expect(row?.baseRefreshSha).toBeNull();
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
