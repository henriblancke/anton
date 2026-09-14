/**
 * The run-shape seam (anton-8x1k): the two helpers {@link prepareEpicRun} threads through this
 * module. Their board-facing behaviour is proven end-to-end in execute-epic-prepare.test.ts and the
 * integration suites; what is asserted HERE is the seam's own contract — that the pipeline resolves
 * and records, and that the lease is taken UNDER the write lock with the injected confirmation run
 * inside it.
 *
 * Mocked at the module seam: the heavy formula/lease dependencies are stubbed so each helper's own
 * control flow is what the test exercises.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "../beads/bd";

const withBeadWriteLockMock = vi.fn();
const updateRunMock = vi.fn();
const findRunFormulaForBranchMock = vi.fn();
const validateRunFormulaMock = vi.fn();
const assertRunFormulaFloorMock = vi.fn();
const splitFormulaPhasesMock = vi.fn();

vi.mock("../beads/claim-lock", () => ({
  withBeadWriteLock: <T>(repo: string, id: string, fn: () => Promise<T>) =>
    withBeadWriteLockMock(repo, id, fn),
}));

vi.mock("../runs", async () => {
  const actual = await vi.importActual<typeof import("../runs")>("../runs");
  return {
    ...actual,
    updateRun: (...args: unknown[]) => updateRunMock(...args),
    findRunFormulaForBranch: (...args: unknown[]) => findRunFormulaForBranchMock(...args),
  };
});

vi.mock("./run-formula", async () => {
  const actual = await vi.importActual<typeof import("./run-formula")>("./run-formula");
  return { ...actual, validateRunFormula: (...args: unknown[]) => validateRunFormulaMock(...args) };
});

vi.mock("./formula-floor", () => ({ assertRunFormulaFloor: (...args: unknown[]) => assertRunFormulaFloorMock(...args) }));

vi.mock("./execute-epic-formula", () => ({
  splitFormulaPhases: (...args: unknown[]) => splitFormulaPhasesMock(...args),
}));

const { resolveRunPipeline, takeRunLease } = await import("./execute-epic-run-shape");
import type { EpicRun } from "./execute-epic-run";

const REPO = "/tmp/anton";
const TARGET = "anton-8x1k";

/** The minimal run the seam reads — everything else is mocked at its module. */
function run(overrides: Partial<EpicRun> = {}): EpicRun {
  return {
    db: {},
    clock: {},
    projectId: "p1",
    repo: REPO,
    runId: "run-1",
    branch: `anton/${TARGET}`,
    targetId: TARGET,
    settings: { formulaVariants: undefined },
    existing: { formula: "bundled:default", formulaVariant: null },
    target: { id: TARGET, labels: [] },
    standaloneRun: false,
    lease: { claim: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  } as unknown as EpicRun;
}

beforeEach(() => {
  vi.clearAllMocks();
  withBeadWriteLockMock.mockImplementation((_repo, _id, fn: () => Promise<unknown>) => fn());
  updateRunMock.mockResolvedValue(undefined);
  validateRunFormulaMock.mockResolvedValue({
    source: "bundled:default",
    recorded: "bundled:default",
    variant: undefined,
  });
  assertRunFormulaFloorMock.mockReturnValue(undefined);
  splitFormulaPhasesMock.mockReturnValue({ ticketSteps: ["a"], runSteps: ["b"] });
});

describe("resolveRunPipeline", () => {
  it("floor-checks the cooked pipeline, records the RECORDED source, and returns the split phases", async () => {
    const result = await resolveRunPipeline(run());

    // A pinned formula resolves without a branch lookup.
    expect(findRunFormulaForBranchMock).not.toHaveBeenCalled();
    expect(assertRunFormulaFloorMock).toHaveBeenCalledOnce();
    // `recorded`, not `source`: what survives an install-root move (anton).
    expect(updateRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "run-1",
      { formula: "bundled:default", formulaVariant: null },
    );
    expect(result).toEqual({ ticketSteps: ["a"], runSteps: ["b"] });
  });

  it("looks the pipeline up by branch when no attempt has pinned one", async () => {
    findRunFormulaForBranchMock.mockResolvedValue({ source: "project:default", variant: undefined });

    await resolveRunPipeline(run({ existing: undefined }));

    expect(findRunFormulaForBranchMock).toHaveBeenCalledWith(
      expect.anything(),
      "p1",
      TARGET,
      `anton/${TARGET}`,
    );
    expect(validateRunFormulaMock).toHaveBeenCalledOnce();
  });

  it("lets a floor violation surface — a broken pipeline fails before any worktree", async () => {
    assertRunFormulaFloorMock.mockImplementation(() => {
      throw new Error("formula omits the commit step");
    });

    await expect(resolveRunPipeline(run())).rejects.toThrow("formula omits the commit step");
    expect(updateRunMock).not.toHaveBeenCalled();
    expect(splitFormulaPhasesMock).not.toHaveBeenCalled();
  });
});

describe("takeRunLease", () => {
  it("claims the lease UNDER the write lock, then runs the injected confirmation inside it", async () => {
    const order: string[] = [];
    const r = run();
    (r.lease.claim as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push("claim");
      return Promise.resolve();
    });
    withBeadWriteLockMock.mockImplementation(async (_repo, _id, fn: () => Promise<unknown>) => {
      order.push("lock");
      return fn();
    });
    const children = [{ id: "t-1" }] as Bead[];
    const confirmed = [{ id: "t-1" }, { id: "t-2" }] as Bead[];
    const confirm = vi.fn(async () => {
      order.push("confirm");
      return confirmed;
    });

    const result = await takeRunLease(r, true, children, confirm);

    expect(order).toEqual(["lock", "claim", "confirm"]);
    expect(withBeadWriteLockMock).toHaveBeenCalledWith(REPO, TARGET, expect.any(Function));
    expect(r.lease.claim).toHaveBeenCalledWith(true);
    expect(confirm).toHaveBeenCalledWith(r, children);
    expect(result).toBe(confirmed);
  });

  it("propagates a confirmation refusal (drift/park) rather than proceeding", async () => {
    const r = run();
    const confirm = vi.fn().mockRejectedValue(new Error("ticket set changed"));

    await expect(takeRunLease(r, false, [], confirm)).rejects.toThrow("ticket set changed");
    expect(r.lease.claim).toHaveBeenCalledOnce();
  });
});
