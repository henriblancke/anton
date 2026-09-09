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
