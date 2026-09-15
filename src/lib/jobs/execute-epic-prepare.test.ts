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
import { LABELS, type Bead } from "../beads/bd";
import { attachCycleEvidence } from "../beads/cycle-evidence";
import { HUMAN_GATE_ARMED_LABEL, humanGateReason, humanTicketAsk } from "./execute-epic-human-gate";

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
const checkSelfFreshnessMock = vi.fn();

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

// The self-freshness gate (anton-mh3c) would otherwise fetch anton's OWN checkout on every start —
// a real network read against process.cwd(). Stubbed to a clean verdict by default, so only the
// tests that ask for a stale one exercise the refusal.
vi.mock("./self-freshness", () => ({
  checkSelfFreshness: (...args: unknown[]) => checkSelfFreshnessMock(...args),
  selfRepoRoot: () => "/anton",
}));

vi.mock("./formula-floor", () => ({ assertRunFormulaFloor: () => {} }));

vi.mock("./execute-epic-formula", () => ({
  splitFormulaPhases: () => ({ ticketSteps: [], runSteps: [] }),
}));

const { prepareEpicRun } = await import("./execute-epic-prepare");
// The staleness preflight lives in execute-epic-freshness.ts (forwarded to prepare through the
// run-shape seam), so its pure unit imports from there; the self-freshness mock above intercepts the
// import regardless of which module reads it.
const { assertPreStartPoisonIsFresh, staleCheckoutRefusal } = await import(
  "./execute-epic-freshness"
);
const { PoisonEpic, StaleCheckoutError } = await import("./errors");
import type { EpicRun } from "./execute-epic-run";

const REPO = "/tmp/anton";
const TARGET = "anton-fude";

// Approved (PR #274 review, round 6): a target only ever reaches `prepareEpicRun` once
// `assertRunnableTarget` (execute-epic-start.ts) has already required this label, and
// `assertPublishedBoardCycleFree`'s own late re-check of it (`staleClaimReason`) would otherwise
// poison every board this fixture builds.
const feature = (): Bead =>
  ({ id: TARGET, title: "Feature", issue_type: "feature", status: "open", labels: [LABELS.approved] }) as Bead;

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
    // Mirrors the real preflight: every `agent:human` ticket it is handed a board carrying gets a
    // wait armed (or closed, if answered) — `handled` is that set, not merely `gated`'s superset.
    handled: new Set(children.filter((c) => c.labels?.includes(LABELS.agentHuman)).map((c) => c.id)),
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
  // anton is running its own latest code by default, so the self-freshness gate lets every start
  // through — only the tests that hand it a stale verdict exercise the refusal.
  checkSelfFreshnessMock.mockResolvedValue({
    checkout: { state: "current" },
    dependencies: { state: "match" },
    build: { state: "current" },
  });
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

  // Fresh evidence (PR #274 review, round 9): `ticketSetDrift` only compares ids, so a child that
  // keeps its id but has its STATUS flipped to `blocked`/`deferred` by `publishRunClaim`'s own sync
  // rides straight through it — and readiness never asks about status either, only `blocks` edges.
  // Before this fix nothing re-read `assertTicketsClaimable` against the board that sync pulled, so
  // this run adopted t-2 as dispatchable and would have dispatched t-1 before dying at t-2's own
  // hard claim gate.
  it("parks when only the board publishRunClaim's own sync pulled shows a child's status change", async () => {
    const all = board(ticket("t-1"), ticket("t-2"));
    loadAllIssuesMock
      .mockResolvedValueOnce(all) // step 1c's confirmation: still clean
      .mockResolvedValueOnce(all) // step 3b-bis's reserved-board read: still clean
      .mockResolvedValue(board(ticket("t-1"), ticket("t-2", "blocked"))); // publish's own sync
    preflightHumanTicketsMock.mockResolvedValue(preflight(all));

    const error = await refusalFrom(all);

    expect(error).toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain("t-2");
    expect(error.message).toContain("blocked pending human review");
    // Caught on the board publishRunClaim's own sync just pulled, not before it — the claim did
    // publish.
    expect(publishRunClaimMock).toHaveBeenCalled();
  });
});

describe("prepareEpicRun — the structure/cycle gate re-runs on the board the refresh adopted (PR #274 review)", () => {
  // execute-epic-start.ts's top-of-handler structure/cycle check (added for this same PR) only ever
  // sees the PRE-pull snapshot. `refreshRunBoard`'s pull, mocked away here exactly as it is in every
  // other test in this file, is what can land a `blocks` cycle among this run's own tickets AFTER
  // that check ran — this gate is what catches it on the board `regateRefreshedBoard` reads (`run.all`),
  // rather than letting `runReadiness` wave it through as mere ordering.
  it("poisons a run whose freshly-pulled board carries a blocks cycle among its own tickets", async () => {
    const t1: Bead = {
      ...ticket("t-1"),
      dependencies: [{ type: "blocks", issue_id: "t-1", depends_on_id: "t-2" }],
    } as Bead;
    const t2: Bead = {
      ...ticket("t-2"),
      dependencies: [{ type: "blocks", issue_id: "t-2", depends_on_id: "t-1" }],
    } as Bead;
    const all = board(t1, t2);
    attachCycleEvidence(all, [{ ids: ["t-1", "t-2"], raw: {} }]);
    loadAllIssuesMock.mockResolvedValue(all);
    preflightHumanTicketsMock.mockResolvedValue(preflight(all));

    const error = await refusalFrom(all);

    expect(error).toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain(TARGET);
    expect(error.message).toContain("breaks the tier structure");
    expect(error.message).toContain("sits in a blocks cycle");
    // Nothing held: no worktree or claim over a graph the run cannot dispatch.
    expect(warmRunWorktreeMock).not.toHaveBeenCalled();
    expect(claimRunTargetMock).not.toHaveBeenCalled();
  });

  it("leaves a cycle-free freshly-pulled board alone — bd's own evidence says the graph is safe", async () => {
    const t1 = ticket("t-1");
    const t2: Bead = {
      ...ticket("t-2"),
      dependencies: [{ type: "blocks", issue_id: "t-2", depends_on_id: "t-1" }],
    } as Bead;
    const all = board(t1, t2);
    attachCycleEvidence(all, []);
    loadAllIssuesMock.mockResolvedValue(all);
    preflightHumanTicketsMock.mockResolvedValue(preflight(all));

    const prep = await prepareEpicRun(run(all));

    expect(prep.done).toBe(false);
    expect(publishRunClaimMock).toHaveBeenCalled();
  });

  // The gate above proves an acyclic edge landing in this window doesn't false-poison the run — but
  // proving that alone left the edge itself un-adopted: `structureGaps` only rejects a CYCLE, so a
  // valid `blocks` edge between the run's own tickets passes it and, before this fix, was then
  // discarded — `run.all`/`run.tickets` kept the pre-edge board, and dispatch's
  // `orderTickets(tickets, all)` would never see the new prerequisite (PR #274 review, round 3).
  it("adopts the board publishRunClaim's own sync pulled, edge and all, once it clears the gate", async () => {
    const preEdge = board(ticket("t-1"), ticket("t-2"));
    attachCycleEvidence(preEdge, []);
    const t2WithEdge: Bead = {
      ...ticket("t-2"),
      dependencies: [{ type: "blocks", issue_id: "t-2", depends_on_id: "t-1" }],
    } as Bead;
    const postEdge = board(ticket("t-1"), t2WithEdge);
    attachCycleEvidence(postEdge, []);
    preflightHumanTicketsMock.mockResolvedValue(preflight(preEdge));
    // The first two reads (the lease's confirmation, then the pre-publish claimability check) see
    // no edge; only the read after `publishRunClaim`'s own sync — the one this gate covers — does.
    loadAllIssuesMock.mockResolvedValueOnce(preEdge).mockResolvedValueOnce(preEdge).mockResolvedValue(postEdge);

    const theRun = run(preEdge);
    const prep = await prepareEpicRun(theRun);

    expect(prep.done).toBe(false);
    expect(theRun.all).toBe(postEdge);
    const adoptedT2 = theRun.tickets.find((t) => t.id === "t-2");
    expect(adoptedT2?.dependencies).toEqual([
      { type: "blocks", issue_id: "t-2", depends_on_id: "t-1" },
    ]);
  });

  // A cycle is not the only shape this window can land: a valid new EXTERNAL blocker on one of the
  // run's own tickets is just as invisible to `structureGaps` (it blocks nothing, so nothing is
  // cyclic), and unlike the internal edge above, it must gate a ticket rather than merely reorder it.
  // Before this fix, `assertPublishedBoardCycleFree` adopted the board into `run.all`/`run.tickets`
  // but returned the STALE `gates.gated` its caller captured earlier — so `partitionTickets` would
  // dispatch the newly-blocked ticket anyway (PR #274 review, round 4).
  it("recomputes readiness and the gated set from the board publishRunClaim's own sync pulled", async () => {
    const preEdge = board(ticket("t-1"), ticket("t-2"));
    attachCycleEvidence(preEdge, []);
    const postBlock = board(ticket("t-1"), ticket("t-2"));
    attachCycleEvidence(postBlock, []);
    preflightHumanTicketsMock.mockResolvedValue(preflight(preEdge));
    // The first two reads (the lease's confirmation, then the pre-publish claimability check) see
    // the pre-block board; only the read after `publishRunClaim`'s own sync sees the new blocker.
    loadAllIssuesMock.mockResolvedValueOnce(preEdge).mockResolvedValueOnce(preEdge).mockResolvedValue(postBlock);

    const theRun = run(preEdge);
    // Readiness reacts to the board it's handed, the same way a real `runReadiness` would once a
    // fresh external `blocks` edge lands on t-2: gated only once the ADOPTED board carries it.
    theRun.readiness = (b: Bead[]) => {
      const gatedOnPostBlock = b === postBlock;
      return {
        blockers: gatedOnPostBlock ? ["anton-elsewhere"] : [],
        gated: gatedOnPostBlock ? ["t-2"] : [],
        runnable: true,
      };
    };

    const prep = await prepareEpicRun(theRun);

    expect(prep.done).toBe(false);
    if (prep.done) return;
    expect([...prep.gated]).toContain("t-2");
    expect(prep.readiness.blockers).toContain("anton-elsewhere");
  });

  // The target's OWN eligibility, not just its `agent:human` label, is re-asked against the board
  // `publishRunClaim`'s own sync just pulled (PR #274 review, round 6): `adoptRefreshedTarget` alone
  // never asked whether the target is still approved, still live, or still shaped as a run target —
  // so a change landing in this exact window rode straight through and this run dispatched into it.
  it("parks when the target was unapproved by the board publish just pulled", async () => {
    const clean = board(ticket("t-1"));
    attachCycleEvidence(clean, []);
    const unapproved = board(ticket("t-1"));
    unapproved[0] = { ...unapproved[0], labels: [] } as Bead;
    attachCycleEvidence(unapproved, []);
    preflightHumanTicketsMock.mockResolvedValue(preflight(clean));
    // The first two reads (the lease's confirmation, then the pre-publish claimability check) see
    // the still-approved target; only the read after `publishRunClaim`'s own sync sees it withdrawn.
    loadAllIssuesMock.mockResolvedValueOnce(clean).mockResolvedValueOnce(clean).mockResolvedValue(unapproved);

    const error = await refusalFrom(clean);

    expect(error).toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain(TARGET);
    expect(error.message).toContain("approval was withdrawn");
    // Parked, not retried — an unapproved target doesn't become approved again by trying.
    expect(publishRunClaimMock).toHaveBeenCalled();
  });

  it("parks when the target was abandoned by the board publish just pulled", async () => {
    const clean = board(ticket("t-1"));
    attachCycleEvidence(clean, []);
    const abandoned = board(ticket("t-1"));
    abandoned[0] = { ...abandoned[0], labels: [LABELS.approved, LABELS.abandoned] } as Bead;
    attachCycleEvidence(abandoned, []);
    preflightHumanTicketsMock.mockResolvedValue(preflight(clean));
    loadAllIssuesMock.mockResolvedValueOnce(clean).mockResolvedValueOnce(clean).mockResolvedValue(abandoned);

    const error = await refusalFrom(clean);

    expect(error).toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain(TARGET);
    expect(error.message).toContain("abandoned");
  });

  it("parks when the target vanished from the board publish just pulled", async () => {
    const clean = board(ticket("t-1"));
    attachCycleEvidence(clean, []);
    const vanished = [ticket("t-1")];
    attachCycleEvidence(vanished, []);
    preflightHumanTicketsMock.mockResolvedValue(preflight(clean));
    loadAllIssuesMock.mockResolvedValueOnce(clean).mockResolvedValueOnce(clean).mockResolvedValue(vanished);

    const error = await refusalFrom(clean);

    expect(error).toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain(TARGET);
    expect(error.message).toContain("no longer on the board");
  });

  it("parks when a standalone target was reparented under another card by the publish sync", async () => {
    // The case the review names explicitly: a parentless task/bug (a standalone run's own single
    // ticket) that an approved gardener re-parent lands under another card in this exact window.
    // `isRunTarget` excludes a parented task, so the target that published this run's claim is, by
    // the time the sync lands, executing as someone ELSE's ticket.
    const standalone: Bead = {
      id: TARGET,
      title: "Standalone",
      issue_type: "task",
      status: "open",
      labels: [LABELS.approved],
    } as Bead;
    const preReparent = [standalone];
    attachCycleEvidence(preReparent, []);
    const reparented: Bead = { ...standalone, parent: "anton-other" } as Bead;
    const postReparent = [reparented];
    attachCycleEvidence(postReparent, []);
    preflightHumanTicketsMock.mockResolvedValue(preflight(preReparent));
    // A standalone target's subtree is empty (it IS its own ticket), so
    // `assertReservedTicketsClaimable` skips its own board read (`gates.children.length === 0`) —
    // only the lease confirmation (step 1c) and this gate's own read consume the mock queue.
    loadAllIssuesMock.mockResolvedValueOnce(preReparent).mockResolvedValue(postReparent);

    const theRun = run(preReparent);
    theRun.standaloneRun = true;
    theRun.tickets = [standalone];

    const error = await prepareEpicRun(theRun).then(
      () => undefined,
      (e: unknown) => e as Error,
    );

    expect(error).toBeInstanceOf(PoisonEpic);
    expect((error as Error).message).toContain(TARGET);
    expect((error as Error).message).toContain("no longer a run target");
  });

  // Fresh evidence (PR #274 review): a previously CHILDLESS feature — a standalone run's own single
  // ticket, same as the reparent case above — gains its FIRST child during the publish sync instead.
  // `run.standaloneRun` still reads `true` from before that sync, so before this fix `freshTickets`
  // stayed `[adoptedTarget]`, the id-only drift check saw no change (the target's own id never
  // moved), and this run would have dispatched the feature itself as a standalone ticket — the new
  // child bypassing the reservation, contract and human-work gates entirely.
  it("retries when a standalone target gains its first child during the publish sync", async () => {
    const childless = board();
    attachCycleEvidence(childless, []);
    const withChild = board(ticket("t-1"));
    attachCycleEvidence(withChild, []);
    preflightHumanTicketsMock.mockResolvedValue(preflight(childless));
    // A standalone target's subtree is empty (it IS its own ticket), so
    // `assertReservedTicketsClaimable` skips its own board read (`gates.children.length === 0`) —
    // only the lease confirmation (step 1c) and this gate's own read consume the mock queue.
    loadAllIssuesMock.mockResolvedValueOnce(childless).mockResolvedValue(withChild);

    const theRun = run(childless);
    theRun.standaloneRun = true;
    theRun.tickets = [theRun.target];

    const error = await prepareEpicRun(theRun).then(
      () => undefined,
      (e: unknown) => e as Error,
    );

    // Retryable, not a park: the next attempt re-enters from the top, where every gate — allowlist,
    // contract, claimable, human — runs over the newly-grouped feature's real ticket set.
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PoisonEpic);
    expect((error as Error).message).toContain(TARGET);
    expect((error as Error).message).toContain("attached t-1");
    expect(publishRunClaimMock).toHaveBeenCalled();
  });

  // A child's `agent:human` relabel, not just the target's own label, is watched too (PR #274
  // review, round 6): `armHumanTicketWaits` classified and armed its gates on the board ITS OWN
  // refresh brought back, which sits before `publishRunClaim`'s sync. A relabel landing in that gap
  // keeps the ticket's id in both sets, so `ticketSetDrift` (id-only, by design) reads it as no
  // change — before this fix nothing downstream asked the label again, and a person's work would
  // have dispatched to the default agent with no wait ever armed for it.
  it("retries rather than dispatching when a child was relabelled agent:human by the publish sync", async () => {
    const clean = board(ticket("t-1"), ticket("t-2"));
    attachCycleEvidence(clean, []);
    const relabelled = board(ticket("t-1"), { ...ticket("t-2"), labels: [LABELS.agentHuman] } as Bead);
    attachCycleEvidence(relabelled, []);
    preflightHumanTicketsMock.mockResolvedValue(preflight(clean));
    loadAllIssuesMock.mockResolvedValueOnce(clean).mockResolvedValueOnce(clean).mockResolvedValue(relabelled);

    const error = await refusalFrom(clean);

    // Retryable, not a park: the next attempt re-enters from the top, where `armHumanTicketWaits`
    // sees the fresh label on a board of its own and arms a proper wait for it.
    expect(error).not.toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain("t-2");
    expect(error.message).toContain(LABELS.agentHuman);
    expect(publishRunClaimMock).toHaveBeenCalled();
  });

  // Fresh evidence (PR #274 review, round 7): `preflightHumanTickets` arms a wait for a human
  // ticket WITHOUT clearing its `agent:human` label — only a person relabelling the ticket does
  // that — so a ticket this run already armed still carries the label on every later read. Before
  // this fix the label alone was read as drift, so this retried forever on every attempt instead
  // of ever dispatching t-1, the independent sibling nothing was waiting on.
  it("does not retry a child this run already armed a wait for — the label was already handled", async () => {
    const clean = board(ticket("t-1"), { ...ticket("t-2"), labels: [LABELS.agentHuman] } as Bead);
    attachCycleEvidence(clean, []);
    loadAllIssuesMock.mockResolvedValue(clean);
    preflightHumanTicketsMock.mockResolvedValue(preflight(clean));

    const theRun = run(clean);
    // Mirrors the real `runReadiness`: once the arm's own gate blocks t-2, the board it re-derives
    // readiness from reports t-2 as gated.
    theRun.readiness = () => ({ blockers: [], gated: ["t-2"], runnable: true });

    const prep = await prepareEpicRun(theRun);

    expect(prep.done).toBe(false);
    if (prep.done) return;
    expect([...prep.gated]).toContain("t-2");
    expect(publishRunClaimMock).toHaveBeenCalled();
  });

  // Fresh evidence (PR #274 review, round 8): `gated` is the WRONG set to exempt against — it also
  // holds a child an ORDINARY cross-run blocker gates, one the human preflight never touched because
  // it wasn't `agent:human` work yet. If the publish sync BOTH relabels that same child and clears
  // its ordinary blocker in the same window, exempting on `gated` alone would wave it through as
  // "already handled" even though no wait was ever armed for it — and the readiness recomputed right
  // after would then read it as unblocked and dispatchable. `armedHumanIds` (this fix) only exempts
  // ids the preflight itself armed a wait for or closed as answered, so this same ticket still trips
  // the check.
  it("retries when the publish sync relabels a child that was only EXTERNALLY gated, never armed", async () => {
    const clean = board(ticket("t-1"), ticket("t-2"));
    attachCycleEvidence(clean, []);
    const relabelled = board(ticket("t-1"), { ...ticket("t-2"), labels: [LABELS.agentHuman] } as Bead);
    attachCycleEvidence(relabelled, []);
    // No human work for the preflight to arm — t-2 isn't `agent:human` on the board it reads.
    preflightHumanTicketsMock.mockResolvedValue(preflight(clean));
    loadAllIssuesMock.mockResolvedValueOnce(clean).mockResolvedValueOnce(clean).mockResolvedValue(relabelled);

    const theRun = run(clean);
    // t-2 starts held by an ORDINARY blocker (not a human wait) — gone by the time the published
    // board is read, which is exactly the window this fix closes.
    theRun.readiness = (b: Bead[]) =>
      b === relabelled
        ? { blockers: [], gated: [], runnable: true }
        : { blockers: ["anton-elsewhere"], gated: ["t-2"], runnable: true };

    const error = await prepareEpicRun(theRun).then(
      () => undefined,
      (e: unknown) => e as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PoisonEpic);
    expect((error as Error).message).toContain("t-2");
    expect((error as Error).message).toContain(LABELS.agentHuman);
    expect(publishRunClaimMock).toHaveBeenCalled();
  });

  // chatgpt-codex-connector (PR #274 review): a gate THIS run armed can be answered by a person
  // during `publishRunClaim`'s own sync — a window that opens after `armHumanTicketWaits` already
  // ran. Closing the ticket on its answer only happens inside that preflight pass
  // (`answeredHumanGate`), so left unhandled the ticket would sit open, still `agent:human`, with a
  // resolved gate — reading as ordinary unblocked work to the readiness recomputed below, until the
  // dispatch backstop poison-parked the whole run on it instead of the preflight ever recognizing
  // the answer.
  it("retries when a human gate this run armed is resolved during the publish sync, before its ticket is closed", async () => {
    const humanT2 = {
      ...ticket("t-2"),
      labels: [LABELS.agentHuman],
      dependencies: [{ issue_id: "t-2", depends_on_id: "g-2", type: "blocks" }],
    } as Bead;
    const reason = humanGateReason("t-2", { ticketId: "t-2", ask: humanTicketAsk(humanT2) });
    const armedGate = {
      id: "g-2",
      title: "Gate: human",
      status: "open",
      issue_type: "gate",
      await_type: "human",
      description: `Ad-hoc gate blocking t-2\n\nReason: ${reason}`,
      labels: [HUMAN_GATE_ARMED_LABEL],
    } as Bead;
    // The pre-sync board the arm ran against, with its gate still OPEN — every read before the sync
    // (including the structural tier check) needs the referenced gate bead actually on the board.
    const clean = [...board(ticket("t-1"), humanT2), armedGate];
    attachCycleEvidence(clean, []);
    const answered = [feature(), ticket("t-1"), humanT2, { ...armedGate, status: "closed" }];
    attachCycleEvidence(answered, []);
    // Mirrors the real preflight: this run already armed a wait for t-2 (it's `handled`), but the
    // gate it armed was still OPEN at the time — the answer lands later, in the sync window. Built
    // by hand rather than the shared `preflight()` fixture, which naively treats every non-target id
    // as a ticket — wrong here, since `clean` carries the gate bead itself (needed for the tier
    // check above to accept its `blocks` edge).
    preflightHumanTicketsMock.mockResolvedValue({
      board: clean,
      target: clean.find((b) => b.id === TARGET)!,
      children: [ticket("t-1"), humanT2],
      tickets: [ticket("t-1"), humanT2],
      answeredButBlocked: new Map<string, string[]>(),
      armed: true,
      handled: new Set(["t-2"]),
    });
    loadAllIssuesMock.mockResolvedValueOnce(clean).mockResolvedValueOnce(clean).mockResolvedValue(answered);

    const error = await refusalFrom(clean);

    // Retryable, not a park: the next attempt re-enters from the top, where the preflight sees the
    // resolved gate and closes t-2 the normal way, before anything dispatches.
    expect(error).not.toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain("t-2");
    expect(publishRunClaimMock).toHaveBeenCalled();
  });

  // The inverse of the relabel two tests up (chatgpt-codex-connector, PR #274 review): a ticket THIS
  // run already armed a wait for may have its `agent:human` label REMOVED during the sync — an
  // operator decided an agent should run it after all. Before this fix, `relabelledHuman` only
  // watched tickets that still carry the label and `answeredSinceArmed` also required it, so this
  // ticket's open gate survived untouched: the readiness recomputed after would read it as blocked
  // forever, with no one left watching to answer a wait for a person no longer needed.
  it("retries when the publish sync un-labels a child this run already armed a wait for", async () => {
    const humanT2 = { ...ticket("t-2"), labels: [LABELS.agentHuman] } as Bead;
    const clean = board(ticket("t-1"), humanT2);
    attachCycleEvidence(clean, []);
    const unlabelled = board(ticket("t-1"), ticket("t-2"));
    attachCycleEvidence(unlabelled, []);
    // Mirrors the real preflight: this run already armed a wait for t-2 (it's `handled`), on the
    // board where it still carried the label.
    preflightHumanTicketsMock.mockResolvedValue({
      board: clean,
      target: clean.find((b) => b.id === TARGET)!,
      children: [ticket("t-1"), humanT2],
      tickets: [ticket("t-1"), humanT2],
      answeredButBlocked: new Map<string, string[]>(),
      armed: true,
      handled: new Set(["t-2"]),
    });
    loadAllIssuesMock
      .mockResolvedValueOnce(clean)
      .mockResolvedValueOnce(clean)
      .mockResolvedValue(unlabelled);

    const error = await refusalFrom(clean);

    // Retryable, not a park: the next attempt re-enters from the top, where the preflight's own
    // `retireRelabelledGates` resolves the now-obsolete gate the normal way.
    expect(error).not.toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain("t-2");
    expect(error.message).toContain(LABELS.agentHuman);
    expect(publishRunClaimMock).toHaveBeenCalled();
  });

  it("leaves a resume-skipped human-labelled child alone — its work is already done", async () => {
    // A ticket a prior attempt already delivered and closed is not a person waiting to be asked
    // again; `isResumeSkipped` is the same exclusion `armHumanTicketWaits` itself applies.
    const clean = board(ticket("t-1"), ticket("t-2"));
    attachCycleEvidence(clean, []);
    const relabelled = board(
      ticket("t-1"),
      { ...ticket("t-2", "closed"), labels: [LABELS.agentHuman] } as Bead,
    );
    attachCycleEvidence(relabelled, []);
    preflightHumanTicketsMock.mockResolvedValue(preflight(clean));
    loadAllIssuesMock.mockResolvedValueOnce(clean).mockResolvedValueOnce(clean).mockResolvedValue(relabelled);

    const prep = await prepareEpicRun(run(clean));

    expect(prep.done).toBe(false);
    expect(publishRunClaimMock).toHaveBeenCalled();
  });
});

describe("prepareEpicRun — a stale checkout refuses a new start (anton-mh3c)", () => {
  const clean = board(ticket("t-1"));

  beforeEach(() => {
    loadAllIssuesMock.mockResolvedValue(clean);
    preflightHumanTicketsMock.mockResolvedValue(preflight(clean));
  });

  it("defers a new start when anton's checkout is behind its upstream", async () => {
    checkSelfFreshnessMock.mockResolvedValue({
      checkout: { state: "behind", behind: 3, upstream: "origin/main" },
      dependencies: { state: "match" },
      build: { state: "current" },
    });

    const error = await refusalFrom(clean);

    // A reschedulable stop, NOT a poison: the runner defers the start (attempt refunded) so the
    // restarted-on-fresh-code process runs it, instead of stranding it in `parked` for a manual
    // resume the operator would have to find and click after already restarting anton (anton-5oc3).
    expect(error).toBeInstanceOf(StaleCheckoutError);
    expect(error).not.toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain("3 commit(s) behind origin/main");
    expect(error.message).toContain("git pull");
    // Read-only refusal: nothing was leased, warmed or claimed, so a run already in flight — and the
    // board itself — is untouched.
    expect(warmRunWorktreeMock).not.toHaveBeenCalled();
    expect(claimRunTargetMock).not.toHaveBeenCalled();
    expect(publishRunClaimMock).not.toHaveBeenCalled();
  });

  it("defers a new start when installed dependencies have drifted", async () => {
    checkSelfFreshnessMock.mockResolvedValue({
      checkout: { state: "current" },
      dependencies: { state: "drift", packages: ["drizzle-orm", "next"] },
      build: { state: "current" },
    });

    const error = await refusalFrom(clean);

    expect(error).toBeInstanceOf(StaleCheckoutError);
    expect(error).not.toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain("bun install");
    expect(error.message).toContain("drizzle-orm, next");
    expect(warmRunWorktreeMock).not.toHaveBeenCalled();
  });

  it("defers a new start when the running build lags the code on disk, filesystem clean", async () => {
    // The pull/reinstall the other halves ask for lands on disk instantly but never reaches the
    // modules a live process booted with — so the gate must still refuse until anton restarts.
    checkSelfFreshnessMock.mockResolvedValue({
      checkout: { state: "current" },
      dependencies: { state: "match" },
      build: { state: "drifted", drift: "outdated" },
    });

    const error = await refusalFrom(clean);

    expect(error).toBeInstanceOf(StaleCheckoutError);
    expect(error).not.toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain("moved past the build it is running");
    expect(error.message).toContain("restart anton");
    expect(warmRunWorktreeMock).not.toHaveBeenCalled();
  });

  it("dispatches normally when anton is running its own latest code", async () => {
    const prep = await prepareEpicRun(run(clean));

    expect(prep.done).toBe(false);
    expect(warmRunWorktreeMock).toHaveBeenCalled();
    expect(publishRunClaimMock).toHaveBeenCalled();
  });

  it("dispatches normally on an INDETERMINATE verdict — the check that could not run grounds nothing", async () => {
    // An offline runner: the remote was unreachable and the lockfile unreadable. Neither is evidence
    // of staleness, so the start proceeds exactly as a clean verdict would.
    checkSelfFreshnessMock.mockResolvedValue({
      checkout: { state: "unreachable", reason: "connection refused" },
      dependencies: { state: "unknown", reason: "bun.lock could not be read" },
      build: { state: "current" },
    });

    const prep = await prepareEpicRun(run(clean));

    expect(prep.done).toBe(false);
    expect(warmRunWorktreeMock).toHaveBeenCalled();
  });

  it("still settles a target already carried to its PR, stale checkout or not", async () => {
    // The completion short-circuit runs BEFORE this gate, so a finished target is not grounded by a
    // staleness it has no work left to run against.
    checkSelfFreshnessMock.mockResolvedValue({
      checkout: { state: "behind", behind: 1, upstream: "origin/main" },
      dependencies: { state: "match" },
    });
    settleCompletedRunMock.mockResolvedValue(true);

    const prep = await prepareEpicRun(run(clean));

    expect(prep.done).toBe(true);
    expect(checkSelfFreshnessMock).not.toHaveBeenCalled();
  });
});

describe("assertPreStartPoisonIsFresh — a stale process does not park permanently (PR #257)", () => {
  /** What every pre-start gate in `beginEpicRun` refuses with — a permanent park. */
  const poison = new PoisonEpic("target anton-x is not approved — refusing to execute");

  it("converts a pre-start poison into a deferral while anton is behind its own code", async () => {
    // The gate that raised the poison ran on code this process booted with. If the very fix being
    // pulled changed that rule, parking would outlive the restart that fixed it — nothing un-parks
    // a job but a person.
    checkSelfFreshnessMock.mockResolvedValue({
      checkout: { state: "behind", behind: 2, upstream: "origin/main" },
      dependencies: { state: "match" },
      build: { state: "current" },
    });

    const error = await assertPreStartPoisonIsFresh(poison).then(
      () => undefined,
      (e: unknown) => e as Error,
    );

    expect(error).toBeInstanceOf(StaleCheckoutError);
    expect(error).not.toBeInstanceOf(PoisonEpic);
  });

  it("lets the poison stand when anton is running its own latest code", async () => {
    await expect(assertPreStartPoisonIsFresh(poison)).resolves.toBeUndefined();
  });

  it("leaves a non-poison error alone without even reading the freshness verdict", async () => {
    // A retryable failure already re-runs on the restarted process, so it costs the gate nothing —
    // and reading freshness here would fetch anton's own remote on every ordinary retry.
    await expect(assertPreStartPoisonIsFresh(new Error("bd list failed"))).resolves.toBeUndefined();
    expect(checkSelfFreshnessMock).not.toHaveBeenCalled();
  });
});

describe("staleCheckoutRefusal — the message names the staleness and its fix (anton-mh3c)", () => {
  const ROOT = "/opt/anton";

  it("names the checkout distance and `git pull` when HEAD is behind", () => {
    const message = staleCheckoutRefusal(
      {
        checkout: { state: "behind", behind: 2, upstream: "origin/main" },
        dependencies: { state: "match" },
        build: { state: "current" },
      },
      ROOT,
    );

    expect(message).toContain("2 commit(s) behind origin/main");
    expect(message).toContain("git pull");
    expect(message).toContain(ROOT);
    // The disarm's contract, so the operator reads "only new starts stop", not "everything stopped".
    expect(message).toContain("Work already running is unaffected");
  });

  it("names the drifted packages and `bun install` when dependencies have drifted", () => {
    const message = staleCheckoutRefusal(
      {
        checkout: { state: "current" },
        dependencies: { state: "drift", packages: ["left-pad"] },
        build: { state: "current" },
      },
      ROOT,
    );

    expect(message).toContain("bun install");
    expect(message).toContain("left-pad");
  });

  it("names a running build the disk has moved past, even with the filesystem halves clean", () => {
    // The pull/reinstall that clears the checkout and dependency halves does not reach a live
    // process's boot-time modules, so the gate must still refuse a start until anton restarts.
    const message = staleCheckoutRefusal(
      {
        checkout: { state: "current" },
        dependencies: { state: "match" },
        build: { state: "drifted", drift: "outdated" },
      },
      ROOT,
    );

    expect(message).toContain("the code on disk has already moved past the build it is running");
    expect(message).toContain("restart anton");
  });

  it("names packages reinstalled under the running process, which no command in the message clears", () => {
    // `bun install` makes the lockfile comparison match and moves no build identity — node_modules is
    // in neither — so this is the only half that keeps the gate closed until the restart (PR #257).
    const message = staleCheckoutRefusal(
      {
        checkout: { state: "current" },
        dependencies: { state: "replaced" },
        build: { state: "current" },
      },
      ROOT,
    );

    expect(message).toContain("its packages were reinstalled under the ones it is running");
    expect(message).toContain("restart anton");
  });

  it("names BOTH when the checkout is behind AND dependencies drifted", () => {
    const message = staleCheckoutRefusal(
      {
        checkout: { state: "behind", behind: 1, upstream: "origin/main" },
        dependencies: { state: "drift", packages: ["next"] },
        build: { state: "current" },
      },
      ROOT,
    );

    expect(message).toContain("git pull");
    expect(message).toContain("bun install");
  });

  it("returns undefined for a clean verdict", () => {
    expect(
      staleCheckoutRefusal(
        {
          checkout: { state: "current" },
          dependencies: { state: "match" },
          build: { state: "current" },
        },
        ROOT,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for every INDETERMINATE verdict — a check that could not run is not staleness", () => {
    expect(
      staleCheckoutRefusal(
        {
          checkout: { state: "no-upstream" },
          dependencies: { state: "unknown", reason: "x" },
          build: { state: "current" },
        },
        ROOT,
      ),
    ).toBeUndefined();
    expect(
      staleCheckoutRefusal(
        {
          checkout: { state: "unreachable", reason: "x" },
          dependencies: { state: "match" },
          build: { state: "current" },
        },
        ROOT,
      ),
    ).toBeUndefined();
    // A build identity that could not be established is the same: the runner's drift read enumerates
    // the machine's sockets, and a start must not be refused on a check that threw.
    expect(
      staleCheckoutRefusal(
        {
          checkout: { state: "current" },
          dependencies: { state: "match" },
          build: { state: "unknown", reason: "lsof: command not found" },
        },
        ROOT,
      ),
    ).toBeUndefined();
  });
});
