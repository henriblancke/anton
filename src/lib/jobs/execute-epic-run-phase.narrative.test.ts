/**
 * The run's PR narrative survives a resume (anton-fpkk8): `walkRunPhase` carries whatever
 * `step:describe` reports into every later step's `StepContext`, persists it on the run row, and
 * restores it on a resume whose describer either doesn't run at all or runs and reports nothing —
 * mirroring `carry.advisories`, the mechanism this one rides alongside (execute-epic-run-step.ts).
 *
 * Unit-tested against fakes, the same way execute-epic-run-phase's own leaf behavior is (see
 * execute-epic-run-phase.retirement.test.ts): no real bd, git, or claude — `step:describe` and
 * `step:pr` are fake handlers, so the test proves the WALK's wiring, not the describer or the PR
 * step's own logic (covered elsewhere).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "../beads/bd";
import type { RunPreparation } from "./execute-epic-prepare";
import type { EpicRun } from "./execute-epic-run";
import type { RunNarrative, StepResult } from "./steps/result";

const updateRunMock = vi.fn();
/** The worktree HEAD the faked `readWorktreeState` reports — moved by a test that amends the branch. */
const headMock = vi.fn(() => HEAD);
const armMergeGateMock = vi.fn();
const releaseRunResourcesMock = vi.fn();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      note: vi.fn(async () => ""),
      setPrRef: vi.fn(async () => {}),
      tag: vi.fn(async () => {}),
      untag: vi.fn(async () => {}),
    },
  };
});

vi.mock("../runs", async () => {
  const actual = await vi.importActual<typeof import("../runs")>("../runs");
  return { ...actual, updateRun: (...a: unknown[]) => updateRunMock(...a) };
});

vi.mock("./execute-epic-merge-gate", () => ({
  armMergeGate: (...a: unknown[]) => armMergeGateMock(...a),
}));

vi.mock("./worktree-reaper", () => ({
  releaseRunResources: (...a: unknown[]) => releaseRunResourcesMock(...a),
}));

// The narrative is bound to the branch tip it was written against (PR #303 review), so the walk
// reads HEAD on both the restore and the persist. Faked here like every other seam in this file.
vi.mock("../git/ops", () => ({
  readWorktreeState: async () => ({ head: headMock(), status: "", ref: `refs/heads/${TARGET}` }),
}));

const { walkRunPhase } = await import("./execute-epic-run-phase");

const REPO = "/tmp/anton";
const TARGET = "anton-fpkk8-target";
const HEAD = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";

function targetBead(): Bead {
  return { id: TARGET, issue_type: "task", status: "open", labels: [] } as unknown as Bead;
}

function run(existingNarrative?: string | null): EpicRun {
  return {
    db: {},
    clock: { now: () => new Date("2026-09-18T00:00:00Z") },
    ctx: {},
    projectId: "p1",
    repo: REPO,
    runId: "run-1",
    targetId: TARGET,
    all: [targetBead()],
    standaloneRun: true,
    timedOut: [],
    retired: [],
    existing: existingNarrative === undefined ? undefined : ({ narrative: existingNarrative } as never),
    lease: { assertHeld: () => {} },
    releaseWorktreeHold: vi.fn(async () => {}),
  } as unknown as EpicRun;
}

function prep(steps: unknown[]) {
  return {
    done: false,
    runSteps: steps,
    runStep: {
      target: targetBead(),
      settings: {},
      worktreePath: "/tmp/anton-worktree",
      branch: `anton/${TARGET}`,
      baseBranch: "main",
      baseRef: "origin/main",
    },
    worktree: {
      path: "/tmp/anton-worktree",
      branch: `anton/${TARGET}`,
      baseBranch: "main",
      createdBranch: false,
      repoPath: REPO,
    },
  } as unknown as Extract<RunPreparation, { done: false }>;
}

/** One cooked `step:describe`/`step:pr` occurrence, the shape `ResolvedStep` carries. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function step(name: "describe" | "pr", handler: (ctx: any) => Promise<StepResult>) {
  return { step: { id: `step-${name}-${Math.random()}` }, definition: { name, handler } };
}

const dispatched = () => ({
  delivered: [targetBead()],
  satisfied: new Map(),
  skipped: new Map(),
  targetRetired: false,
});

const narrative = (summary: string): RunNarrative => ({ summary });

beforeEach(() => {
  vi.clearAllMocks();
  headMock.mockReturnValue(HEAD);
  updateRunMock.mockResolvedValue(undefined);
  armMergeGateMock.mockResolvedValue(undefined);
  releaseRunResourcesMock.mockResolvedValue(undefined);
});

describe("walkRunPhase — the PR narrative survives a resume", () => {
  it("carries a describer's narrative into the steps that follow it", async () => {
    const n = narrative("what changed");
    const describeHandler = vi.fn(async () => ({ ok: true, facts: { narrative: n } }));
    const prHandler = vi.fn(async (ctx: { narrative?: RunNarrative }) => {
      expect(ctx.narrative).toEqual(n);
      return { ok: true, facts: { pr: { ref: "gh-1", url: "https://example.com/pull/1", bodyStale: false } } };
    });

    await walkRunPhase(run(), prep([step("describe", describeHandler), step("pr", prHandler)]), dispatched());

    expect(prHandler).toHaveBeenCalledTimes(1);
    expect(updateRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "run-1",
      expect.objectContaining({ narrative: JSON.stringify({ ...n, head: HEAD }) }),
    );
  });

  it("a second describe in one formula overwrites the carried narrative with its own", async () => {
    const first = narrative("first pass");
    const second = narrative("second pass, the real one");
    const describeOne = vi.fn(async () => ({ ok: true, facts: { narrative: first } }));
    const describeTwo = vi.fn(async () => ({ ok: true, facts: { narrative: second } }));
    const prHandler = vi.fn(async (ctx: { narrative?: RunNarrative }) => {
      expect(ctx.narrative).toEqual(second);
      return { ok: true, facts: { pr: { ref: "gh-1", url: "https://example.com/pull/1", bodyStale: false } } };
    });

    await walkRunPhase(
      run(),
      prep([step("describe", describeOne), step("describe", describeTwo), step("pr", prHandler)]),
      dispatched(),
    );

    expect(prHandler).toHaveBeenCalledTimes(1);
    // Persisted once per successful describe — the second write is the one that survives.
    const narrativeWrites = updateRunMock.mock.calls.filter((c) => "narrative" in (c[3] ?? {}));
    expect(narrativeWrites.at(-1)?.[3]).toEqual({
      narrative: JSON.stringify({ ...second, head: HEAD }),
    });
  });

  it("a row with no persisted narrative, and a describer that reports nothing, resumes with no narrative and no error", async () => {
    const describeHandler = vi.fn(async () => ({ ok: true, facts: {} }));
    const prHandler = vi.fn(async (ctx: { narrative?: RunNarrative }) => {
      expect(ctx.narrative).toBeUndefined();
      return { ok: true, facts: { pr: { ref: "gh-1", url: "https://example.com/pull/1", bodyStale: false } } };
    });

    await expect(
      walkRunPhase(run(undefined), prep([step("describe", describeHandler), step("pr", prHandler)]), dispatched()),
    ).resolves.toBeUndefined();

    expect(prHandler).toHaveBeenCalledTimes(1);
    // A describer that reports nothing never touches the narrative column.
    expect(updateRunMock.mock.calls.some((c) => "narrative" in (c[3] ?? {}))).toBe(false);
    expect(updateRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "run-1",
      expect.objectContaining({ status: "done" }),
    );
  });

  it("a resume whose describer reports nothing still opens the PR with the narrative an earlier attempt earned", async () => {
    const earned = narrative("earned on a prior attempt");
    // This attempt's describer fails to report one — its own contract (steps/describe.ts): a
    // failure costs the narrative and nothing else, never the run.
    const describeHandler = vi.fn(async () => ({ ok: true, facts: {} }));
    const prHandler = vi.fn(async (ctx: { narrative?: RunNarrative }) => {
      expect(ctx.narrative).toEqual(earned);
      return { ok: true, facts: { pr: { ref: "gh-1", url: "https://example.com/pull/1", bodyStale: false } } };
    });

    await walkRunPhase(
      run(JSON.stringify({ ...earned, head: HEAD })),
      prep([step("describe", describeHandler), step("pr", prHandler)]),
      dispatched(),
    );

    expect(prHandler).toHaveBeenCalledTimes(1);
    expect(describeHandler).toHaveBeenCalledTimes(1);
  });

  it("a resume whose branch has moved since the narrative was written opens the PR without it", async () => {
    // The case the binding exists for (PR #303 review): the run reached `describe`, failed opening
    // the PR, and a human added or amended commits before resuming. This attempt's describer reports
    // nothing — its contract — and `runDescribeStep` keeps whatever the carry holds, so an unbound
    // restore would put prose about the PREVIOUS tree into the PR. Today's body is the right
    // fallback: a plainer opening, describing nothing that isn't there.
    const stale = narrative("written against a tree the human has since amended");
    headMock.mockReturnValue("aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee");
    const describeHandler = vi.fn(async () => ({ ok: true, facts: {} }));
    const prHandler = vi.fn(async (ctx: { narrative?: RunNarrative }) => {
      expect(ctx.narrative).toBeUndefined();
      return { ok: true, facts: { pr: { ref: "gh-1", url: "https://example.com/pull/1", bodyStale: false } } };
    });

    await walkRunPhase(
      run(JSON.stringify({ ...stale, head: HEAD })),
      prep([step("describe", describeHandler), step("pr", prHandler)]),
      dispatched(),
    );

    expect(prHandler).toHaveBeenCalledTimes(1);
  });

  it("a describer that DOES report on the moved branch overwrites the discarded one", async () => {
    // The discard costs only the restore — a describer that runs on the new tree still speaks for it.
    const fresh = narrative("describes the branch as it stands now");
    headMock.mockReturnValue("aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee");
    const describeHandler = vi.fn(async () => ({ ok: true, facts: { narrative: fresh } }));
    const prHandler = vi.fn(async (ctx: { narrative?: RunNarrative }) => {
      expect(ctx.narrative).toEqual(fresh);
      return { ok: true, facts: { pr: { ref: "gh-1", url: "https://example.com/pull/1", bodyStale: false } } };
    });

    await walkRunPhase(
      run(JSON.stringify({ ...narrative("stale"), head: HEAD })),
      prep([step("describe", describeHandler), step("pr", prHandler)]),
      dispatched(),
    );

    expect(prHandler).toHaveBeenCalledTimes(1);
    // Re-bound to the tip it was actually written against, not the one it replaced.
    const narrativeWrites = updateRunMock.mock.calls.filter((c) => "narrative" in (c[3] ?? {}));
    expect(narrativeWrites.at(-1)?.[3]).toEqual({
      narrative: JSON.stringify({ ...fresh, head: "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee" }),
    });
  });

  it("a garbled persisted narrative resumes with no narrative rather than throwing", async () => {
    const describeHandler = vi.fn(async () => ({ ok: true, facts: {} }));
    const prHandler = vi.fn(async (ctx: { narrative?: RunNarrative }) => {
      expect(ctx.narrative).toBeUndefined();
      return { ok: true, facts: { pr: { ref: "gh-1", url: "https://example.com/pull/1", bodyStale: false } } };
    });

    await expect(
      walkRunPhase(run("{not json"), prep([step("describe", describeHandler), step("pr", prHandler)]), dispatched()),
    ).resolves.toBeUndefined();

    expect(prHandler).toHaveBeenCalledTimes(1);
  });
});
