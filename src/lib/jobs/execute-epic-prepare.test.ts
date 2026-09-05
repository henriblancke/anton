/**
 * anton-fude — WHEN {@link prepareEpicRun} asks whether a child is claimable, not just what the
 * answer is.
 *
 * The gate itself is pure and covered in execute-epic.unit.test.ts (`humanHeldTickets`). What can
 * only be proven here is that it is re-asked after every board this run ADOPTS: step 1c swaps in the
 * children the run-lease confirmed, the human-ticket arm swaps in the ones its own refresh brought
 * back, and the reservation cascade is followed by a board read of its own. A child a person blocks
 * or defers inside any of those windows is invisible to the pre-lease gate — and the run would then
 * dispatch its earlier siblings before dying at that ticket's claim gate, which is the exact failure
 * anton-fude exists to remove.
 *
 * Mocked at the module seam: the states under test are two board reads DISAGREEING inside one run,
 * which a real board cannot be asked for on demand.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "../beads/bd";

const refreshRunBoardMock = vi.fn();
const settleCompletedRunMock = vi.fn();
const warmRunWorktreeMock = vi.fn();
const claimRunTargetMock = vi.fn();
const cascadeChildClaimsMock = vi.fn();
const publishRunClaimMock = vi.fn();
const preflightHumanTicketsMock = vi.fn();
const loadAllIssuesMock = vi.fn();
const pullMock = vi.fn();
const updateRunMock = vi.fn();
const validateRunFormulaMock = vi.fn();
const hasPreservedCommitMock = vi.fn();

vi.mock("./execute-epic-recover", () => ({
  refreshRunBoard: (...args: unknown[]) => refreshRunBoardMock(...args),
  settleCompletedRun: (...args: unknown[]) => settleCompletedRunMock(...args),
}));

vi.mock("./execute-epic-claim", () => ({
  warmRunWorktree: (...args: unknown[]) => warmRunWorktreeMock(...args),
  claimRunTarget: (...args: unknown[]) => claimRunTargetMock(...args),
  cascadeChildClaims: (...args: unknown[]) => cascadeChildClaimsMock(...args),
  publishRunClaim: (...args: unknown[]) => publishRunClaimMock(...args),
}));

vi.mock("./execute-epic-human-gate", async () => {
  const actual =
    await vi.importActual<typeof import("./execute-epic-human-gate")>("./execute-epic-human-gate");
  return { ...actual, preflightHumanTickets: (...args: unknown[]) => preflightHumanTicketsMock(...args) };
});

// Only `pull` is stubbed: the post-reservation check refreshes the shared board before reading it,
// and a real pull would spawn bd.
vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return { ...actual, beads: { ...actual.beads, pull: (...args: unknown[]) => pullMock(...args) } };
});

vi.mock("../beads/issues", async () => {
  const actual = await vi.importActual<typeof import("../beads/issues")>("../beads/issues");
  return { ...actual, loadAllIssues: (...args: unknown[]) => loadAllIssuesMock(...args) };
});

// The lock serializes writes against other processes; inside one test there is nothing to serialize.
vi.mock("../beads/claim-lock", () => ({
  withBeadWriteLock: <T>(_repo: string, _id: string, fn: () => Promise<T>) => fn(),
}));

vi.mock("../runs", async () => {
  const actual = await vi.importActual<typeof import("../runs")>("../runs");
  return { ...actual, updateRun: (...args: unknown[]) => updateRunMock(...args) };
});

vi.mock("./run-formula", async () => {
  const actual = await vi.importActual<typeof import("./run-formula")>("./run-formula");
  return { ...actual, validateRunFormula: (...args: unknown[]) => validateRunFormulaMock(...args) };
});

// The worktree here is a mock path, so the preserved-work shape gate (anton-d967) has no history to
// read — stubbed to "no preserved commit", the answer that lets these board tests run. The gate
// itself is proven against a real repo in execute-epic.preserve.test.ts.
vi.mock("../git/ops", async () => {
  const actual = await vi.importActual<typeof import("../git/ops")>("../git/ops");
  return {
    ...actual,
    worktreeHasPreservedCommitFor: (...args: unknown[]) => hasPreservedCommitMock(...args),
  };
});

vi.mock("./formula-floor", () => ({ assertRunFormulaFloor: () => {} }));

vi.mock("./execute-epic-formula", () => ({
  splitFormulaPhases: () => ({ ticketSteps: [], runSteps: [] }),
}));

const { prepareEpicRun } = await import("./execute-epic-prepare");
const { PoisonEpic } = await import("./errors");
import type { EpicRun } from "./execute-epic-run";

const REPO = "/tmp/anton";
const TARGET = "anton-fude";

const feature = (): Bead => ({ id: TARGET, title: "Feature", issue_type: "feature", status: "open" }) as Bead;

const ticket = (id: string, status = "open"): Bead =>
  ({ id, title: id, issue_type: "task", status, parent: TARGET }) as Bead;

/** The board every read in the run answers with, unless a test hands a later read a different one. */
const board = (...tickets: Bead[]): Bead[] => [feature(), ...tickets];

/** The minimal run `prepareEpicRun` reads — everything else it touches is mocked at its module. */
function run(all: Bead[]): EpicRun {
  const target = all.find((b) => b.id === TARGET)!;
  return {
    db: {},
    clock: {},
    ctx: { signal: undefined },
    projectId: "p1",
    repo: REPO,
    targetId: TARGET,
    branch: `anton/${TARGET}`,
    runId: "run-1",
    // A pinned formula, so the pipeline resolves without a branch lookup.
    existing: { formula: "bundled:default", formulaVariant: null },
    settings: { agents: undefined },
    userAgentIds: [],
    lease: {
      refuseForeign: vi.fn(),
      adopt: vi.fn(),
      claim: vi.fn().mockResolvedValue(undefined),
      startRefresh: vi.fn(),
    },
    all,
    target,
    standaloneRun: false,
    tickets: all.filter((b) => b.id !== TARGET),
    readiness: () => ({ blockers: [], gated: [], runnable: true }),
  } as unknown as EpicRun;
}

/** What the arm hands back when it acted on human work and adopted the board its refresh returned. */
function preflight(adopted: Bead[]) {
  const target = adopted.find((b) => b.id === TARGET)!;
  const children = adopted.filter((b) => b.id !== TARGET);
  return {
    board: adopted,
    target,
    children,
    tickets: children,
    answeredButBlocked: new Map<string, string[]>(),
    armed: true,
  };
}

/** Run the preparation and hand back the error it refused with (failing if it didn't refuse). */
async function refusalFrom(all: Bead[]): Promise<Error> {
  const caught = await prepareEpicRun(run(all)).then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  expect(caught).toBeInstanceOf(Error);
  return caught as Error;
}

beforeEach(() => {
  vi.clearAllMocks();
  refreshRunBoardMock.mockImplementation((r: EpicRun) =>
    Promise.resolve({ preCheckTrusted: true, leaseTarget: r.target }),
  );
  settleCompletedRunMock.mockResolvedValue(false);
  validateRunFormulaMock.mockResolvedValue({
    source: "bundled:default",
    recorded: "bundled:default",
    variant: undefined,
    cooked: {},
    steps: [],
  });
  updateRunMock.mockResolvedValue(undefined);
  warmRunWorktreeMock.mockResolvedValue({ worktree: { path: "/tmp/wt" }, runStep: {} });
  claimRunTargetMock.mockResolvedValue(undefined);
  cascadeChildClaimsMock.mockResolvedValue(undefined);
  pullMock.mockResolvedValue(undefined);
  publishRunClaimMock.mockResolvedValue(undefined);
  hasPreservedCommitMock.mockResolvedValue(false);
  // No human work by default: nothing written, nothing adopted.
  preflightHumanTicketsMock.mockImplementation((args: { board: Bead[] }) =>
    Promise.resolve({ ...preflight(args.board), armed: false }),
  );
});

describe("prepareEpicRun — a held child is caught on every board the run adopts (anton-fude)", () => {
  it("parks on the pre-lease read when a child is already blocked", async () => {
    const all = board(ticket("t-1"), ticket("t-2", "blocked"));
    loadAllIssuesMock.mockResolvedValue(all);

    const error = await refusalFrom(all);

    expect(error).toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain("t-2");
    expect(error.message).toContain("blocked pending human review");
    // Read-only refusal: the lease was never taken, so the park leaves nothing behind.
    expect(warmRunWorktreeMock).not.toHaveBeenCalled();
  });

  it("parks when the LEASE-confirmed board is the first to show the block", async () => {
    // A person blocks the sibling between the pre-lease read and step 1c's confirmation, which
    // adopts the confirmed children in place of the ones every gate above judged.
    const all = board(ticket("t-1"), ticket("t-2"));
    loadAllIssuesMock.mockResolvedValue(board(ticket("t-1"), ticket("t-2", "blocked")));

    const error = await refusalFrom(all);

    expect(error).toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain("t-2");
    // Caught before the arm, and long before any checkout or claim exists.
    expect(preflightHumanTicketsMock).not.toHaveBeenCalled();
    expect(warmRunWorktreeMock).not.toHaveBeenCalled();
    expect(claimRunTargetMock).not.toHaveBeenCalled();
  });

  it("parks when the HUMAN-TICKET arm's refresh is the first to show the block", async () => {
    // The regression this test exists for: the arm's post-refresh adoption overwrites the children
    // both gates above already judged, so a sibling deferred in that window arrived unjudged and the
    // run dispatched t-1 before dying at t-2's claim gate.
    const all = board(ticket("t-1"), ticket("t-2"));
    loadAllIssuesMock.mockResolvedValue(all);
    preflightHumanTicketsMock.mockResolvedValue(
      preflight(board(ticket("t-1"), ticket("t-2", "deferred"))),
    );

    const error = await refusalFrom(all);

    expect(error).toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain("t-2");
    expect(error.message).toContain("is deferred");
    // The arm ran (its waits stand for the resume to reuse), but nothing past it did.
    expect(preflightHumanTicketsMock).toHaveBeenCalled();
    expect(warmRunWorktreeMock).not.toHaveBeenCalled();
    expect(claimRunTargetMock).not.toHaveBeenCalled();
  });

  it("parks when only the board taken AFTER the reservation shows the block", async () => {
    // PR #227 review: every ask above the reservation judges a board read before the worktree warm,
    // which is minutes wide. A person blocking a LATER child inside it was invisible to all of them
    // — the cascade reserves it regardless (assignment is not a claim), and the loop would dispatch
    // t-1 before dying at t-2's claim gate.
    const all = board(ticket("t-1"), ticket("t-2"));
    loadAllIssuesMock
      .mockResolvedValueOnce(all) // step 1c's confirmation: still clean
      .mockResolvedValue(board(ticket("t-1"), ticket("t-2", "blocked")));
    preflightHumanTicketsMock.mockResolvedValue(preflight(all));

    const error = await refusalFrom(all);

    expect(error).toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain("t-2");
    expect(error.message).toContain("blocked pending human review");
    // The reservation stands (the stopping path hands it back), but nothing was published or run.
    expect(cascadeChildClaimsMock).toHaveBeenCalled();
    expect(publishRunClaimMock).not.toHaveBeenCalled();
  });

  it("retries rather than dispatching when the post-reservation board can't be read", async () => {
    const all = board(ticket("t-1"), ticket("t-2"));
    loadAllIssuesMock
      .mockResolvedValueOnce(all)
      .mockRejectedValue(new Error("Error 1105: database is locked"));
    preflightHumanTicketsMock.mockResolvedValue(preflight(all));

    const error = await refusalFrom(all);

    // Fails CLOSED but retryable: the next attempt reuses this worktree and its reservations.
    expect(error).not.toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain("could not refresh and re-read the board");
    expect(publishRunClaimMock).not.toHaveBeenCalled();
  });

  it("refreshes the shared board before that read, so a block another machine wrote is seen", async () => {
    // PR #227 review: on an embedded board `loadAllIssues` lists only the local database, and the
    // claim publication a line later pulls anyway — so reading without pulling first would clear a
    // child that publication immediately imports as blocked. The pull below is what makes the
    // second read differ, exactly as a remote block arriving with it would.
    const all = board(ticket("t-1"), ticket("t-2"));
    loadAllIssuesMock.mockResolvedValue(all);
    pullMock.mockImplementation(() => {
      loadAllIssuesMock.mockResolvedValue(board(ticket("t-1"), ticket("t-2", "blocked")));
      return Promise.resolve();
    });
    preflightHumanTicketsMock.mockResolvedValue(preflight(all));

    const error = await refusalFrom(all);

    expect(error).toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain("t-2");
    expect(error.message).toContain("blocked pending human review");
    expect(publishRunClaimMock).not.toHaveBeenCalled();
  });

  it("retries rather than dispatching when that board can't be refreshed", async () => {
    const all = board(ticket("t-1"), ticket("t-2"));
    loadAllIssuesMock.mockResolvedValue(all);
    pullMock.mockRejectedValue(new Error("fetch from origin/main: connection refused"));
    preflightHumanTicketsMock.mockResolvedValue(preflight(all));

    const error = await refusalFrom(all);

    // Fails CLOSED but retryable: a run that cannot prove it is looking at the current board must
    // not publish its claim and enter the loop.
    expect(error).not.toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain("could not refresh and re-read the board");
    expect(publishRunClaimMock).not.toHaveBeenCalled();
  });

  it("runs the independent siblings of a blocked child a cross-run blocker holds (PR #227 review)", async () => {
    // t-2 waits on a `blocks` edge OUTSIDE this run, so the dispatch loop parks it in the held tail
    // and never claims it — its status reaches no claim gate. Parking the whole run over it would
    // stall t-1, the partial gating anton-1two exists to keep.
    const all = board(ticket("t-1"), ticket("t-2", "blocked"));
    loadAllIssuesMock.mockResolvedValue(all);
    preflightHumanTicketsMock.mockResolvedValue(preflight(all));
    const gatedRun = run(all);
    gatedRun.readiness = () => ({ blockers: ["anton-elsewhere"], gated: ["t-2"], runnable: true });

    const prep = await prepareEpicRun(gatedRun);

    expect(prep.done).toBe(false);
    if (prep.done) return;
    expect([...prep.gated]).toContain("t-2");
    expect(publishRunClaimMock).toHaveBeenCalled();
  });

  it("prepares the run when every board it adopts leaves the children claimable", async () => {
    const all = board(ticket("t-1"), ticket("t-2"));
    loadAllIssuesMock.mockResolvedValue(all);
    preflightHumanTicketsMock.mockResolvedValue(preflight(all));

    const prep = await prepareEpicRun(run(all));

    expect(prep.done).toBe(false);
    expect(warmRunWorktreeMock).toHaveBeenCalled();
    expect(claimRunTargetMock).toHaveBeenCalled();
    expect(publishRunClaimMock).toHaveBeenCalled();
  });
});
