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
/** Whether the branch already existed — what tells a REUSED checkout from a first creation. */
const branchExistsMock = vi.fn<(...a: unknown[]) => Promise<boolean>>();
vi.mock("../git/worktree", async () => {
  const actual = await vi.importActual<typeof import("../git/worktree")>("../git/worktree");
  return {
    ...actual,
    acquireWorktreeClaim: (...a: unknown[]) => acquireClaimMock(...a),
    branchExists: (...a: unknown[]) => branchExistsMock(...a),
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

const { warmRunWorktree } = await import("./execute-epic-claim");
const { createRun, updateRun, getRunBaseForkSha } = await import("../runs");
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
    repoPath: "/repo",
  });
  acquireClaimMock.mockReset().mockResolvedValue(undefined);
  branchExistsMock.mockReset().mockResolvedValue(false);
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

it("reuses the pinned fork on resume instead of recomputing over a moved HEAD", async () => {
  // A prior attempt already pinned the true fork; the base has since rewound, so recomputing now
  // would answer behind it. The resume must read the stored value and never call the resolver.
  await updateRun(t.db, clock, RUN_ID, { baseForkSha: "trueforkcommit" });
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
  await updateRun(t.db, clock, RUN_ID, {
    baseForkSha: "trueforkcommit",
    branch: BRANCH,
    status: "failed",
  });
  const RETRY = "run-2";
  await createRun(t.db, clock, { id: RETRY, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  branchExistsMock.mockResolvedValue(true);
  resolveForkPointMock.mockRejectedValue(new Error("resolver must not run over a reused branch"));

  const { runStep } = await warmRunWorktree(makeRun(RETRY));

  expect(resolveForkPointMock).not.toHaveBeenCalled();
  expect(runStep.baseForkSha).toBe("trueforkcommit");
});

it("resolves its OWN fork point when it just created the branch, ignoring another branch's pin", async () => {
  // A run standing on a branch it cut itself forks HERE, at the freshly-fetched base. A pin from an
  // earlier run of the same epic on a DIFFERENT branch describes a checkout this one does not share.
  await updateRun(t.db, clock, RUN_ID, { baseForkSha: "oldbranchfork", branch: "anton/old", status: "failed" });
  const FRESH = "run-3";
  await createRun(t.db, clock, { id: FRESH, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });
  branchExistsMock.mockResolvedValue(false);

  const { runStep } = await warmRunWorktree(makeRun(FRESH));

  expect(resolveForkPointMock).toHaveBeenCalledExactlyOnceWith(WORKTREE, FRESH_BASE);
  expect(runStep.baseForkSha).toBe("f0f0f0forkcommit");
  expect(await getRunBaseForkSha(t.db, FRESH)).toBe("f0f0f0forkcommit");
});
