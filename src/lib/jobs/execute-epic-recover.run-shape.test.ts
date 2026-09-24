/**
 * PR #238 review — {@link settleCompletedRun}'s retirement short-circuit asks the REFRESHED board
 * what shape the target is, not the snapshot verdict the run was started with.
 *
 * `refreshRunBoard` adopts a fresh `run.all` but deliberately leaves `run.standaloneRun` alone: the
 * shape is recomputed in step 0a-ter, which runs AFTER this short-circuit. So a retry whose fresh
 * board has since gained a child under the target would, on the stale `true`, settle the whole run
 * `done` off a single stamped-and-superseded bead — stranding that newly-added work beneath a closed
 * target with no run path left to reach it.
 *
 * Mocked at the module seam: the state under test is two board reads DISAGREEING inside one run,
 * which a real board cannot be asked for on demand.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead, BeadVersion } from "../beads/bd";
import { repairLabel } from "../gardener/repair";

const showMock = vi.fn();
const historyMock = vi.fn<(...args: unknown[]) => Promise<BeadVersion[]>>();
const pullMock = vi.fn();
const isServerModeMock = vi.fn();
const loadAllIssuesMock = vi.fn();
const updateRunMock = vi.fn();
const releaseRunResourcesMock = vi.fn();
const findWorktreeMock = vi.fn();

// Only `show` is stubbed — it spawns bd. Every predicate the gate reasons with (supersededBy,
// groupsChildren, getPrRef) stays real, so the test exercises the real shape verdict.
vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      pull: (...a: unknown[]) => pullMock(...a),
      show: (...a: unknown[]) => showMock(...a),
      history: (...a: unknown[]) => historyMock(...a),
    },
  };
});

vi.mock("../beads/board-mode", () => ({
  isServerMode: (...a: unknown[]) => isServerModeMock(...a),
}));

// The settle path's terminal writes: stubbed so the assertion is the SHAPE VERDICT, not a real
// run row or worktree teardown.
vi.mock("../runs", async () => {
  const actual = await vi.importActual<typeof import("../runs")>("../runs");
  return { ...actual, updateRun: (...a: unknown[]) => updateRunMock(...a) };
});

vi.mock("../beads/issues", async () => {
  const actual = await vi.importActual<typeof import("../beads/issues")>("../beads/issues");
  return { ...actual, loadAllIssues: (...a: unknown[]) => loadAllIssuesMock(...a) };
});

vi.mock("./worktree-reaper", () => ({
  releaseRunResources: (...a: unknown[]) => releaseRunResourcesMock(...a),
}));

vi.mock("../git/worktree", async () => {
  const actual = await vi.importActual<typeof import("../git/worktree")>("../git/worktree");
  return { ...actual, findWorktree: (...a: unknown[]) => findWorktreeMock(...a) };
});

const { settleCompletedRun } = await import("./execute-epic-recover");
import type { EpicRun } from "./execute-epic-run";

const REPO = "/tmp/anton";
const TARGET = "anton-5bpd";
const SURVIVOR = "anton-keep";

/** The retired standalone target: closed, superseding a survivor, stamped by anton's own repair. */
function retiredTarget({
  stampAt = Date.now(),
  closure = "target-close",
  survivor = SURVIVOR,
  legacy = false,
}: { stampAt?: number; closure?: string; survivor?: string; legacy?: boolean } = {}): Bead {
  return {
    id: TARGET,
    issue_type: "feature",
    status: "closed",
    // Built with the real stamper, so the fixture can't drift from the label format the gate parses.
    labels: [repairLabel(TARGET, "already-shipped", stampAt, legacy ? undefined : closure, legacy ? undefined : survivor)],
    dependencies: [{ type: "supersedes", issue_id: TARGET, depends_on_id: SURVIVOR }],
    notes: "retired as already shipped",
  } as unknown as Bead;
}

/** A ticket the refreshed board shows under the target — the child the snapshot did not have. */
function child(): Bead {
  return { id: "anton-kid", issue_type: "task", status: "open", parent_id: TARGET } as unknown as Bead;
}

function run(all: Bead[], target: Bead, standaloneRun = true): EpicRun {
  return {
    db: {},
    clock: { now: () => new Date("2026-09-09T00:00:00Z") },
    ctx: {},
    projectId: "p1",
    repo: REPO,
    runId: "run-1",
    branch: `anton/${TARGET}`,
    targetId: TARGET,
    all,
    target,
    // The snapshot verdict can be stale until 0a-ter recomputes it.
    standaloneRun,
    lease: { adoptOwn: vi.fn(), refuseForeign: vi.fn() },
  } as unknown as EpicRun;
}

describe("settleCompletedRun retirement short-circuit (run shape)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pullMock.mockResolvedValue(undefined);
    isServerModeMock.mockReturnValue(false);
    showMock.mockImplementation(async () => retiredTarget());
    historyMock.mockResolvedValue([{ hash: "target-close", at: "2026-09-09T00:00:00.000Z", status: "closed" }]);
    loadAllIssuesMock.mockImplementation(async () => [retiredTarget()]);
    findWorktreeMock.mockResolvedValue(undefined);
  });

  it("refuses to settle a stamped retirement whose refreshed board has gained a child", async () => {
    const target = retiredTarget();

    expect(await settleCompletedRun(run([target, child()], target), target)).toBe(false);
    // Not even asked: the shape verdict fails before the stamp is read.
    expect(showMock).not.toHaveBeenCalled();
  });

  it("still settles a retirement that is genuinely its own single ticket on the fresh board", async () => {
    const target = retiredTarget();

    expect(await settleCompletedRun(run([target], target), target)).toBe(true);
    // The adjacent board recheck pulled the shared embedded board, then found the same shape.
    expect(pullMock).toHaveBeenCalledWith(REPO);
    expect(loadAllIssuesMock).toHaveBeenCalledWith(REPO, { strictGates: true });
    // Settled as a finished run, with no PR, exactly as the uninterrupted attempt would — and not
    // as delivery evidence, since no PR was ever opened (PR #320 review).
    expect(updateRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "run-1",
      expect.objectContaining({ status: "done", delivered: false }),
    );
  });

  it("settles when the refreshed board has no children despite a stale non-standalone snapshot", async () => {
    const target = retiredTarget();

    expect(await settleCompletedRun(run([target], target, false), target)).toBe(true);
    expect(updateRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "run-1",
      expect.objectContaining({ status: "done", delivered: false }),
    );
  });

  it("poisons the run when the adjacent board recheck finds a new child", async () => {
    const target = retiredTarget();
    loadAllIssuesMock.mockResolvedValue([target, child()]);

    await expect(settleCompletedRun(run([target], target), target)).rejects.toThrow(
      "changed after anton verified its already-shipped retirement",
    );
    expect(updateRunMock).not.toHaveBeenCalled();
  });

  it("poisons the run when a child lands while the terminal row is written", async () => {
    const target = retiredTarget();
    loadAllIssuesMock
      .mockResolvedValueOnce([target])
      .mockResolvedValueOnce([target, child()]);

    await expect(settleCompletedRun(run([target], target), target)).rejects.toThrow(
      "changed while anton recorded its already-shipped retirement",
    );
    expect(updateRunMock).toHaveBeenCalledTimes(1);
    expect(updateRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "run-1",
      expect.objectContaining({ status: "done" }),
    );
    expect(releaseRunResourcesMock).not.toHaveBeenCalled();
  });

  it("does not recover a retirement from a board read that could not be refreshed", async () => {
    const target = retiredTarget();

    expect(await settleCompletedRun(run([target], target), target, false)).toBe(false);
    expect(showMock).not.toHaveBeenCalled();
  });

  it("refuses settlement when an embedded-board fence cannot pull fresh topology", async () => {
    const target = retiredTarget();
    pullMock.mockRejectedValue(new Error("dolt pull: remote unavailable"));

    await expect(settleCompletedRun(run([target], target), target)).rejects.toThrow(
      "changed after anton verified its already-shipped retirement",
    );
    expect(loadAllIssuesMock).not.toHaveBeenCalled();
    expect(updateRunMock).not.toHaveBeenCalled();
  });

  it("uses the server board directly at settlement fences", async () => {
    const target = retiredTarget();
    isServerModeMock.mockReturnValue(true);

    expect(await settleCompletedRun(run([target], target), target)).toBe(true);
    expect(pullMock).not.toHaveBeenCalled();
    expect(loadAllIssuesMock).toHaveBeenCalledWith(REPO, { strictGates: true });
  });

  it("poisons the run when the retirement is reopened while the terminal row is written", async () => {
    const target = retiredTarget();
    loadAllIssuesMock
      .mockResolvedValueOnce([target])
      .mockResolvedValueOnce([{ ...target, status: "open", dependencies: [] }]);

    await expect(settleCompletedRun(run([target], target), target)).rejects.toThrow(
      "changed while anton recorded its already-shipped retirement",
    );
    expect(updateRunMock).toHaveBeenCalledTimes(1);
    expect(releaseRunResourcesMock).not.toHaveBeenCalled();
  });

  it("poisons the run when the retirement gets a different survivor while the terminal row is written", async () => {
    const target = retiredTarget();
    loadAllIssuesMock
      .mockResolvedValueOnce([target])
      .mockResolvedValueOnce([
        {
          ...target,
          dependencies: [{ type: "supersedes", issue_id: TARGET, depends_on_id: "anton-new-survivor" }],
        },
      ]);

    await expect(settleCompletedRun(run([target], target), target)).rejects.toThrow(
      "changed while anton recorded its already-shipped retirement",
    );
    expect(updateRunMock).toHaveBeenCalledTimes(1);
    expect(releaseRunResourcesMock).not.toHaveBeenCalled();
  });

  it("rejects a stamp left by a same-second retirement cycle before the current closure", async () => {
    const target = retiredTarget({ closure: "old-close" });

    showMock.mockResolvedValue(target);
    historyMock.mockResolvedValue([
      { hash: "new-close", at: "2026-09-09T00:00:00.000Z", status: "closed" },
      { hash: "reopened", at: "2026-09-09T00:00:00.000Z", status: "open" },
      { hash: "old-close", at: "2026-09-09T00:00:00.000Z", status: "closed" },
    ]);

    expect(await settleCompletedRun(run([target], target), target)).toBe(false);
    expect(updateRunMock).not.toHaveBeenCalled();
  });

  it("rejects a stamp that names a different verified survivor", async () => {
    const target = retiredTarget({ survivor: "anton-old-survivor" });

    showMock.mockResolvedValue(target);
    expect(await settleCompletedRun(run([target], target), target)).toBe(false);
    expect(historyMock).not.toHaveBeenCalled();
    expect(updateRunMock).not.toHaveBeenCalled();
  });

  it("rejects a legacy stamp without closure provenance", async () => {
    const target = retiredTarget({ legacy: true });

    showMock.mockResolvedValue(target);
    expect(await settleCompletedRun(run([target], target), target)).toBe(false);
    expect(historyMock).not.toHaveBeenCalled();
    expect(updateRunMock).not.toHaveBeenCalled();
  });

  it("fails closed when it cannot read the closure history", async () => {
    const target = retiredTarget();

    showMock.mockResolvedValue(target);
    historyMock.mockRejectedValue(new Error("dolt offline"));
    expect(await settleCompletedRun(run([target], target), target)).toBe(false);
    expect(updateRunMock).not.toHaveBeenCalled();
  });
});
