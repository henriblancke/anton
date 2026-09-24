/**
 * PR #238 review — a standalone target retired as already shipped must still prove the same
 * closure when the uninterrupted dispatch path settles its run row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead, BeadVersion } from "../beads/bd";
import { repairLabel } from "../gardener/repair";
import type { RunPreparation } from "./execute-epic-prepare";
import type { EpicRun } from "./execute-epic-run";

const showMock = vi.fn();
const historyMock = vi.fn<(...args: unknown[]) => Promise<BeadVersion[]>>();
const pullMock = vi.fn();
const isServerModeMock = vi.fn();
const loadAllIssuesMock = vi.fn();
const updateRunMock = vi.fn();
const releaseRunResourcesMock = vi.fn();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      note: vi.fn(async () => ""),
      pull: (...a: unknown[]) => pullMock(...a),
      show: (...a: unknown[]) => showMock(...a),
      history: (...a: unknown[]) => historyMock(...a),
    },
  };
});

vi.mock("../beads/board-mode", () => ({
  isServerMode: (...a: unknown[]) => isServerModeMock(...a),
}));

vi.mock("../beads/issues", async () => {
  const actual = await vi.importActual<typeof import("../beads/issues")>("../beads/issues");
  return { ...actual, loadAllIssues: (...a: unknown[]) => loadAllIssuesMock(...a) };
});

vi.mock("../runs", async () => {
  const actual = await vi.importActual<typeof import("../runs")>("../runs");
  return { ...actual, updateRun: (...a: unknown[]) => updateRunMock(...a) };
});

vi.mock("./worktree-reaper", () => ({
  releaseRunResources: (...a: unknown[]) => releaseRunResourcesMock(...a),
}));

const { walkRunPhase } = await import("./execute-epic-run-phase");

const REPO = "/tmp/anton";
const TARGET = "anton-5bpd";
const SURVIVOR = "anton-keep";

function retiredTarget({
  closure = "target-close",
  survivor = SURVIVOR,
}: { closure?: string; survivor?: string } = {}): Bead {
  return {
    id: TARGET,
    issue_type: "feature",
    status: "closed",
    labels: [repairLabel(TARGET, "already-shipped", Date.now(), closure, survivor)],
    dependencies: [{ type: "supersedes", issue_id: TARGET, depends_on_id: survivor }],
    notes: "retired as already shipped",
  } as unknown as Bead;
}

function child(): Bead {
  return { id: "anton-kid", issue_type: "task", status: "open", parent_id: TARGET } as Bead;
}

function run(): EpicRun {
  return {
    db: {},
    clock: { now: () => new Date("2026-09-09T00:00:00Z") },
    ctx: {},
    projectId: "p1",
    repo: REPO,
    runId: "run-1",
    targetId: TARGET,
    timedOut: [],
    retired: [{ id: TARGET, replacedBy: SURVIVOR, source: "this-run" }],
    releaseWorktreeHold: vi.fn(async () => {}),
  } as unknown as EpicRun;
}

const prep = (): Extract<RunPreparation, { done: false }> =>
  ({
    done: false,
    runSteps: [],
    worktree: {
      path: "/tmp/anton-worktree",
      branch: `anton/${TARGET}`,
      baseBranch: "main",
      createdBranch: false,
      repoPath: REPO,
    },
  }) as unknown as Extract<RunPreparation, { done: false }>;

const retiredDispatch = {
  delivered: [],
  satisfied: new Map(),
  skipped: new Map(),
  targetRetired: true,
};

describe("walkRunPhase standalone retirement settlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const target = retiredTarget();
    showMock.mockResolvedValue(target);
    historyMock.mockResolvedValue([
      { hash: "target-close", at: "2026-09-09T00:00:00.000Z", status: "closed" },
    ]);
    pullMock.mockResolvedValue(undefined);
    isServerModeMock.mockReturnValue(false);
    loadAllIssuesMock.mockResolvedValue([target]);
    updateRunMock.mockResolvedValue(undefined);
    releaseRunResourcesMock.mockResolvedValue(undefined);
  });

  it("settles a still-verified retirement and uses the server board without pulling", async () => {
    isServerModeMock.mockReturnValue(true);

    await expect(walkRunPhase(run(), prep(), retiredDispatch)).resolves.toBeUndefined();

    expect(pullMock).not.toHaveBeenCalled();
    expect(updateRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "run-1",
      // A retirement opens no pull request — the row must not read as delivery evidence
      // (PR #320 review).
      expect.objectContaining({ status: "done", delivered: false }),
    );
    expect(releaseRunResourcesMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to settle before recording done when the verified target gained a child", async () => {
    const target = retiredTarget();
    loadAllIssuesMock.mockResolvedValue([target, child()]);

    await expect(walkRunPhase(run(), prep(), retiredDispatch)).rejects.toThrow(
      "changed after anton verified its already-shipped retirement",
    );
    expect(updateRunMock).not.toHaveBeenCalled();
  });

  it("refuses to settle when the embedded board cannot be refreshed", async () => {
    pullMock.mockRejectedValue(new Error("dolt pull: remote unavailable"));

    await expect(walkRunPhase(run(), prep(), retiredDispatch)).rejects.toThrow(
      "changed after anton verified its already-shipped retirement",
    );
    expect(loadAllIssuesMock).not.toHaveBeenCalled();
    expect(updateRunMock).not.toHaveBeenCalled();
  });

  it("refuses to settle when the durable repair evidence is missing", async () => {
    const target = retiredTarget();
    showMock.mockResolvedValue({ ...target, labels: [] });

    await expect(walkRunPhase(run(), prep(), retiredDispatch)).rejects.toThrow(
      "no longer proves the already-shipped retirement",
    );
    expect(updateRunMock).not.toHaveBeenCalled();
  });

  it("refuses to settle when the target has a newer closure cycle", async () => {
    showMock.mockResolvedValue(retiredTarget({ closure: "old-close" }));
    historyMock.mockResolvedValue([
      { hash: "new-close", at: "2026-09-09T00:00:00.000Z", status: "closed" },
      { hash: "reopened", at: "2026-09-09T00:00:00.000Z", status: "open" },
      { hash: "old-close", at: "2026-09-09T00:00:00.000Z", status: "closed" },
    ]);

    await expect(walkRunPhase(run(), prep(), retiredDispatch)).rejects.toThrow(
      "no longer proves the already-shipped retirement",
    );
    expect(updateRunMock).not.toHaveBeenCalled();
  });

  it("poisons after recording done when a child appears during the terminal write", async () => {
    const target = retiredTarget();
    loadAllIssuesMock
      .mockResolvedValueOnce([target])
      .mockResolvedValueOnce([target, child()]);

    await expect(walkRunPhase(run(), prep(), retiredDispatch)).rejects.toThrow(
      "changed while anton recorded its already-shipped retirement",
    );
    expect(updateRunMock).toHaveBeenCalledTimes(1);
    expect(releaseRunResourcesMock).not.toHaveBeenCalled();
  });

  it.each([
    ["reopens", { status: "open", dependencies: [] }],
    ["changes survivor", {
      dependencies: [{ type: "supersedes", issue_id: TARGET, depends_on_id: "anton-new-survivor" }],
    }],
  ])("poisons after recording done when the target %s", async (_name, change) => {
    const target = retiredTarget();
    loadAllIssuesMock
      .mockResolvedValueOnce([target])
      .mockResolvedValueOnce([{ ...target, ...change } as Bead]);

    await expect(walkRunPhase(run(), prep(), retiredDispatch)).rejects.toThrow(
      "changed while anton recorded its already-shipped retirement",
    );
    expect(updateRunMock).toHaveBeenCalledTimes(1);
    expect(releaseRunResourcesMock).not.toHaveBeenCalled();
  });

  it("poisons after recording done when the repair stamp is removed during the terminal write", async () => {
    const target = retiredTarget();
    loadAllIssuesMock
      .mockResolvedValueOnce([target])
      .mockResolvedValueOnce([{ ...target, labels: [] }]);

    await expect(walkRunPhase(run(), prep(), retiredDispatch)).rejects.toThrow(
      "changed while anton recorded its already-shipped retirement",
    );
    expect(updateRunMock).toHaveBeenCalledTimes(1);
    expect(releaseRunResourcesMock).not.toHaveBeenCalled();
  });
});
