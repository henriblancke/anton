/**
 * PR #238 review — {@link refreshRunBoard} only trusts the refreshed list when the pull that was
 * supposed to refresh it SUCCEEDED.
 *
 * On a non-server shared board, `beads.pull` failing but `loadAllIssues` succeeding against the
 * stale local clone still adopted the fresh-TARGET shape while marking the board trusted. The
 * short-circuit downstream (`settleCompletedRun`) then accepted a stale standalone retirement and
 * recorded the run done, stranding a child another machine had filed beneath the closed target.
 *
 * The seam it tests is two reads DISAGREEING inside one handler: the pull throws, the list still
 * succeeds, and the trust flag must come out false (the pull's success, not the list's).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "../beads/bd";

const pullMock = vi.fn<(cwd: string) => Promise<void>>();
const showMock = vi.fn<(cwd: string, id: string) => Promise<Bead>>();
const loadAllIssuesMock = vi.fn<(cwd: string, opts?: { strictGates?: boolean }) => Promise<Bead[]>>();

// Only the bd seam is stubbed — push/pull/shob spawn bd. The gate reasons over the real beads
// predicates, so the verdict the flags feed stays real.
vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      pull: (...a: unknown[]) => pullMock(...(a as [string])),
      show: (...a: unknown[]) => showMock(...(a as [string, string])),
    },
  };
});

vi.mock("../beads/issues", async () => {
  const actual = await vi.importActual<typeof import("../beads/issues")>("../beads/issues");
  return { ...actual, loadAllIssues: (...a: unknown[]) => loadAllIssuesMock(...(a as [string])) };
});

const { refreshRunBoard } = await import("./execute-epic-recover");
import type { EpicRun } from "./execute-epic-run";

const REPO = "/tmp/anton";
const TARGET = "anton-5bpd";

function bead(id = TARGET, over: Partial<Bead> = {}): Bead {
  return { id, issue_type: "feature", status: "open", ...over } as unknown as Bead;
}

function run(over: Partial<EpicRun> = {}): EpicRun {
  return {
    db: {},
    clock: { now: () => Date.now() },
    ctx: {},
    projectId: "p1",
    repo: REPO,
    runId: "run-1",
    branch: `anton/${TARGET}`,
    targetId: TARGET,
    all: [bead()],
    target: bead(),
    tickets: [bead()],
    standaloneRun: true,
    lease: { adoptOwn: vi.fn(), refuseForeign: vi.fn() },
    ...over,
  } as unknown as EpicRun;
}

describe("refreshRunBoard pull-success trust (PR #238 review)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pullMock.mockResolvedValue(undefined);
    showMock.mockImplementation(async (_cwd, id) => bead(id));
    loadAllIssuesMock.mockResolvedValue([bead()]);
  });

  it("trusts the refreshed board only when the pull succeeded", async () => {
    expect((await refreshRunBoard(run())).currentBoardTrusted).toBe(true);
    // A successful pull is first-class evidence of freshness, whatever the list read found.
    expect(pullMock).toHaveBeenCalledWith(REPO);
  });

  it("refuses to trust the refreshed target when the pull failed but the list still succeeded", async () => {
    pullMock.mockRejectedValue(new Error("dolt pull: database is locked"));
    // The list read is the stale local clone masked as fresh — the exact shape that used to mark the
    // board trusted regardless.
    loadAllIssuesMock.mockResolvedValue([bead(TARGET, { status: "closed" })]);

    const { currentBoardTrusted, preCheckTrusted } = await refreshRunBoard(run());

    expect(currentBoardTrusted).toBe(false);
    expect(preCheckTrusted).toBe(false);
    // The target WAS adopted from the list (the bug is the flag, not the adoption).
    expect(loadAllIssuesMock).toHaveBeenCalled();
  });

  it("still trusts the board when the pull is a no-op that resolves without throwing", async () => {
    // Server mode and no-remote both resolve `beads.pull` without throwing; that is the caller's
    // signal the list is whole — server by global reads, no-remote by having no other machine.
    pullMock.mockResolvedValue(undefined);
    expect((await refreshRunBoard(run())).currentBoardTrusted).toBe(true);
  });
});