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
vi.mock("../git/ops", async () => {
  const actual = await vi.importActual<typeof import("../git/ops")>("../git/ops");
  return {
    ...actual,
    resolveFreshBase: (...a: unknown[]) => resolveFreshBaseMock(...a),
    resolveForkPoint: (...a: unknown[]) => resolveForkPointMock(...a),
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

function makeRun(runId = RUN_ID): EpicRun {
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
