/**
 * The delivery-evidence gate (anton-3on8) — what a zero-diff ticket still costs after the
 * `already-shipped` narrowing (anton-5bpd).
 *
 * That feature gave ONE block class a way out of the park: an agent that reports
 * `blocked — already-shipped` and names work anton can check has its ticket retired and the run
 * carries on. Every part of that is downstream of a check, and what is pinned here are the two
 * readings where the check does not hold — the ones the gate has always refused and must keep
 * refusing, or the feature reads as "say the words and the ticket settles":
 *
 *   • an UNCLASSIFIED zero diff blocks the bead and halts the run, exactly as it did before any
 *     repair existed;
 *   • a `blocked — already-shipped` claim anton could NOT verify does the same, and names the check
 *     that failed on the bead a human reads.
 *
 * Mocked at the IO seams only — bd, sessions, git, the board read. The gate, the ticket's bookends,
 * the settlement and the repair all RUN, because "the claim did not weaken the gate" is a statement
 * about how those four compose and nothing smaller can make it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "../beads/bd";
import type { AntonResult } from "../claude/anton-result";
import type { CommitNaming, CommitReach } from "../git/ops";
import type { ResolvedStep } from "./run-formula";
import type { AntonDb, Clock } from "./queue";
import type { StepContext } from "./step-registry";

const REPO = "/tmp/anton-repo";
const WORKTREE = "/tmp/anton-worktree";
const BRANCH = "anton/anton-tick";
const NOW = 1_700_000_000_000;
const TICKET_ID = "anton-tick";
/** The bead the unverifiable claim names: on the board, still open, pointing at no PR. */
const NOT_SHIPPED_ID = "anton-open";
/** The bead a VERIFIABLE claim names: closed, and named by a commit the run's base contains. */
const SHIPPED_ID = "anton-done";

const claimMock = vi.fn(async () => {});
const tagMock = vi.fn(async () => {});
const untagMock = vi.fn(async () => {});
const setStatusMock = vi.fn(async () => {});
const unassignMock = vi.fn(async () => {});
const noteMock = vi.fn(async () => {});
const closeMock = vi.fn(async () => {});
const supersedeMock = vi.fn(async () => {});
const syncMock = vi.fn(async () => {});
const showMock = vi.fn(async (_repo: string, id: string) => beadById(id));
const loadAllIssuesMock = vi.fn(async () => board());
const startJobSessionMock = vi.fn(async () => ({ sessionId: "sess-1", logPath: "/tmp/sess-1.log" }));
const endSessionMock = vi.fn(async () => {});
const appendSessionLogMock = vi.fn(async () => {});
const updateRunMock = vi.fn(async () => {});
const readWorktreeStateMock = vi.fn(async () => ({ head: "a".repeat(40), status: "" }));
/** What the base's history says of a bead — `none` unless a case seeds a landing. */
const readCommitNamingMock = vi.fn(async (): Promise<CommitNaming> => ({ state: "none" }));
/** The under-lock recheck of a naming commit — it still reaches the base unless a case says otherwise. */
const readCommitReachMock = vi.fn(
  async (_repo: string, sha: string): Promise<CommitReach> => ({ state: "reaches", sha }),
);

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      claim: (...args: unknown[]) => claimMock(...(args as [])),
      tag: (...args: unknown[]) => tagMock(...(args as [])),
      untag: (...args: unknown[]) => untagMock(...(args as [])),
      setStatus: (...args: unknown[]) => setStatusMock(...(args as [])),
      unassign: (...args: unknown[]) => unassignMock(...(args as [])),
      note: (...args: unknown[]) => noteMock(...(args as [])),
      close: (...args: unknown[]) => closeMock(...(args as [])),
      supersede: (...args: unknown[]) => supersedeMock(...(args as [])),
      sync: (...args: unknown[]) => syncMock(...(args as [])),
      show: (repo: string, id: string) => showMock(repo, id),
    },
  };
});

vi.mock("../beads/issues", async () => {
  const actual = await vi.importActual<typeof import("../beads/issues")>("../beads/issues");
  return { ...actual, loadAllIssues: () => loadAllIssuesMock() };
});

vi.mock("../sessions", async () => {
  const actual = await vi.importActual<typeof import("../sessions")>("../sessions");
  return {
    ...actual,
    startJobSession: () => startJobSessionMock(),
    endSession: (...args: unknown[]) => endSessionMock(...(args as [])),
    appendSessionLog: (...args: unknown[]) => appendSessionLogMock(...(args as [])),
    setSessionClaudeId: async () => {},
  };
});

vi.mock("../runs", async () => {
  const actual = await vi.importActual<typeof import("../runs")>("../runs");
  return { ...actual, updateRun: (...args: unknown[]) => updateRunMock(...(args as [])) };
});

// The gate's failure paths read the tree; nothing in these cases may shell out to git.
vi.mock("../git/ops", async () => {
  const actual = await vi.importActual<typeof import("../git/ops")>("../git/ops");
  return {
    ...actual,
    readWorktreeState: () => readWorktreeStateMock(),
    restoreWorktreeState: async () => {},
    readCommitNaming: () => readCommitNamingMock(),
    readCommitReach: (repo: string, sha: string) => readCommitReachMock(repo, sha),
  };
});

const { runTicket } = await import("./execute-epic-ticket");
const { isPoisonError } = await import("./errors");

/** The ticket under test: claimed, and citing no paths, so `ref-stale` has nothing to say about it. */
function ticket(): Bead {
  return {
    id: TICKET_ID,
    title: "A ticket the agent delivered nothing for",
    status: "in_progress",
    description: "## Goal\nShip it.",
    labels: ["stage:implementing"],
  } as Bead;
}

/** The board the repair checks a claim against — the ticket, and one bead that has NOT landed. */
function board(): Bead[] {
  return [
    ticket(),
    { id: NOT_SHIPPED_ID, title: "Work that has not landed", status: "open", labels: [] } as Bead,
    { id: SHIPPED_ID, title: "Work that landed", status: "closed", labels: [] } as Bead,
  ];
}

function beadById(id: string): Bead {
  const found = board().find((b) => b.id === id);
  if (!found) throw new Error(`no such bead: ${id}`);
  return found;
}

/** One dispatching step carrying the agent's self-report, then the commit that reports the diff. */
function steps(selfReport: AntonResult | null, committed: boolean): ResolvedStep[] {
  const define = (name: string, handler: () => Promise<unknown>): ResolvedStep =>
    ({
      step: { id: name },
      definition: { name, class: "required", summary: name, producesDiff: false, handler },
    }) as unknown as ResolvedStep;
  return [
    define("implement", async () => ({ ok: true, facts: { selfReport } })),
    define("commit", async () => ({ ok: true, facts: { committed } })),
  ];
}

/**
 * The run context one ticket walks in. `already-shipped` is armed at `apply` — the strongest setting
 * a project can give it, so a claim that still does not settle the ticket is refused by the CHECK
 * and not merely by an unarmed dial.
 */
function run(
  signal: AbortSignal = new AbortController().signal,
  autonomy: "apply" | "shadow" = "apply",
): Omit<StepContext, "tickets"> {
  const clock: Clock = { now: () => NOW };
  return {
    db: {} as AntonDb,
    clock,
    ctx: { signal, heartbeat: vi.fn(), report: vi.fn() },
    projectId: "proj-1",
    runId: "run-1",
    repoPath: REPO,
    worktreePath: WORKTREE,
    branch: BRANCH,
    baseBranch: "main",
    baseRef: "origin/main",
    target: { id: "anton-epic", title: "The epic", status: "in_progress" } as Bead,
    settings: { repairAutonomy: { "already-shipped": autonomy } },
  } as unknown as Omit<StepContext, "tickets">;
}

/** Walk the ticket and hand back the error it halted on (failing if it did not halt). */
async function haltOf(
  selfReport: AntonResult | null,
  signal?: AbortSignal,
  autonomy?: "apply" | "shadow",
): Promise<Error> {
  const caught = await runTicket({
    run: run(signal, autonomy),
    steps: steps(selfReport, false),
    ticket: ticket(),
    // The run carries this ticket alone — no sibling for a `dep-missing` repair to resolve against.
    runTicketIds: [TICKET_ID],
    timeoutMs: Infinity,
  }).then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  if (!caught) throw new Error("the ticket did not halt — the delivery-evidence gate let it through");
  return caught;
}

/** Every note anton wrote on the ticket, in the order it wrote them. */
const notesWritten = (): string[] => noteMock.mock.calls.map((c) => (c as unknown as string[])[2]);

/** Every label anton stamped on the ticket. */
const labelsWritten = (): string[] =>
  tagMock.mock.calls.flatMap((c) => (c as unknown as [string, string, string[]])[2] ?? []);

describe("the delivery-evidence gate — zero diff still blocks and halts (anton-3on8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    showMock.mockImplementation(async (_repo: string, id: string) => beadById(id));
    loadAllIssuesMock.mockImplementation(async () => board());
    startJobSessionMock.mockImplementation(async () => ({
      sessionId: "sess-1",
      logPath: "/tmp/sess-1.log",
    }));
    readWorktreeStateMock.mockImplementation(async () => ({ head: "a".repeat(40), status: "" }));
  });

  it("halts and blocks an UNCLASSIFIED zero diff, closing nothing (issue #46 root cause #1)", async () => {
    const halt = await haltOf(null);

    // Poison, so the runner parks the run for a human instead of re-running the agent to the same
    // empty result — the halt half of the gate.
    expect(halt.message).toMatch(/produced no delivery/);
    expect(halt.message).toMatch(/zero diff/);
    expect(isPoisonError(halt)).toBe(true);

    // Blocked, never closed and never re-queued open: closing it would be the false success.
    expect(closeMock).not.toHaveBeenCalled();
    expect(setStatusMock).toHaveBeenCalledWith(REPO, TICKET_ID, "blocked");
    expect(setStatusMock).not.toHaveBeenCalledWith(REPO, TICKET_ID, "open");
    expect(unassignMock).toHaveBeenCalledWith(REPO, TICKET_ID);

    // The operator's account, and nothing else: an unclassified block earns no repair, so no repair
    // note and no stamp that would suppress a later one.
    const notes = notesWritten();
    expect(notes.some((n) => n.includes("zero diff"))).toBe(true);
    expect(notes.some((n) => n.includes("did not repair this"))).toBe(false);
    expect(labelsWritten().some((l) => l.startsWith("repair:"))).toBe(false);
  });

  it("halts and blocks a CLAIMED-but-unverified `already-shipped` block, naming the failed check", async () => {
    const halt = await haltOf({
      outcome: "blocked",
      klass: "already-shipped",
      reason: `Already implemented by ${NOT_SHIPPED_ID}`,
    });

    // The class buys the claim nothing on its own: the same zero-diff poison, the same block.
    expect(halt.message).toMatch(/produced no delivery/);
    expect(isPoisonError(halt)).toBe(true);
    expect(closeMock).not.toHaveBeenCalled();
    expect(setStatusMock).toHaveBeenCalledWith(REPO, TICKET_ID, "blocked");

    // Nothing was retired and nothing stamped, so arming the class has not spent this bead's one
    // repair on a claim that failed its check.
    expect(labelsWritten().some((l) => l.startsWith("repair:"))).toBe(false);

    // And the bead SAYS which check failed — the whole difference between a refusal a human can act
    // on and a ticket that merely stayed blocked.
    const refusal = notesWritten().find((n) => n.includes("did not repair this as `already-shipped`"));
    expect(refusal).toBeDefined();
    expect(refusal).toContain("the failed check:");
    expect(refusal).toContain(NOT_SHIPPED_ID);
    expect(refusal).toContain("nothing there says its work landed");
    // One line, or the notes blob parses the rest back as separate anton notes with no context.
    expect(refusal!.split("\n")).toHaveLength(1);

    // The agent's own words ride onto the block note too, so the two records agree.
    const block = notesWritten().find((n) => n.includes("zero diff"));
    expect(block).toContain("already-shipped");
  });

  // The settlement reads the job's abort ONCE before the repair, and the repair then reads git, asks
  // GitHub and waits on locks (PR #238 review). A kill landing in that window must leave the board
  // exactly as an abort landing before it would: nothing retired, nothing noted, nothing released.
  it("retires and writes NOTHING when the job is cancelled while a verified claim is being settled", async () => {
    const controller = new AbortController();
    readCommitNamingMock.mockResolvedValue({ state: "found", sha: "b".repeat(40) });
    showMock.mockImplementation(async (_repo: string, id: string) => {
      // The under-lock re-read of the survivor — every check has passed, the first write is next.
      if (id === SHIPPED_ID) controller.abort();
      return beadById(id);
    });

    const halt = await haltOf(
      { outcome: "blocked", klass: "already-shipped", reason: `Already implemented by ${SHIPPED_ID}` },
      controller.signal,
    );

    // The block still propagates — the run stops on the cancellation, not on a park.
    expect(halt.message).toMatch(/produced no delivery/);
    // And the board is untouched: no supersede, no evidence or refusal note, no stamp, no status,
    // and the claim left in place for the resume that follows the kill.
    expect(supersedeMock).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
    expect(noteMock).not.toHaveBeenCalled();
    // The only label written is the claim's own stage, stamped before the agent ran.
    expect(labelsWritten()).toEqual(["stage:implementing"]);
    expect(setStatusMock).not.toHaveBeenCalled();
    expect(unassignMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
    // The session log is where the cancellation is accounted for.
    const logged = appendSessionLogMock.mock.calls.map((c) => (c as unknown as string[])[1]).join("");
    expect(logged).toContain("cancelled before writing");
    expect(logged).toContain(`[aborted] ${TICKET_ID} was aborted mid-run`);
  });

  // At `shadow` the repair never reaches its own under-lock abort check — it returns before the
  // locks — so a kill landing during the GitHub read would otherwise arrive at the shadow note with
  // nothing having asked the signal (PR #238 review). The recording asks it, and keeps the session
  // log as the only account.
  it("writes no shadow note when the job is cancelled while the claim is being verified", async () => {
    const controller = new AbortController();
    readCommitNamingMock.mockImplementationOnce(async () => {
      // Lands inside the check — before the repair has decided anything, long after the settlement
      // read the signal.
      controller.abort();
      return { state: "found", sha: "b".repeat(40) };
    });

    const halt = await haltOf(
      { outcome: "blocked", klass: "already-shipped", reason: `Already implemented by ${SHIPPED_ID}` },
      controller.signal,
      "shadow",
    );

    expect(halt.message).toMatch(/produced no delivery/);
    expect(noteMock).not.toHaveBeenCalled();
    expect(supersedeMock).not.toHaveBeenCalled();
    expect(setStatusMock).not.toHaveBeenCalled();
    expect(unassignMock).not.toHaveBeenCalled();
    const logged = appendSessionLogMock.mock.calls.map((c) => (c as unknown as string[])[1]).join("");
    expect(logged).toContain("not recorded on the bead — the job was cancelled");
    expect(logged).toContain("shadow (not armed to write)");
    expect(logged).toContain(`[aborted] ${TICKET_ID} was aborted mid-run`);
  });

  it("retires a verified claim when the signal never fires, closing the ticket against its survivor", async () => {
    readCommitNamingMock.mockResolvedValue({ state: "found", sha: "b".repeat(40) });

    const halt = await haltOf({
      outcome: "blocked",
      klass: "already-shipped",
      reason: `Already implemented by ${SHIPPED_ID}`,
    });

    expect(halt.message).toContain(SHIPPED_ID);
    expect(supersedeMock).toHaveBeenCalledWith(REPO, TICKET_ID, SHIPPED_ID);
    expect(setStatusMock).not.toHaveBeenCalled();
    expect(unassignMock).toHaveBeenCalledWith(REPO, TICKET_ID);
  });
});
