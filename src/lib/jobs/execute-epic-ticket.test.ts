/**
 * PR #253 review — {@link runTicket} honours the ticket deadline through the delivery gate's branch
 * read. The gate's `branchAddedCommit` and the settlement's `describeCommit` are plain git reads
 * that take no signal: a deadline landing during one aborts nothing, the walk returns as if in time,
 * and — without the recheck this proves — the success path would close a ticket that ran out of its
 * budget instead of settling it as the timeout it is.
 *
 * Mocked at the bookend and settlement seams so the walk runs against a fake `commit` step and a
 * branch read whose latency the test controls; the budget clock is the real one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "../beads/bd";
import type { StepFacts } from "./step-registry";

const branchAddedCommitMock = vi.fn();
const describeCommitMock = vi.fn();
const finishTicketMock = vi.fn();
const settleFailedTicketMock = vi.fn();
const readBoardBaselineMock = vi.fn();
const readBoardEvidenceMock = vi.fn();
const clearBoardEvidencePendingMock = vi.fn();
const ensureBoardBaselinePersistedMock = vi.fn();
const mustReadMock = vi.fn();

vi.mock("../git/ops", async () => {
  const actual = await vi.importActual<typeof import("../git/ops")>("../git/ops");
  return {
    ...actual,
    branchAddedCommit: (...args: unknown[]) => branchAddedCommitMock(...args),
    describeCommit: (...args: unknown[]) => describeCommitMock(...args),
  };
});

vi.mock("./execute-epic-ticket-bookends", async () => {
  const actual = await vi.importActual<typeof import("./execute-epic-ticket-bookends")>(
    "./execute-epic-ticket-bookends",
  );
  return {
    ...actual,
    claimTicket: async () => undefined,
    openTicketSession: async () => ({ sessionId: "s1", logPath: "/dev/null" }),
    readTicketBaseline: async () => null,
    finishTicket: (...args: unknown[]) => finishTicketMock(...args),
  };
});

vi.mock("./execute-epic-board-evidence", async () => {
  const actual = await vi.importActual<typeof import("./execute-epic-board-evidence")>(
    "./execute-epic-board-evidence",
  );
  return {
    ...actual,
    // `isBoardOnlyRun` is left as the real implementation — it just reads the `delivery:board`
    // label, and forcing it here would silently flip every OTHER test in this file onto the
    // board-only path too. Only the board reads/writes below it are faked.
    readBoardBaseline: (...args: unknown[]) => readBoardBaselineMock(...args),
    readBoardEvidence: (...args: unknown[]) => readBoardEvidenceMock(...args),
    clearBoardEvidencePending: (...args: unknown[]) => clearBoardEvidencePendingMock(...args),
    ensureBoardBaselinePersisted: (...args: unknown[]) => ensureBoardBaselinePersistedMock(...args),
  };
});

vi.mock("./execute-epic-persist", async () => {
  const actual = await vi.importActual<typeof import("./execute-epic-persist")>("./execute-epic-persist");
  return {
    ...actual,
    // `runTicket` re-reads the ticket via `mustRead` right before releasing the pending marker
    // (PR #284 review, "Refresh the ticket before clearing newly written evidence") — mocked here
    // like every other bd seam in this file so the cleanup tests below exercise that call, not a
    // live `bd show` against a fake "/tmp/anton".
    mustRead: (...args: unknown[]) => mustReadMock(...args),
  };
});

vi.mock("./execute-epic-ticket-settle", async () => {
  const actual = await vi.importActual<typeof import("./execute-epic-ticket-settle")>(
    "./execute-epic-ticket-settle",
  );
  return {
    ...actual,
    settleFailedTicket: (...args: unknown[]) => settleFailedTicketMock(...args),
  };
});

vi.mock("./execute-epic-ticket-claude", () => ({
  resilientClaude: () => async () => {
    throw new Error("no step in this walk dispatches claude");
  },
}));

const { runTicket } = await import("./execute-epic-ticket");
import type { ResolvedStep } from "./run-formula";
import type { StepContext } from "./step-registry";

const EARLIER = "0123456789abcdef0123456789abcdef01234567";
const ticket = { id: "anton-t2", title: "Expose the schema", status: "in_progress" } as Bead;

/** The run `runTicket` reads: a signal for the budget to derive from, and the branch the gate asks about. */
function run(): Omit<StepContext, "tickets"> {
  return {
    ctx: { signal: new AbortController().signal, heartbeat: async () => undefined },
    repoPath: "/tmp/anton",
    worktreePath: "/tmp/anton-wt",
    branch: "anton/anton-f1",
    baseRef: "main",
    db: {},
    clock: { now: () => 0 },
    // Read by isBoardOnlyRun's target-side check (anton-fc5x review round 1) — an ordinary,
    // non-board-only run target, since none of this suite's cases concern board-only delivery.
    target: ticket,
  } as unknown as Omit<StepContext, "tickets">;
}

/** A `commit` step reporting a zero diff the agent explained as `satisfied — <earlier commit>`. */
function satisfiedCommitStep(): ResolvedStep {
  const facts: StepFacts = {
    committed: false,
    selfReport: { outcome: "satisfied", commit: EARLIER.slice(0, 8), reason: "step 1 covered it" },
  };
  return {
    step: { id: "commit" },
    definition: {
      name: "commit",
      class: "git",
      summary: "fake commit",
      producesDiff: false,
      handler: async () => ({ ok: true, facts }),
    },
  } as unknown as ResolvedStep;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("runTicket — the deadline is honoured through the gate's branch read (PR #253 review)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    describeCommitMock.mockResolvedValue({ sha: EARLIER, subject: "anton-t1: Add the schema" });
    finishTicketMock.mockResolvedValue({ closed: true, transitioned: true });
    settleFailedTicketMock.mockImplementation(async () => {
      throw new Error("settled as a failure");
    });
  });

  it("settles as a TIMEOUT, not a close, when the deadline fires during the read", async () => {
    // The read observes no signal, so it answers "yes, that commit is the run's" well after the clock
    // ran out — exactly as a slow `git merge-base` would.
    branchAddedCommitMock.mockImplementation(async () => {
      await wait(120);
      return true;
    });

    await expect(
      runTicket({ run: run(), steps: [satisfiedCommitStep()], ticket, runTicketIds: [ticket.id], timeoutMs: 30 }),
    ).rejects.toThrow("settled as a failure");

    expect(finishTicketMock).not.toHaveBeenCalled();
    expect(settleFailedTicketMock).toHaveBeenCalledTimes(1);
    const settled = settleFailedTicketMock.mock.calls[0]![0] as {
      ranOutOfTime: boolean;
      progress: { committed: boolean; delivered: boolean };
      e: unknown;
    };
    // The timeout path is what settles it — and it reads the gate's verdict, so the satisfied step
    // is attributed to its commit there rather than reported as work the deadline rolled back.
    expect(settled.ranOutOfTime).toBe(true);
    expect(settled.progress).toMatchObject({ committed: false, delivered: true });
    expect((settled.e as Error).message).toMatch(/ran out of its ticket budget/);
  });

  it("settles as an abort, not a close, when a recovered commit's job is cancelled", async () => {
    branchAddedCommitMock.mockResolvedValue(true);
    const ticketRun = run();
    const job = new AbortController();
    ticketRun.ctx.signal = job.signal;
    const recoveredCommit: ResolvedStep = {
      step: { id: "commit" },
      definition: {
        name: "commit",
        class: "git",
        summary: "a commit recovered after its post-commit hook stopped",
        producesDiff: true,
        handler: async () => {
          job.abort(new Error("operator cancelled the job"));
          return { ok: true, facts: { committed: true } };
        },
      },
    } as unknown as ResolvedStep;

    await expect(
      runTicket({ run: ticketRun, steps: [recoveredCommit], ticket, runTicketIds: [ticket.id], timeoutMs: 5_000 }),
    ).rejects.toThrow("settled as a failure");

    expect(finishTicketMock).not.toHaveBeenCalled();
    expect(settleFailedTicketMock).toHaveBeenCalledTimes(1);
    const settled = settleFailedTicketMock.mock.calls[0]![0] as {
      ranOutOfTime: boolean;
      progress: { committed: boolean; delivered: boolean };
      e: unknown;
    };
    expect(settled.ranOutOfTime).toBe(false);
    expect(settled.progress).toMatchObject({ committed: true, delivered: true });
    expect((settled.e as Error).message).toContain("run was aborted");
  });

  it("closes as satisfied when the read answers inside the budget", async () => {
    branchAddedCommitMock.mockResolvedValue(true);

    const ticketRun = run();
    await expect(
      runTicket({ run: ticketRun, steps: [satisfiedCommitStep()], ticket, runTicketIds: [ticket.id], timeoutMs: 5_000 }),
    ).resolves.toEqual({
      how: "satisfied",
      by: { commit: EARLIER, subject: "anton-t1: Add the schema", note: "step 1 covered it" },
      closed: true,
    });
    expect(settleFailedTicketMock).not.toHaveBeenCalled();
    const ticketContext = finishTicketMock.mock.calls[0]?.[0] as StepContext;
    expect(ticketContext.ctx.signal).not.toBe(ticketRun.ctx.signal);
    expect(finishTicketMock).toHaveBeenCalledWith(
      expect.objectContaining({ ctx: expect.objectContaining({ signal: ticketContext.ctx.signal }) }),
      ticket,
      "s1",
      true,
      expect.objectContaining({ how: "satisfied" }),
    );
  });
});

/**
 * PR #284 review round 7: `finishTicket` answers `transitioned` (not just `closed`) precisely so the
 * pending board-evidence marker is released only once the write that ends the ticket's handoff
 * actually landed — clearing it on an unconditional `finishTicket` return would strand a confirmed
 * board-only delivery's only recovery record on a bd write that never happened.
 */
describe("runTicket — releases the board-evidence marker only once the handoff lands (PR #284 review round 7)", () => {
  const boardTicket = { ...ticket, labels: ["delivery:board"] } as Bead;

  function deliveredCommitStep(): ResolvedStep {
    const facts: StepFacts = { committed: true, selfReport: { outcome: "delivered" } };
    return {
      step: { id: "commit" },
      definition: {
        name: "commit",
        class: "git",
        summary: "fake board-only commit",
        producesDiff: false,
        handler: async () => ({ ok: true, facts }),
      },
    } as unknown as ResolvedStep;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    readBoardBaselineMock.mockResolvedValue({ beads: new Map() });
    readBoardEvidenceMock.mockResolvedValue({ found: true, ids: ["anton-x1"], synced: true });
    ensureBoardBaselinePersistedMock.mockResolvedValue({ beads: new Map() });
    settleFailedTicketMock.mockImplementation(async () => {
      throw new Error("settled as a failure");
    });
  });

  it("clears the pending marker once finishTicket confirms the transition landed, using a " +
    "freshly re-read ticket rather than the stale pre-dispatch snapshot (chatgpt-codex-connector, " +
    "PR #284 review, 'Refresh the ticket before clearing newly written evidence')", async () => {
    finishTicketMock.mockResolvedValue({ closed: false, transitioned: true });
    // The label `readBoardEvidence` would have added to the LIVE board bead after `boardTicket` was
    // captured — absent from `boardTicket` itself, which is exactly what a stale-snapshot cleanup
    // call would still be passing.
    const freshTicket = {
      ...boardTicket,
      labels: ["delivery:board", "board-evidence-pending:anton-x1"],
    } as Bead;
    mustReadMock.mockResolvedValue(freshTicket);

    await runTicket({
      run: run(),
      steps: [deliveredCommitStep()],
      ticket: boardTicket,
      runTicketIds: [boardTicket.id],
      timeoutMs: 5_000,
    });

    expect(mustReadMock).toHaveBeenCalledWith("/tmp/anton", boardTicket.id);
    expect(clearBoardEvidencePendingMock).toHaveBeenCalledWith("/tmp/anton", freshTicket, ["anton-x1"]);
  });

  it("fails loud instead of falling back to the stale pre-dispatch ticket when the re-read fails " +
    "(chatgpt-codex-connector, PR #284 review, 'Fail closed when the cleanup re-read is " +
    "unavailable') — on a first-attempt success the stale ticket predates the pending label " +
    "entirely, so cleaning up from it would strand the live label on the board undetected", async () => {
    finishTicketMock.mockResolvedValue({ closed: false, transitioned: true });
    mustReadMock.mockResolvedValue(undefined);

    await expect(
      runTicket({
        run: run(),
        steps: [deliveredCommitStep()],
        ticket: boardTicket,
        runTicketIds: [boardTicket.id],
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/could not be re-read/);

    expect(clearBoardEvidencePendingMock).not.toHaveBeenCalled();
  });

  it("fails loud instead of returning success when bd refused the requested transition — a " +
    "child ticket's already-landed board edits must stay recoverable, not settle as delivered " +
    "with a stale marker on a bead that never closed", async () => {
    finishTicketMock.mockResolvedValue({ closed: false, transitioned: false });

    await expect(
      runTicket({
        run: run(),
        steps: [deliveredCommitStep()],
        ticket: boardTicket,
        runTicketIds: [boardTicket.id],
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/board evidence was confirmed/);

    expect(clearBoardEvidencePendingMock).not.toHaveBeenCalled();
  });
});

/**
 * PR #284 review, "Audit live-board mutations when ticket execution fails": a board-only ticket's
 * deliverable is bd writes the agent makes directly against the live board, so a write it made
 * before a LATER step failed (a verify gate here) is already live on the board by the time
 * `walkTicketSteps` throws — well before the commit step's own `assertBoardOnlyDelivered` ever gets
 * a chance to compare against the baseline. Without this audit, `settleFailedTicket` would settle the
 * ticket with no record of that write at all, and a resumed attempt's fresh `readBoardBaseline` read
 * would silently absorb it as pre-existing.
 */
describe("runTicket — audits the board on a failed post-dispatch path (PR #284 review)", () => {
  const boardTicket = { ...ticket, labels: ["delivery:board"] } as Bead;

  function failingVerifyStep(): ResolvedStep {
    return {
      step: { id: "verify" },
      definition: {
        name: "verify",
        class: "verify",
        summary: "fake verify gate",
        producesDiff: false,
        handler: async () => ({ ok: false, detail: "tests failed" }),
      },
    } as unknown as ResolvedStep;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    readBoardBaselineMock.mockResolvedValue({ beads: new Map() });
    ensureBoardBaselinePersistedMock.mockResolvedValue({ beads: new Map() });
    settleFailedTicketMock.mockImplementation(async () => {
      throw new Error("settled as a failure");
    });
  });

  it("audits the board against the pre-dispatch baseline before settling the ticket", async () => {
    readBoardEvidenceMock.mockResolvedValue({ found: true, ids: ["anton-x9"], synced: true });

    await expect(
      runTicket({
        run: run(),
        steps: [failingVerifyStep()],
        ticket: boardTicket,
        runTicketIds: [boardTicket.id],
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("settled as a failure");

    expect(readBoardEvidenceMock).toHaveBeenCalledWith("/tmp/anton", { beads: new Map() }, boardTicket);
    expect(settleFailedTicketMock).toHaveBeenCalledTimes(1);
  });

  it("does not audit (or alter settlement) when nothing on the board changed", async () => {
    readBoardEvidenceMock.mockResolvedValue({ found: false, ids: [], synced: false });

    await expect(
      runTicket({
        run: run(),
        steps: [failingVerifyStep()],
        ticket: boardTicket,
        runTicketIds: [boardTicket.id],
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("settled as a failure");

    expect(settleFailedTicketMock).toHaveBeenCalledTimes(1);
  });

  it(
    "halts instead of settling when the audit's own pending-evidence marker could not be persisted " +
      "— losing that record would let a resumed attempt's fresh baseline silently absorb the write " +
      "with no way left to attribute or reject it",
    async () => {
      readBoardEvidenceMock.mockResolvedValue({
        found: true,
        ids: ["anton-x9"],
        synced: false,
        markerUnpersisted: true,
      });

      await expect(
        runTicket({
          run: run(),
          steps: [failingVerifyStep()],
          ticket: boardTicket,
          runTicketIds: [boardTicket.id],
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(/could not be recorded for a resume/);

      expect(settleFailedTicketMock).not.toHaveBeenCalled();
    },
  );

  it(
    "halts instead of settling when a total read failure ALSO could not persist a recovery " +
      "baseline — `found: false` here means nothing to attribute, not that the recovery write " +
      "itself succeeded (chatgpt-codex-connector, PR #284 review)",
    async () => {
      readBoardEvidenceMock.mockResolvedValue({
        found: false,
        ids: [],
        synced: false,
        evidenceUnavailable: true,
        baselineUnpersisted: true,
      });

      await expect(
        runTicket({
          run: run(),
          steps: [failingVerifyStep()],
          ticket: boardTicket,
          runTicketIds: [boardTicket.id],
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(/could not be recorded for a resume/);

      expect(settleFailedTicketMock).not.toHaveBeenCalled();
    },
  );
});

/**
 * PR #284 review, "Persist the board baseline before dispatch": a baseline that read fine but could
 * not be durably anchored to the ticket must refuse dispatch just like an unreadable one — otherwise
 * a crash between the agent's writes and the first pending-marker write would leave a resumed attempt
 * with nothing to anchor against.
 */
describe(
  "runTicket — refuses to dispatch a board-only ticket whose baseline could not be persisted (PR #284 review)",
  () => {
    const boardTicket = { ...ticket, labels: ["delivery:board"] } as Bead;
    const dispatchMock = vi.fn();

    function neverDispatchedStep(): ResolvedStep {
      return {
        step: { id: "implement" },
        definition: {
          name: "claude",
          class: "dispatch",
          summary: "should never run — dispatch is refused before any step walks",
          producesDiff: true,
          handler: async () => {
            dispatchMock();
            return { ok: true, facts: {} };
          },
        },
      } as unknown as ResolvedStep;
    }

    /** A `commit` step reporting a board-only delivery, mirroring the marker-release describe above. */
    function deliveredCommitStep(): ResolvedStep {
      return {
        step: { id: "commit" },
        definition: {
          name: "commit",
          class: "git",
          summary: "fake board-only commit",
          producesDiff: false,
          handler: async () => {
            dispatchMock();
            return { ok: true, facts: { committed: true, selfReport: { outcome: "delivered" } } };
          },
        },
      } as unknown as ResolvedStep;
    }

    beforeEach(() => {
      vi.resetAllMocks();
      dispatchMock.mockReset();
      readBoardBaselineMock.mockResolvedValue({ beads: new Map() });
      // The catch-side audit (`auditBoardOnFailedTicket`) still reads the board on ANY failure once
      // `boardBaseline` came back non-null, including this pre-dispatch refusal — a benign "nothing
      // changed" read is the right default here since nothing has run yet.
      readBoardEvidenceMock.mockResolvedValue({ found: false, ids: [], synced: false });
      settleFailedTicketMock.mockImplementation(async () => {
        throw new Error("settled as a failure");
      });
    });

    it("fails closed before the agent ever dispatches, without claiming the baseline read failed", async () => {
      ensureBoardBaselinePersistedMock.mockResolvedValue(null);

      await expect(
        runTicket({
          run: run(),
          steps: [neverDispatchedStep()],
          ticket: boardTicket,
          runTicketIds: [boardTicket.id],
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow("settled as a failure");

      // The step handler never runs — dispatch is refused before `walkTicketSteps` is ever called.
      expect(dispatchMock).not.toHaveBeenCalled();
      expect(settleFailedTicketMock).toHaveBeenCalledTimes(1);
      const settled = settleFailedTicketMock.mock.calls[0]![0] as { e: Error };
      expect(settled.e.message).toMatch(/was not dispatched/);
      expect(settled.e.message).toMatch(/could not be durably persisted/);
      expect(settled.e.message).not.toMatch(/could not be read/);
    });

    it("dispatches normally once the baseline is durably persisted", async () => {
      ensureBoardBaselinePersistedMock.mockResolvedValue({ beads: new Map() });
      readBoardEvidenceMock.mockResolvedValue({ found: true, ids: ["anton-x2"], synced: true });
      finishTicketMock.mockResolvedValue({ closed: false, transitioned: true });
      // The post-dispatch cleanup re-reads the ticket before clearing its pending marker (see the
      // "clears the pending marker..." test above) — stubbed here since this test cares about
      // dispatch happening, not that cleanup path's own behavior.
      mustReadMock.mockResolvedValue(boardTicket);

      await runTicket({
        run: run(),
        steps: [deliveredCommitStep()],
        ticket: boardTicket,
        runTicketIds: [boardTicket.id],
        timeoutMs: 5_000,
      });

      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(readBoardEvidenceMock).toHaveBeenCalledWith("/tmp/anton", { beads: new Map() }, boardTicket);
    });
  },
);
