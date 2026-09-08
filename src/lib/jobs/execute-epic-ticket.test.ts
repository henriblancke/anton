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
    finishTicketMock.mockResolvedValue({ closed: true });
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

  it("closes as satisfied when the read answers inside the budget", async () => {
    branchAddedCommitMock.mockResolvedValue(true);

    await expect(
      runTicket({ run: run(), steps: [satisfiedCommitStep()], ticket, runTicketIds: [ticket.id], timeoutMs: 5_000 }),
    ).resolves.toEqual({
      how: "satisfied",
      by: { commit: EARLIER, subject: "anton-t1: Add the schema", note: "step 1 covered it" },
      closed: true,
    });
    expect(settleFailedTicketMock).not.toHaveBeenCalled();
    expect(finishTicketMock).toHaveBeenCalledWith(
      expect.anything(),
      ticket,
      "s1",
      true,
      expect.objectContaining({ how: "satisfied" }),
    );
  });
});
