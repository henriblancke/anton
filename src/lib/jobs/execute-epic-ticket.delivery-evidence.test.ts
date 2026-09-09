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
/**
 * The commit the worktree forked from, as `warmRunWorktree` pinned it at CREATION — what every
 * landing check is measured against, not `origin/main` and not a fork recomputed here.
 */
const FORK = "f".repeat(40);

const claimMock = vi.fn(async () => {});
const tagMock = vi.fn(async () => {});
const untagMock = vi.fn(async () => {});
const setStatusMock = vi.fn(async () => {});
const unassignMock = vi.fn(async () => {});
const noteMock = vi.fn(async () => {});
const closeMock = vi.fn(async () => {});
const supersedeMock = vi.fn<(repo: string, id: string, replacementId: string) => Promise<void>>(async () => {});
const syncMock = vi.fn(async () => {});
/**
 * `bd show` as the repair sees it: the board's answer, with this run's own supersede layered over it
 * once written — the post-write fence re-reads the ticket closed against its survivor, the way a
 * real bd would answer after the write.
 */
const showMock = vi.fn(async (_repo: string, id: string) => shown(id));
const loadAllIssuesMock = vi.fn(async () => board());
const startJobSessionMock = vi.fn(async () => ({ sessionId: "sess-1", logPath: "/tmp/sess-1.log" }));
const endSessionMock = vi.fn(async () => {});
const appendSessionLogMock = vi.fn(async () => {});
const updateRunMock = vi.fn(async () => {});
const readWorktreeStateMock = vi.fn(async () => ({ head: "a".repeat(40), status: "" }));
/** What the base's history says of a bead — `none` unless a case seeds a landing. */
const readCommitNamingMock = vi.fn<(repo: string, beadId: string, base: string) => Promise<CommitNaming>>(
  async () => ({ state: "none" }),
);
/** The fork point the repair pins its base to (PR #238 review) — the worktree's, read at the write. */
const resolveForkPointMock = vi.fn<(worktree: string, base: string) => Promise<string>>(async () => FORK);
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
      supersede: (...args: unknown[]) => supersedeMock(...(args as [string, string, string])),
      sync: (...args: unknown[]) => syncMock(...(args as [])),
      show: (repo: string, id: string) => showMock(repo, id),
      history: async () => [],
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
    readCommitNaming: (repo: string, beadId: string, base: string) => readCommitNamingMock(repo, beadId, base),
    resolveForkPoint: (worktree: string, base: string) => resolveForkPointMock(worktree, base),
    readCommitReach: (repo: string, sha: string) => readCommitReachMock(repo, sha),
  };
});

const { runTicket } = await import("./execute-epic-ticket");
const { isPoisonError } = await import("./errors");

/** The run target the ticket rides — the epic `run()` dispatches for. */
const EPIC_ID = "anton-epic";

/**
 * The ticket under test: claimed, hanging under the run's epic, and citing no paths, so `ref-stale`
 * has nothing to say about it.
 */
function ticket(): Bead {
  return {
    id: TICKET_ID,
    title: "A ticket the agent delivered nothing for",
    status: "in_progress",
    description: "## Goal\nShip it.",
    labels: ["stage:implementing"],
    parent: EPIC_ID,
  } as Bead;
}

/**
 * The board the repair checks a claim against — the ticket under its epic, and one bead that has
 * NOT landed. The epic is on it because the `already-shipped` fence asks whose card the ticket
 * rides on the post-report board, and holds it to the run target it was dispatched under.
 */
function board(): Bead[] {
  return [
    ticket(),
    { id: EPIC_ID, title: "The epic", status: "in_progress", issue_type: "epic", labels: [] } as Bead,
    { id: NOT_SHIPPED_ID, title: "Work that has not landed", status: "open", labels: [] } as Bead,
    { id: SHIPPED_ID, title: "Work that landed", status: "closed", labels: [] } as Bead,
  ];
}

function beadById(id: string): Bead {
  const found = board().find((b) => b.id === id);
  if (!found) throw new Error(`no such bead: ${id}`);
  return found;
}

/**
 * A bead as bd would answer AFTER this run's writes: the `not-delivered` marker `bd tag` stamped
 * layered on (and any `bd untag` removed), and — once superseded — closed with the `supersedes`
 * edge to its survivor. The marker matters as much as the edge: the retirement's post-write reread
 * ({@link markerOvertaken}) asserts the marker is present, not just the close, so a `shown` that
 * dropped it would read every retirement as overtaken-and-marker-stripped (PR #238 review).
 */
function shown(id: string): Bead {
  const read = beadById(id);
  const labels = new Set(read.labels ?? []);
  for (const [, target, written] of tagMock.mock.calls as unknown as [string, string, string[]][]) {
    if (target === id) for (const l of written ?? []) labels.add(l);
  }
  for (const [, target, removed] of untagMock.mock.calls as unknown as [string, string, string[]][]) {
    if (target === id) for (const l of removed ?? []) labels.delete(l);
  }
  const written = supersedeMock.mock.calls.find(([, target]) => target === id);
  return {
    ...read,
    labels: [...labels],
    ...(written
      ? {
          status: "closed",
          dependencies: [{ issue_id: id, depends_on_id: written[2], type: "supersedes" }],
        }
      : {}),
  } as Bead;
}

/**
 * One dispatching step carrying the agent's self-report — and, when a case says so, the bead it
 * was prompted with — then the commit that reports the diff.
 */
function steps(selfReport: AntonResult | null, committed: boolean, dispatched?: Bead): ResolvedStep[] {
  const define = (name: string, handler: () => Promise<unknown>): ResolvedStep =>
    ({
      step: { id: name },
      definition: { name, class: "required", summary: name, producesDiff: false, handler },
    }) as unknown as ResolvedStep;
  return [
    define("implement", async () => ({ ok: true, facts: { selfReport, dispatched } })),
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
    baseForkSha: FORK,
    target: { id: EPIC_ID, title: "The epic", status: "in_progress", issue_type: "epic" } as Bead,
    settings: { repairAutonomy: { "already-shipped": autonomy } },
  } as unknown as Omit<StepContext, "tickets">;
}

/** Walk the ticket and hand back the error it halted on (failing if it did not halt). */
async function haltOf(
  selfReport: AntonResult | null,
  signal?: AbortSignal,
  autonomy?: "apply" | "shadow",
  dispatched?: Bead,
): Promise<Error> {
  const caught = await runTicket({
    run: run(signal, autonomy),
    steps: steps(selfReport, false, dispatched),
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
    showMock.mockImplementation(async (_repo: string, id: string) => shown(id));
    loadAllIssuesMock.mockImplementation(async () => board());
    startJobSessionMock.mockImplementation(async () => ({
      sessionId: "sess-1",
      logPath: "/tmp/sess-1.log",
    }));
    readWorktreeStateMock.mockImplementation(async () => ({ head: "a".repeat(40), status: "" }));
    resolveForkPointMock.mockImplementation(async () => FORK);
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

  // The bead the implementer was prompted with travels from the dispatching step to the repair
  // (PR #238 review): a human note the operator appends while the agent runs is an instruction it
  // never saw, and the retirement is fenced on the notes the prompt actually carried.
  it("refuses to retire a verified claim when a human note landed after the agent was prompted", async () => {
    readCommitNamingMock.mockResolvedValue({ state: "found", sha: "b".repeat(40), committedAt: "2026-01-01T00:00:00Z" });
    const steered = {
      ...ticket(),
      notes: "[human-note Henri 2026-09-07T10:00:00.000Z]\n  also cover the other app",
    };
    showMock.mockImplementation(async (_repo: string, id: string) => (id === TICKET_ID ? steered : shown(id)));

    const halt = await haltOf(
      { outcome: "blocked", klass: "already-shipped", reason: `Already implemented by ${SHIPPED_ID}` },
      undefined,
      undefined,
      { ...ticket(), notes: "" },
    );

    expect(halt.message).toMatch(/produced no delivery/);
    expect(supersedeMock).not.toHaveBeenCalled();
    expect(setStatusMock).toHaveBeenCalledWith(REPO, TICKET_ID, "blocked");
    const refusal = notesWritten().find((n) => n.includes("did not repair this as `already-shipped`"));
    expect(refusal).toContain("rewritten while the agent was running");
    expect(refusal).toContain("human notes changed while it ran");
  });

  // The settlement reads the job's abort ONCE before the repair, and the repair then reads git, asks
  // GitHub and waits on locks (PR #238 review). A kill landing in that window must leave the board
  // exactly as an abort landing before it would: nothing retired, nothing noted, nothing released.
  it("retires and writes NOTHING when the job is cancelled while a verified claim is being settled", async () => {
    const controller = new AbortController();
    readCommitNamingMock.mockResolvedValue({ state: "found", sha: "b".repeat(40), committedAt: "2026-01-01T00:00:00Z" });
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
      return { state: "found", sha: "b".repeat(40), committedAt: "2026-01-01T00:00:00Z" };
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
    readCommitNamingMock.mockResolvedValue({ state: "found", sha: "b".repeat(40), committedAt: "2026-01-01T00:00:00Z" });

    const halt = await haltOf({
      outcome: "blocked",
      klass: "already-shipped",
      reason: `Already implemented by ${SHIPPED_ID}`,
    });

    expect(halt.message).toContain(SHIPPED_ID);
    expect(supersedeMock).toHaveBeenCalledWith(REPO, TICKET_ID, SHIPPED_ID);
    expect(setStatusMock).not.toHaveBeenCalled();
    expect(unassignMock).toHaveBeenCalledWith(REPO, TICKET_ID);
    // Checked against the PERSISTED fork commit, never the moving `origin/main` the run was cut at
    // and never a fork recomputed here (PR #238 review): `origin/<base>` can be force-reset backward
    // after the worktree was made, and re-running `merge-base` then answers the rewound tip — a
    // survivor between the two is in the checkout's real base but absent from that older history, so
    // the check would reject a valid claim. The pin is immutable across resumes and base rewinds.
    expect(readCommitNamingMock).toHaveBeenCalledWith(REPO, SHIPPED_ID, FORK);
    expect(readCommitNamingMock).not.toHaveBeenCalledWith(REPO, SHIPPED_ID, "origin/main");
    expect(resolveForkPointMock).not.toHaveBeenCalled();
  });

  // The rewind the pin exists for (PR #238 review): the base moved back after the worktree was cut,
  // so a recompute would hand the check the older history. The persisted SHA is what the repair
  // reads, so the verdict is unchanged by whatever `origin/main` now points at.
  it("verifies against the pinned fork even when the base has since been rewound", async () => {
    readCommitNamingMock.mockResolvedValue({ state: "found", sha: "b".repeat(40), committedAt: "2026-01-01T00:00:00Z" });
    // Were the fork recomputed here, this is the rewound answer the check would have used.
    resolveForkPointMock.mockResolvedValue("e".repeat(40));

    await haltOf({
      outcome: "blocked",
      klass: "already-shipped",
      reason: `Already implemented by ${SHIPPED_ID}`,
    });

    expect(readCommitNamingMock).toHaveBeenCalledWith(REPO, SHIPPED_ID, FORK);
    expect(readCommitNamingMock).not.toHaveBeenCalledWith(REPO, SHIPPED_ID, "e".repeat(40));
    expect(supersedeMock).toHaveBeenCalledWith(REPO, TICKET_ID, SHIPPED_ID);
  });

  // The repair reads the bead fresh after the report, and an edit landing while the agent ran is
  // already in that read (PR #238 review). The claim was made about the ticket the agent was
  // PROMPTED with — the run's snapshot — so the repair is handed that too, and a contract that moved
  // between the two blocks the ticket for a human instead of retiring the widened one.
  it("refuses a verified claim when the ticket was rewritten while the agent was running", async () => {
    readCommitNamingMock.mockResolvedValue({ state: "found", sha: "b".repeat(40), committedAt: "2026-01-01T00:00:00Z" });
    showMock.mockImplementation(async (_repo: string, id: string) =>
      id === TICKET_ID ? { ...shown(id), description: "## Goal\nShip it.\n## Acceptance\n- [ ] and the other half too" } : shown(id),
    );

    const halt = await haltOf({
      outcome: "blocked",
      klass: "already-shipped",
      reason: `Already implemented by ${SHIPPED_ID}`,
    });

    expect(halt.message).toMatch(/produced no delivery/);
    expect(supersedeMock).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
    expect(setStatusMock).toHaveBeenCalledWith(REPO, TICKET_ID, "blocked");
    expect(labelsWritten().some((l) => l.startsWith("repair:"))).toBe(false);
    const refusal = notesWritten().find((n) => n.includes("did not repair this as `already-shipped`"));
    expect(refusal).toBeDefined();
    expect(refusal).toContain("rewritten while the agent was running");
    expect(refusal).toContain("description changed while it ran");
  });

  // The same window, for the ticket's HOME (PR #238 review): a re-parent landing while the agent
  // ran is already in the post-report reads, so the run's own target is what the repair is handed
  // to hold the ticket to — and a ticket that now rides another run is blocked for a human.
  it("refuses a verified claim when the ticket was re-homed to another run while the agent was running", async () => {
    const OTHER_EPIC = "anton-othr";
    readCommitNamingMock.mockResolvedValue({ state: "found", sha: "b".repeat(40), committedAt: "2026-01-01T00:00:00Z" });
    const moved = (): Bead[] => [
      ...board().map((b) => (b.id === TICKET_ID ? ({ ...b, parent: OTHER_EPIC } as Bead) : b)),
      { id: OTHER_EPIC, title: "Another epic", status: "in_progress", issue_type: "epic", labels: [] } as Bead,
    ];
    loadAllIssuesMock.mockImplementation(async () => moved());
    showMock.mockImplementation(async (_repo: string, id: string) => moved().find((b) => b.id === id) ?? shown(id));

    const halt = await haltOf({
      outcome: "blocked",
      klass: "already-shipped",
      reason: `Already implemented by ${SHIPPED_ID}`,
    });

    expect(halt.message).toMatch(/produced no delivery/);
    expect(supersedeMock).not.toHaveBeenCalled();
    expect(setStatusMock).toHaveBeenCalledWith(REPO, TICKET_ID, "blocked");
    const refusal = notesWritten().find((n) => n.includes("did not repair this as `already-shipped`"));
    expect(refusal).toBeDefined();
    expect(refusal).toContain("re-homed while the agent was running");
    expect(refusal).toContain(`hung under \`${EPIC_ID}\` when the agent was dispatched`);
    expect(refusal).toContain(`hangs under \`${OTHER_EPIC}\` now`);
  });
});
