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
import type { Bead } from "../beads/bd";
import { repairLabel } from "../gardener/repair";

const showMock = vi.fn();
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
  closedAt = "2026-09-09T00:00:00.000Z",
}: { stampAt?: number; closedAt?: string } = {}): Bead {
  return {
    id: TARGET,
    issue_type: "feature",
    status: "closed",
    // Built with the real stamper, so the fixture can't drift from the label format the gate parses.
    labels: [repairLabel(TARGET, "already-shipped", stampAt)],
    closed_at: closedAt,
    dependencies: [{ type: "supersedes", issue_id: TARGET, depends_on_id: SURVIVOR }],
    notes: "retired as already shipped",
  } as unknown as Bead;
}

/** A ticket the refreshed board shows under the target — the child the snapshot did not have. */
function child(): Bead {
  return { id: "anton-kid", issue_type: "task", status: "open", parent_id: TARGET } as unknown as Bead;
}

function run(all: Bead[], target: Bead): EpicRun {
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
    // The stale snapshot verdict: read before the child existed.
    standaloneRun: true,
    lease: { adoptOwn: vi.fn(), refuseForeign: vi.fn() },
  } as unknown as EpicRun;
}

describe("settleCompletedRun retirement short-circuit (run shape)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pullMock.mockResolvedValue(undefined);
    isServerModeMock.mockReturnValue(false);
    showMock.mockImplementation(async () => retiredTarget());
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
    // Settled as a finished run, with no PR, exactly as the uninterrupted attempt would.
    expect(updateRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "run-1",
      expect.objectContaining({ status: "done" }),
    );
  });

  it("poisons the run when the adjacent board recheck finds a new child", async () => {
    const target = retiredTarget();
    loadAllIssuesMock.mockResolvedValue([target, child()]);

    await expect(settleCompletedRun(run([target], target), target)).rejects.toThrow(
      "gained child tickets before anton could settle",
    );
    expect(updateRunMock).not.toHaveBeenCalled();
  });

  it("poisons the run when a child lands while the terminal row is written", async () => {
    const target = retiredTarget();
    loadAllIssuesMock
      .mockResolvedValueOnce([target])
      .mockResolvedValueOnce([target, child()]);

    await expect(settleCompletedRun(run([target], target), target)).rejects.toThrow(
      "gained child tickets while anton recorded",
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
      "gained child tickets before anton could settle",
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

  it("rejects a stamp left by a retirement cycle before the current closure", async () => {
    const target = retiredTarget({
      stampAt: Date.parse("2026-09-09T00:00:00.000Z"),
      closedAt: "2026-09-09T00:00:01.000Z",
    });

    showMock.mockResolvedValue(target);
    expect(await settleCompletedRun(run([target], target), target)).toBe(false);
    expect(updateRunMock).not.toHaveBeenCalled();
  });
});
