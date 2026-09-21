/**
 * anton-s55u (PR #279 review, second round) — {@link warmRunWorktree} must forward every commit a
 * bead still durably references to `createWorktree`'s `preserveShas`, not just satisfied-note ones.
 *
 * A satisfied-note's `by.commit` (anton-8h4b) and a block note's `committed on <branch> @ <sha>`
 * (blockNoteEvidence) are both durable board evidence pointing at a specific commit on this run's
 * branch. `refreshOntoBase` merges instead of rebasing when it finds one of these still on the
 * branch, so a rebase never rewrites a commit the board still cites — but only for shas this
 * function actually passes it. Before this fix only satisfied-note shas were collected, so a ticket
 * that failed after committing (or timed out with preserved work) and left its evidence in a block
 * note instead had that commit rewritten by a clean resume's rebase, leaving the note's reference
 * unreachable.
 *
 * Mocked at the git seam, same as execute-epic-claim.fork-pin.test.ts: what's under test is which
 * shas this function computes and forwards, not git's own rebase/merge behavior (covered in
 * worktree.test.ts).
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "../db/testing";
import * as schema from "../db/schema";
import type { Bead } from "../beads/bd";
import { blockNoteEvidence } from "../beads/block-note";
import { formatSatisfiedNote } from "../beads/satisfied-note";

const createWorktreeMock = vi.fn();
const acquireClaimMock = vi.fn<(...a: unknown[]) => Promise<void>>();
const releaseClaimMock = vi.fn<(...a: unknown[]) => Promise<void>>();
const removeWorktreeMock = vi.fn();
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

const { warmRunWorktree } = await import("./execute-epic-claim");
const actualRuns = await vi.importActual<typeof import("../runs")>("../runs");
const { createRun } = actualRuns;
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

function bead(id: string, notes: string): Bead {
  return { id, title: id, status: "open", notes } as Bead;
}

function makeRun(tickets: Bead[]): EpicRun {
  return {
    db: t.db,
    clock,
    ctx: { signal: new AbortController().signal, heartbeat: vi.fn(async () => {}), report: vi.fn(), attempt: 1 },
    projectId: PROJECT,
    repo: "/repo",
    runId: RUN_ID,
    branch: BRANCH,
    targetId: EPIC,
    project: { defaultBranch: "main" },
    settings: {},
    lease: { assertHeld: () => {} },
    target: { id: EPIC, title: EPIC } as Bead,
    tickets,
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
  resolveFreshBaseMock.mockReset().mockResolvedValue({ ref: FRESH_BASE, baseIsAuthoritative: true });
  resolveForkPointMock.mockReset().mockResolvedValue("f0f0f0forkcommit");
  isAncestorMock.mockReset().mockResolvedValue(true);
});
afterEach(() => t.close());

it("forwards a block note's committed sha alongside a satisfied-note's, for this branch", async () => {
  const satisfiedSha = "1111111111111111111111111111111111111a";
  const blockSha = "2222222222222222222222222222222222222b";
  const satisfiedNote = formatSatisfiedNote({
    by: { commit: satisfiedSha },
    sessionId: "sess-1",
    branch: BRANCH,
  });
  const blockNote = `anton: blocked after committing — needs review [${blockNoteEvidence({
    sessionId: "sess-2",
    branch: BRANCH,
    committed: true,
    head: blockSha,
  })}]`;

  const tickets = [bead("anton-t1", satisfiedNote), bead("anton-t2", blockNote)];

  await warmRunWorktree(makeRun(tickets));

  expect(createWorktreeMock).toHaveBeenCalledTimes(1);
  const call = createWorktreeMock.mock.calls[0]![0] as { preserveShas?: string[] };
  expect(call.preserveShas).toContain(satisfiedSha);
  // blockNoteEvidence embeds the full sha (PR #279 review, P1) — a truncated prefix could go
  // ambiguous in a growing repo and silently read as absent by the isAncestor check that consumes it.
  expect(call.preserveShas).toContain(blockSha);
});

it("drops a block note's sha when it names a different branch, and when nothing committed", async () => {
  const otherBranchNote = `anton: blocked — needs review [${blockNoteEvidence({
    sessionId: "sess-3",
    branch: "anton/some-other-branch",
    committed: true,
    head: "3333333333333333333333333333333333333c",
  })}]`;
  const nothingCommittedNote = `anton: blocked, no work landed [${blockNoteEvidence({
    sessionId: "sess-4",
    branch: BRANCH,
    committed: false,
  })}]`;

  const tickets = [bead("anton-t3", otherBranchNote), bead("anton-t4", nothingCommittedNote)];

  await warmRunWorktree(makeRun(tickets));

  const call = createWorktreeMock.mock.calls[0]![0] as { preserveShas?: string[] };
  expect(call.preserveShas).toEqual([]);
});
