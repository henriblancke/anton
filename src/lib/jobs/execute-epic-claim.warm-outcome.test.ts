/**
 * anton-jyrhf — {@link warmRunWorktree} persists what warming did onto the run row, at the moment it
 * happens.
 *
 * The failure this closes was invisible for minutes and then misattributed: a warm that died on an
 * unresolvable dependency reached only a console the job runner doesn't keep, and surfaced three
 * phases later as a git push error naming an unrelated subsystem. Recording it here is what makes
 * the real cause queryable against the row, rather than inferred from the symptom.
 *
 * Mocked at the git seam, same as execute-epic-claim.fork-pin.test.ts: what's under test is which
 * outcome this function writes and that it proceeds regardless — warming's own behavior is covered
 * in worktree.warm-outcome.test.ts.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../db/testing";
import * as schema from "../db/schema";
import type { Bead } from "../beads/bd";
import type { WarmOutcome } from "../git/worktree";

const createWorktreeMock = vi.fn();
const warmMock = vi.fn<(...a: unknown[]) => Promise<WarmOutcome>>();
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
    warmWorktreeBestEffort: (...a: unknown[]) => warmMock(...a),
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
const { createRun } = await vi.importActual<typeof import("../runs")>("../runs");
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

function makeRun(): EpicRun {
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
    tickets: [],
  } as unknown as EpicRun;
}

/** The warm columns as they stand on the run row. */
async function warmRow(): Promise<{
  warmOutcome: string | null;
  warmCommand: string | null;
  warmError: string | null;
}> {
  const rows = await t.db
    .select({
      warmOutcome: schema.runs.warmOutcome,
      warmCommand: schema.runs.warmCommand,
      warmError: schema.runs.warmError,
    })
    .from(schema.runs)
    .where(eq(schema.runs.id, RUN_ID));
  return rows[0]!;
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
  warmMock.mockReset().mockResolvedValue({ outcome: "ok", command: "bun install --frozen-lockfile" });
  acquireClaimMock.mockReset().mockResolvedValue(undefined);
  releaseClaimMock.mockReset().mockResolvedValue(undefined);
  removeWorktreeMock.mockReset().mockResolvedValue({ removed: true, branchDeleted: true });
  resolveFreshBaseMock.mockReset().mockResolvedValue({ ref: FRESH_BASE, baseIsAuthoritative: true });
  resolveForkPointMock.mockReset().mockResolvedValue("f0f0f0forkcommit");
  isAncestorMock.mockReset().mockResolvedValue(true);
});
afterEach(() => t.close());

it("persists a failed warm's command and stderr tail, and still hands back the run step", async () => {
  warmMock.mockResolvedValue({
    outcome: "failed",
    command: "bun install --frozen-lockfile",
    error: "error: Could not resolve @tailwindcss/vite",
  });

  // Best-effort is the whole point: the run proceeds exactly as it did before this record existed.
  const { runStep } = await warmRunWorktree(makeRun());
  expect(runStep.worktreePath).toBe(WORKTREE);

  expect(await warmRow()).toEqual({
    warmOutcome: "failed",
    warmCommand: "bun install --frozen-lockfile",
    warmError: "error: Could not resolve @tailwindcss/vite",
  });
});

it("records ok with the command, leaving no stale error behind", async () => {
  await warmRunWorktree(makeRun());

  expect(await warmRow()).toEqual({
    warmOutcome: "ok",
    warmCommand: "bun install --frozen-lockfile",
    warmError: null,
  });
});

it("keeps a disabled and a skipped warm distinguishable on the row", async () => {
  warmMock.mockResolvedValue({ outcome: "disabled" });
  await warmRunWorktree(makeRun());
  expect(await warmRow()).toEqual({ warmOutcome: "disabled", warmCommand: null, warmError: null });

  warmMock.mockResolvedValue({ outcome: "skipped" });
  await warmRunWorktree(makeRun());
  expect(await warmRow()).toEqual({ warmOutcome: "skipped", warmCommand: null, warmError: null });
});

// A resumed run re-warms. A `skipped` second attempt (its checkout is already installed) must not
// leave the first attempt's failure detail sitting on the row describing a warm that isn't this one.
it("clears a prior attempt's failure detail when a later warm succeeds", async () => {
  warmMock.mockResolvedValue({ outcome: "failed", command: "bun install", error: "registry unreachable" });
  await warmRunWorktree(makeRun());

  warmMock.mockResolvedValue({ outcome: "skipped" });
  await warmRunWorktree(makeRun());

  expect(await warmRow()).toEqual({ warmOutcome: "skipped", warmCommand: null, warmError: null });
});

// Telemetry must never be the thing that loses a run: warming already refused to fail it, and
// recording what warming did cannot reintroduce that failure by the back door.
it("proceeds when the outcome cannot be persisted at all", async () => {
  const run = makeRun();
  const writes = vi.spyOn(run.db, "update");
  // Armed from inside warming, so only the write that follows it fails. The fork-pin write before it
  // is deliberately NOT best-effort, and breaking that one would prove nothing about this one.
  warmMock.mockImplementation(async () => {
    writes.mockImplementation(() => {
      throw new Error("database is locked");
    });
    return { outcome: "failed", command: "bun install", error: "registry unreachable" };
  });

  try {
    const { runStep } = await warmRunWorktree(run);
    expect(runStep.worktreePath).toBe(WORKTREE);
  } finally {
    writes.mockRestore();
  }
});
