/**
 * Unit tests for the rework action (anton-4ocm) — the decision logic, with bd faked. That the writes
 * actually land on a board (and that a reopened bead really re-enters the run) is the integration
 * suite's job: src/app/api/projects/[slug]/epics/[epicId]/rework/route.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "./beads/bd";
import { formatHumanNote } from "./beads/notes";
import type { Project } from "./types";

const showMock = vi.fn<(cwd: string, id: string) => Promise<Bead>>();
const listMock = vi.fn<() => Promise<Bead[]>>();
const noteMock = vi.fn();
const reopenMock = vi.fn();
const untagMock = vi.fn();
type CreateOpts = {
  title: string;
  type: string;
  description: string;
  labels: string[];
  deps?: string[];
};
const createMock = vi.fn<(cwd: string, opts: CreateOpts) => Promise<string>>();
const linkMock = vi.fn();
const retirePrRefMock = vi.fn();
const setPrRefMock = vi.fn();
const tagMock = vi.fn();
const closeMock = vi.fn();
const reparentMock = vi.fn();
const runIsLiveMock = vi.fn<(projectId: string, targetId: string) => boolean>();
const prStateMock = vi.fn<(repo: string, ref: string) => Promise<string>>();

vi.mock("./beads/bd", async () => {
  const actual = await vi.importActual<typeof import("./beads/bd")>("./beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      show: (...args: [string, string]) => showMock(...args),
      list: () => listMock(),
      note: (...args: unknown[]) => noteMock(...args),
      reopen: (...args: unknown[]) => reopenMock(...args),
      untag: (...args: unknown[]) => untagMock(...args),
      create: (...args: unknown[]) => createMock(...(args as [string, CreateOpts])),
      link: (...args: unknown[]) => linkMock(...args),
      retirePrRef: (...args: unknown[]) => retirePrRefMock(...args),
      setPrRef: (...args: unknown[]) => setPrRefMock(...args),
      tag: (...args: unknown[]) => tagMock(...args),
      close: (...args: unknown[]) => closeMock(...args),
      reparent: (...args: unknown[]) => reparentMock(...args),
    },
  };
});

vi.mock("./jobs/service", () => ({
  runIsLiveForTarget: (...args: [string, string]) => runIsLiveMock(...args),
}));

vi.mock("./git/ops", () => ({
  pullRequestState: (...args: [string, string]) => prStateMock(...args),
}));

vi.mock("./beads/sync-nudge", () => ({ nudgeSync: vi.fn() }));

vi.mock("./operator", () => ({ resolveOperator: async () => "founder" }));

const {
  reworkTicket,
  reworkNoteBody,
  ReworkConflictError,
  ReworkInvalidError,
  ReworkNotAllowedError,
  ReworkNotFoundError,
  ReworkUnavailableError,
} = await import("./rework");

const project: Project = {
  id: "p1",
  slug: "p",
  name: "p",
  repoPath: "/repo",
} as Project;

function makeBead(over: Partial<Bead> & { id: string }): Bead {
  return { title: over.id, status: "open", issue_type: "task", labels: [], ...over };
}

/** A feature run target with two tickets under it — the ordinary grouped run. */
const feature = () => makeBead({ id: "feat", issue_type: "feature", labels: ["approved"] });
const ticketA = () => makeBead({ id: "t1", title: "Ticket one", parent: "feat", labels: ["agent:nextjs", "size:M"] });
const ticketB = () => makeBead({ id: "t2", title: "Ticket two", parent: "feat" });

function board(...beadsOnBoard: Bead[]): void {
  listMock.mockResolvedValue(beadsOnBoard);
}

const INSTRUCTIONS = "Add a test that fails without the null guard.";

const input = (over: Partial<Parameters<typeof reworkTicket>[2]> = {}) => ({
  ticketId: "t1",
  mode: "reopen" as const,
  summary: "the API is still untested",
  instructions: INSTRUCTIONS,
  ...over,
});

/**
 * The instruction note an earlier attempt's follow-up carries. The dedupe compares it, so a bead
 * with the same title but different instructions is a different request rather than a duplicate.
 */
function followUpNote(args: {
  targetId: string;
  originId: string;
  summary: string;
  redirected?: boolean;
}): string {
  return reworkNoteBody({
    mode: "follow-up",
    instructions: INSTRUCTIONS,
    findings: [],
    redirected: false,
    ...args,
  });
}

/** Serve that note from `bd show` — `bd list` doesn't carry notes, so the dedupe re-reads the bead. */
function showsWithNote(id: string, body: string): void {
  const base = showMock.getMockImplementation()!;
  showMock.mockImplementation(async (cwd, beadId) =>
    beadId === id
      ? makeBead({ id, notes: formatHumanNote(body, "founder", new Date()) })
      : base(cwd, beadId),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  runIsLiveMock.mockReturnValue(false);
  createMock.mockResolvedValue("anton-new");
  showMock.mockImplementation(async (_cwd, id) => makeBead({ id, status: "closed" }));
  // No PR on the target unless a case puts one there, so `pullRequestState` is never consulted.
  prStateMock.mockResolvedValue("unknown");
  board(feature(), ticketA(), ticketB());
});

/**
 * A board whose feature target carries a PR ref, plus what `gh` reports that PR's state to be. The
 * ref is on the `show` read too — the retire re-reads the target under the lock and decides there.
 */
function targetWithPr(state: "open" | "merged" | "closed" | "unknown", ref = "gh-42"): void {
  board(makeBead({ id: "feat", issue_type: "feature", metadata: { pr: ref } }), ticketA(), ticketB());
  showMock.mockImplementation(async (_cwd, id) =>
    id === "feat"
      ? makeBead({ id, issue_type: "feature", status: "open", metadata: { pr: ref } })
      : makeBead({ id, status: "closed" }),
  );
  prStateMock.mockResolvedValue(state);
}

describe("validation", () => {
  it("refuses an empty summary or empty instructions", async () => {
    await expect(reworkTicket(project, "feat", input({ summary: "  " }))).rejects.toBeInstanceOf(
      ReworkInvalidError,
    );
    await expect(reworkTicket(project, "feat", input({ instructions: "" }))).rejects.toBeInstanceOf(
      ReworkInvalidError,
    );
    expect(noteMock).not.toHaveBeenCalled();
  });

  it("refuses a missing ticket id as malformed, not as a rework that can't apply", async () => {
    await expect(reworkTicket(project, "feat", input({ ticketId: "" }))).rejects.toBeInstanceOf(
      ReworkInvalidError,
    );
    await expect(reworkTicket(project, "feat", input({ ticketId: "  " }))).rejects.toBeInstanceOf(
      ReworkInvalidError,
    );
    expect(noteMock).not.toHaveBeenCalled();
  });

  it("refuses an oversized instruction — it is inlined verbatim into the agent's prompt", async () => {
    await expect(
      reworkTicket(project, "feat", input({ instructions: "x".repeat(2001) })),
    ).rejects.toBeInstanceOf(ReworkInvalidError);
  });

  it("refuses a mode it doesn't implement rather than guessing one", async () => {
    await expect(
      reworkTicket(project, "feat", input({ mode: "delete" as never })),
    ).rejects.toBeInstanceOf(ReworkInvalidError);
  });

  it("404s an id the board doesn't carry", async () => {
    await expect(reworkTicket(project, "nope", input())).rejects.toBeInstanceOf(ReworkNotFoundError);
  });

  it("422s a container epic — rework is decided against a run, and a container never runs", async () => {
    board(
      makeBead({ id: "container", issue_type: "epic" }),
      makeBead({ id: "feat", issue_type: "feature", parent: "container" }),
      ticketA(),
    );
    await expect(reworkTicket(project, "container", input())).rejects.toBeInstanceOf(
      ReworkNotAllowedError,
    );
  });

  it("422s a ticket that belongs to another run target", async () => {
    board(feature(), ticketA(), makeBead({ id: "stranger" }));
    await expect(
      reworkTicket(project, "feat", input({ ticketId: "stranger" })),
    ).rejects.toBeInstanceOf(ReworkNotAllowedError);
  });
});

describe("live-run race check", () => {
  it("409s while a run holds the target on this machine, before any write", async () => {
    runIsLiveMock.mockReturnValue(true);
    await expect(reworkTicket(project, "feat", input())).rejects.toBeInstanceOf(ReworkConflictError);
    expect(noteMock).not.toHaveBeenCalled();
    expect(reopenMock).not.toHaveBeenCalled();
  });

  it("409s on another machine's unexpired run-lease", async () => {
    board(
      makeBead({
        id: "feat",
        issue_type: "feature",
        labels: [`run-lease:${Date.now() + 60_000}:other-run`],
      }),
      ticketA(),
    );
    await expect(reworkTicket(project, "feat", input())).rejects.toBeInstanceOf(ReworkConflictError);
    expect(noteMock).not.toHaveBeenCalled();
  });

  it("proceeds past a LAPSED lease — an expired lease is a stopped run", async () => {
    board(
      makeBead({
        id: "feat",
        issue_type: "feature",
        labels: [`run-lease:${Date.now() - 60_000}:dead-run`],
      }),
      ticketA(),
    );
    await expect(reworkTicket(project, "feat", input())).resolves.toMatchObject({ applied: true });
  });
});

describe("reopen", () => {
  /** The note body {@link input}'s rework writes — what a repeat of it finds already on the bead. */
  const sameNote = () =>
    reworkNoteBody({
      mode: "reopen",
      targetId: "feat",
      summary: "the API is still untested",
      instructions: "Add a test that fails without the null guard.",
      findings: [],
    });

  it("writes the instructions as a HUMAN note, then reopens with the reason", async () => {
    const result = await reworkTicket(project, "feat", input());

    expect(result).toMatchObject({ mode: "reopen", ticketId: "t1", reworkedId: "t1", applied: true });
    const [, notedId, noteText] = noteMock.mock.calls[0] as [string, string, string];
    expect(notedId).toBe("t1");
    // The header formatHumanNote stamps is what makes the dispatch prompt pick it up as steering.
    expect(noteText).toMatch(/^\[human-note founder /);
    expect(noteText).toContain("Add a test that fails without the null guard.");
    expect(reopenMock).toHaveBeenCalledWith("/repo", "t1", "rework: the API is still untested");
  });

  it("attaches the selected findings verbatim, with their severity", async () => {
    await reworkTicket(
      project,
      "feat",
      input({
        findings: [
          { severity: "blocking", location: "src/a.ts:12", note: "no null guard" },
          { severity: "advisory", location: "(general)", note: "naming drifts" },
        ],
      }),
    );
    const noteText = noteMock.mock.calls[0][2] as string;
    expect(noteText).toContain("- [blocking] src/a.ts:12 — no null guard");
    expect(noteText).toContain("- [advisory] (general) — naming drifts");
  });

  it("strips the finished run's stage labels, so the next run doesn't skip the ticket it must redo", async () => {
    await reworkTicket(project, "feat", input());
    expect(untagMock).toHaveBeenCalledWith("/repo", "t1", ["stage:implementing", "stage:in-review"]);
  });

  it("does not call bd reopen on a ticket that is already open — the reason lives in the note", async () => {
    showMock.mockResolvedValue(makeBead({ id: "t1", status: "open" }));
    await reworkTicket(project, "feat", input());
    expect(noteMock).toHaveBeenCalled();
    expect(reopenMock).not.toHaveBeenCalled();
  });

  it("is a no-op on a double submit: the identical note is on an already-reopened bead", async () => {
    showMock.mockResolvedValue(
      makeBead({ id: "t1", status: "open", notes: formatHumanNote(sameNote(), "founder", new Date()) }),
    );

    const result = await reworkTicket(project, "feat", input());
    expect(result.applied).toBe(false);
    expect(result.reworkedId).toBe("t1");
    expect(noteMock).not.toHaveBeenCalled();
    expect(reopenMock).not.toHaveBeenCalled();
  });

  it("re-applies when the bead carrying the note has since been CLOSED again", async () => {
    // The founder sent this ticket back once, a run closed it, and they are sending the same
    // instructions back again. On note text alone the second send-back would silently do nothing
    // and leave the ticket closed while the UI says it went back.
    showMock.mockResolvedValue(
      makeBead({ id: "t1", status: "closed", notes: formatHumanNote(sameNote(), "founder", new Date()) }),
    );

    const result = await reworkTicket(project, "feat", input());
    expect(result.applied).toBe(true);
    expect(reopenMock).toHaveBeenCalledWith("/repo", "t1", "rework: the API is still untested");
  });

  it("re-applies when the note landed but the run's stage labels are still on the bead", async () => {
    // A half-applied rework (the untag never ran): `stage:in-review` left on makes the next run skip
    // the very ticket it was told to redo, so the repeat must finish the job, not report it done.
    showMock.mockResolvedValue(
      makeBead({
        id: "t1",
        status: "open",
        labels: ["stage:in-review"],
        notes: formatHumanNote(sameNote(), "founder", new Date()),
      }),
    );

    const result = await reworkTicket(project, "feat", input());
    expect(result.applied).toBe(true);
    expect(untagMock).toHaveBeenCalledWith("/repo", "t1", ["stage:implementing", "stage:in-review"]);
  });

  it("still applies a DIFFERENT rework of the same ticket", async () => {
    const body = reworkNoteBody({
      mode: "reopen",
      targetId: "feat",
      summary: "an older complaint",
      instructions: "something else entirely",
      findings: [],
    });
    showMock.mockResolvedValue(
      makeBead({ id: "t1", status: "closed", notes: formatHumanNote(body, "founder", new Date()) }),
    );
    await expect(reworkTicket(project, "feat", input())).resolves.toMatchObject({ applied: true });
  });
});

describe("follow-up", () => {
  const followUp = () => input({ mode: "follow-up" as const, summary: "Harden the retry path" });

  it("creates a contract-shaped bead under the run target and links it discovered-from the ticket", async () => {
    const result = await reworkTicket(project, "feat", followUp());

    expect(result).toMatchObject({ mode: "follow-up", ticketId: "t1", reworkedId: "anton-new", applied: true });
    const opts = createMock.mock.calls[0][1];
    expect(opts.title).toBe("Harden the retry path");
    expect(opts.type).toBe("task");
    expect(opts.deps).toEqual(["parent-child:feat"]);
    // Every section the bead contract judges, or the approve route refuses the follow-up it just made.
    for (const section of [
      "## Goal",
      "## Acceptance Criteria",
      "## Context",
      "## Out of scope",
      "## Verify",
    ]) {
      expect(opts.description).toContain(section);
    }
    expect(linkMock).toHaveBeenCalledWith("/repo", "anton-new", "t1", "discovered-from");
  });

  it("inherits routing labels but never the founder's own gates", async () => {
    board(
      feature(),
      makeBead({
        id: "t1",
        parent: "feat",
        labels: ["agent:nextjs", "size:M", "approved", "stage:in-review", "review-score:4"],
      }),
    );
    await reworkTicket(project, "feat", followUp());
    const labels = createMock.mock.calls[0][1].labels;
    expect(labels).toEqual(["agent:nextjs", "size:M"]);
  });

  it("leaves the original ticket's status alone — its acceptance stands, so its score stands", async () => {
    await reworkTicket(project, "feat", followUp());
    expect(reopenMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  it("notes both beads: the instructions on the new one, a pointer on the original", async () => {
    await reworkTicket(project, "feat", followUp());
    const noted = noteMock.mock.calls.map((c) => [c[1], c[2] as string]);
    expect(noted.map(([id]) => id)).toEqual(["anton-new", "t1"]);
    expect(noted[0][1]).toContain("Add a test that fails without the null guard.");
    expect(noted[1][1]).toContain("anton-new");
  });

  it("creates a PARENTLESS follow-up under a standalone task target — nothing would ever run a child of one", async () => {
    board(makeBead({ id: "solo", title: "Standalone", issue_type: "task", labels: ["approved"] }));
    const result = await reworkTicket(project, "solo", { ...followUp(), ticketId: "solo" });
    expect(result.reworkedId).toBe("anton-new");
    const opts = createMock.mock.calls[0][1];
    expect(opts.deps).toBeUndefined();
    expect(opts.description).toContain("its own run target");
  });

  it("is a no-op on a double submit: the same follow-up is already linked to the ticket", async () => {
    board(
      feature(),
      ticketA(),
      makeBead({
        id: "already",
        title: "Harden the retry path",
        parent: "feat",
        dependencies: [{ issue_id: "already", depends_on_id: "t1", type: "discovered-from" }],
      }),
    );
    showsWithNote(
      "already",
      followUpNote({ targetId: "feat", originId: "t1", summary: "Harden the retry path" }),
    );

    const result = await reworkTicket(project, "feat", followUp());
    expect(result).toMatchObject({ applied: false, reworkedId: "already" });
    expect(createMock).not.toHaveBeenCalled();
    expect(noteMock).not.toHaveBeenCalled();
  });

  it("is NOT a duplicate when the bead with that title carries different instructions", async () => {
    // Same title, same origin — but the note on it is another request's. Reusing it would report
    // instructions that are nowhere on the bead and hand the implementer the earlier ones.
    board(
      feature(),
      ticketA(),
      makeBead({
        id: "already",
        title: "Harden the retry path",
        parent: "feat",
        dependencies: [{ issue_id: "already", depends_on_id: "t1", type: "discovered-from" }],
      }),
    );
    showsWithNote(
      "already",
      followUpNote({
        targetId: "feat",
        originId: "t1",
        summary: "Harden the retry path",
      }).replace(INSTRUCTIONS, "Something the founder asked for last week."),
    );

    const result = await reworkTicket(project, "feat", followUp());

    expect(result).toMatchObject({ applied: true, reworkedId: "anton-new" });
    expect(createMock).toHaveBeenCalled();
  });

  it("still applies when the existing follow-up was closed — that iteration is over", async () => {
    board(
      feature(),
      ticketA(),
      makeBead({
        id: "already",
        title: "Harden the retry path",
        status: "closed",
        dependencies: [{ issue_id: "already", depends_on_id: "t1", type: "discovered-from" }],
      }),
    );
    await expect(reworkTicket(project, "feat", followUp())).resolves.toMatchObject({ applied: true });
  });

  describe("an earlier attempt that died mid-creation", () => {
    /** A follow-up of the ticket, by id — the same title and `discovered-from` edge every attempt writes. */
    const followUpBead = (id: string) =>
      makeBead({
        id,
        title: "Harden the retry path",
        parent: "feat",
        dependencies: [{ issue_id: id, depends_on_id: "t1", type: "discovered-from" }],
      });

    /** Created and linked by a previous attempt, but carrying no note — the `bd note` never landed. */
    function halfCreated(...rest: Bead[]): void {
      board(feature(), ticketA(), followUpBead("already"), ...rest);
    }

    it("finishes it instead of opening a second follow-up beside it", async () => {
      // `bd create` and `bd link` landed, `bd note` failed. On the note alone the retry would reject
      // this bead and create a duplicate — two discovered-from beads a founder can approve twice.
      halfCreated();

      const result = await reworkTicket(project, "feat", followUp());

      expect(createMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ reworkedId: "already", applied: true });
      const noted = noteMock.mock.calls.map((c) => [c[1], c[2] as string] as const);
      // Both writes the dead attempt still owed: the instructions, then the origin's pointer.
      expect(noted.map(([id]) => id)).toEqual(["already", "t1"]);
      expect(noted[0][1]).toContain(INSTRUCTIONS);
      expect(noted[1][1]).toContain("already");
    });

    it("prefers the bead that carries THIS request's note over an unfinished one", async () => {
      // Two candidates: a founder's completed follow-up and the remains of another attempt. Adopting
      // the unfinished one would write a second copy of instructions the board already carries.
      halfCreated(followUpBead("done"));
      showsWithNote(
        "done",
        followUpNote({ targetId: "feat", originId: "t1", summary: "Harden the retry path" }),
      );

      const result = await reworkTicket(project, "feat", followUp());

      expect(result).toMatchObject({ reworkedId: "done", applied: false });
      expect(noteMock).not.toHaveBeenCalled();
    });
  });
});

/** When `mock` was called with `id` as its bead argument — for asserting the order of two writes. */
function orderOfCallOn(mock: ReturnType<typeof vi.fn>, id: string): number {
  const index = mock.mock.calls.findIndex((c) => c[1] === id);
  expect(index).toBeGreaterThanOrEqual(0);
  return mock.mock.invocationCallOrder[index];
}

describe("pipeline: the target's own pull request (anton-leit)", () => {
  it("reports no pipeline work when nothing stands between the bead and the next run", async () => {
    const result = await reworkTicket(project, "feat", input());
    expect(result.pipeline).toBeUndefined();
    expect(prStateMock).not.toHaveBeenCalled();
    expect(retirePrRefMock).not.toHaveBeenCalled();
  });

  describe("PR still open", () => {
    beforeEach(() => targetWithPr("open"));

    it("retires the target's finished-run marker, so its next run executes instead of short-circuiting", async () => {
      const result = await reworkTicket(project, "feat", input());

      expect(result.pipeline).toEqual({ outcome: "retired", pr: "gh-42", redirected: false });
      // The PR ref is what execute-epic step 0a reads as "another run already finished this".
      expect(retirePrRefMock).toHaveBeenCalledWith(
        "/repo",
        expect.objectContaining({ id: "feat" }),
        "gh-42",
      );
      // ...and in-review is what keeps review-fix/gate-check treating it as theirs to close out.
      expect(untagMock).toHaveBeenCalledWith("/repo", "feat", [
        "stage:implementing",
        "stage:in-review",
      ]);
    });

    it("leaves the requested mode alone — the branch and the PR are still there to run onto", async () => {
      const result = await reworkTicket(project, "feat", input());
      expect(result).toMatchObject({ mode: "reopen", reworkedId: "t1" });
      expect(createMock).not.toHaveBeenCalled();
    });

    it("reopens a target that is closed, or nothing would dispatch the ticket at all", async () => {
      showMock.mockImplementation(async (_cwd, id) =>
        makeBead({ id, status: "closed", metadata: id === "feat" ? { pr: "gh-42" } : undefined }),
      );
      await reworkTicket(project, "feat", input());
      expect(reopenMock).toHaveBeenCalledWith("/repo", "feat", expect.stringContaining("rework"));
    });

    it("clears the ref LAST, so a write that fails part-way leaves a retry a way back in", async () => {
      showMock.mockImplementation(async (_cwd, id) =>
        makeBead({ id, status: "closed", metadata: id === "feat" ? { pr: "gh-42" } : undefined }),
      );

      await reworkTicket(project, "feat", input());

      // The ref is the ONLY marker that brings a retry back into the retire (resolvePipeline reads
      // it), so untag/reopen have to be durable before it goes.
      const clearedAt = retirePrRefMock.mock.invocationCallOrder[0];
      expect(orderOfCallOn(untagMock, "feat")).toBeLessThan(clearedAt);
      expect(orderOfCallOn(reopenMock, "feat")).toBeLessThan(clearedAt);
    });

    it("verifies the PR is still open AFTER the writes before standing behind the retire", async () => {
      const result = await reworkTicket(project, "feat", input());

      // Once to decide the mode, once before the writes, once after them — the last read is the one
      // that can catch a merge landing while `untag`/`reopen`/`retirePrRef` were applying.
      expect(prStateMock).toHaveBeenCalledTimes(3);
      expect(result.pipeline).toEqual({ outcome: "retired", pr: "gh-42", redirected: false });
      expect(setPrRefMock).not.toHaveBeenCalled();
    });

    it("retires nothing twice: a repeat finds the ref already gone", async () => {
      // The re-read under the lock is what decides, so a target already retired writes nothing more.
      showMock.mockImplementation(async (_cwd, id) => makeBead({ id, status: "open" }));
      await reworkTicket(project, "feat", input());
      expect(retirePrRefMock).not.toHaveBeenCalled();
    });

    it("retires for a follow-up too, when the board card parents it into that same next run", async () => {
      const result = await reworkTicket(project, "feat", input({ mode: "follow-up" as const }));

      expect(createMock.mock.calls[0][1].deps).toEqual(["parent-child:feat"]);
      expect(result.pipeline).toEqual({ outcome: "retired", pr: "gh-42", redirected: false });
      expect(retirePrRefMock).toHaveBeenCalledWith(
        "/repo",
        expect.objectContaining({ id: "feat" }),
        "gh-42",
      );
    });
  });

  describe("PR still open, but the send-back runs as its OWN target", () => {
    /** A standalone task target carrying a live PR ref — where a follow-up comes out parentless. */
    function standaloneWithOpenPr(...rest: Bead[]): void {
      const solo = () =>
        makeBead({
          id: "solo",
          title: "Standalone",
          issue_type: "task",
          labels: ["approved", "stage:in-review"],
          metadata: { pr: "gh-42" },
        });
      board(solo(), ...rest);
      showMock.mockImplementation(async (_cwd, id) =>
        id === "solo" ? solo() : makeBead({ id, status: "closed" }),
      );
      prStateMock.mockResolvedValue("open");
    }

    const soloFollowUp = () =>
      input({ ticketId: "solo", mode: "follow-up" as const, summary: "Harden the retry path" });

    it("leaves the target's ref, stage and status alone — its open PR is still the merge gate", async () => {
      standaloneWithOpenPr();

      const result = await reworkTicket(project, "solo", soloFollowUp());

      // Parentless: `boardCards` never cards a task, so this bead is its own run target and the
      // target's next run would have nothing of the fix to carry.
      expect(createMock.mock.calls[0][1].deps).toBeUndefined();
      expect(retirePrRefMock).not.toHaveBeenCalled();
      expect(untagMock).not.toHaveBeenCalled();
      expect(reopenMock).not.toHaveBeenCalled();
      // ...so there is no pipeline work to report either: "run it again" would point the founder at
      // a target whose run still short-circuits, and whose work is already on the branch.
      expect(result.pipeline).toBeUndefined();
      expect(result).toMatchObject({ mode: "follow-up", reworkedId: "anton-new", applied: true });
    });

    it("retires nothing on the repeat either — the follow-up it finds is parentless too", async () => {
      standaloneWithOpenPr(
        makeBead({
          id: "already",
          title: "Harden the retry path",
          dependencies: [{ issue_id: "already", depends_on_id: "solo", type: "discovered-from" }],
        }),
      );
      showsWithNote(
        "already",
        followUpNote({ targetId: "solo", originId: "solo", summary: "Harden the retry path" }),
      );

      const result = await reworkTicket(project, "solo", soloFollowUp());

      expect(result).toMatchObject({ applied: false, reworkedId: "already" });
      expect(result.pipeline).toBeUndefined();
      expect(retirePrRefMock).not.toHaveBeenCalled();
    });

    it("still retires on a repeat whose follow-up IS parented under the target", async () => {
      // The half-applied send-back this retry exists to finish: the note landed, the reset didn't.
      board(
        makeBead({ id: "feat", issue_type: "feature", metadata: { pr: "gh-42" } }),
        ticketA(),
        makeBead({
          id: "already",
          title: "Harden the retry path",
          parent: "feat",
          dependencies: [{ issue_id: "already", depends_on_id: "t1", type: "discovered-from" }],
        }),
      );
      showMock.mockImplementation(async (_cwd, id) =>
        id === "feat"
          ? makeBead({ id, issue_type: "feature", metadata: { pr: "gh-42" } })
          : makeBead({ id, status: "closed" }),
      );
      showsWithNote(
        "already",
        followUpNote({ targetId: "feat", originId: "t1", summary: "Harden the retry path" }),
      );
      prStateMock.mockResolvedValue("open");

      const result = await reworkTicket(
        project,
        "feat",
        input({ mode: "follow-up" as const, summary: "Harden the retry path" }),
      );

      expect(result.applied).toBe(false);
      expect(retirePrRefMock).toHaveBeenCalledWith(
        "/repo",
        expect.objectContaining({ id: "feat" }),
        "gh-42",
      );
    });
  });

  describe("PR merged", () => {
    beforeEach(() => targetWithPr("merged"));

    it("redirects a reopen into a follow-up run target — merged work can't be un-shipped", async () => {
      const result = await reworkTicket(project, "feat", input());

      expect(result).toMatchObject({ mode: "follow-up", reworkedId: "anton-new", applied: true });
      expect(result.pipeline).toEqual({ outcome: "shipped", pr: "gh-42", redirected: true });
      expect(reopenMock).not.toHaveBeenCalled();
    });

    it("creates the follow-up PARENTLESS even under a board card — the merged target has no run left", async () => {
      await reworkTicket(project, "feat", input({ mode: "follow-up" as const }));
      const opts = createMock.mock.calls[0][1];
      expect(opts.deps).toBeUndefined();
      expect(opts.description).toContain("its own run target");
    });

    it("says on both beads why the fix moved rather than reopening shipped work", async () => {
      await reworkTicket(project, "feat", input());
      const noted = noteMock.mock.calls.map((c) => [c[1], c[2] as string] as const);
      expect(noted.find(([id]) => id === "anton-new")?.[1]).toContain("has already merged");
      expect(noted.find(([id]) => id === "t1")?.[1]).toContain("acceptance unmet");
    });

    it("leaves the merged target exactly as it shipped — ref, status and stage labels intact", async () => {
      await reworkTicket(project, "feat", input());
      expect(retirePrRefMock).not.toHaveBeenCalled();
      expect(untagMock).not.toHaveBeenCalled();
    });

    /** The board the instructed retry lands on: the 409'd attempt's follow-up, parented under the
     * target, and the PR merged in between. */
    function withFollowUpUnderTarget(...over: Partial<Bead>[]): void {
      board(
        makeBead({ id: "feat", issue_type: "feature", metadata: { pr: "gh-42" } }),
        ticketA(),
        makeBead({
          id: "already",
          title: "Harden the retry path",
          dependencies: [{ issue_id: "already", depends_on_id: "t1", type: "discovered-from" }],
          ...over[0],
        }),
      );
    }

    const followUp = () => input({ mode: "follow-up" as const, summary: "Harden the retry path" });

    it("detaches a follow-up an earlier attempt left under the target — a merged target runs nothing", async () => {
      withFollowUpUnderTarget({ parent: "feat" });
      showsWithNote(
        "already",
        followUpNote({ targetId: "feat", originId: "t1", summary: "Harden the retry path" }),
      );

      const result = await reworkTicket(project, "feat", followUp());

      // The bead already existed, so nothing is created — but its parentage is reconciled to the
      // parentless shape this request would have created, or nothing would ever dispatch it.
      expect(createMock).not.toHaveBeenCalled();
      expect(reparentMock).toHaveBeenCalledWith("/repo", "already", "");
      expect(result).toMatchObject({ applied: false, reworkedId: "already" });
      // ...which is what makes the founder's "carries the next pass as its own run target" true.
      expect(result.pipeline).toEqual({ outcome: "shipped", pr: "gh-42", redirected: false });
      const noted = noteMock.mock.calls.map((c) => [c[1], c[2] as string] as const);
      expect(noted.find(([id]) => id === "already")?.[1]).toContain("detached");
    });

    it("detaches on a REDIRECTED reopen too — the same stranded child, reached the other way", async () => {
      withFollowUpUnderTarget({ parent: "feat", title: "the API is still untested" });
      showsWithNote(
        "already",
        followUpNote({
          targetId: "feat",
          originId: "t1",
          summary: "the API is still untested",
          redirected: true,
        }),
      );

      await reworkTicket(project, "feat", input());
      expect(reparentMock).toHaveBeenCalledWith("/repo", "already", "");
    });

    it("never carries a redirected reopen on an ORDINARY follow-up of the same title", async () => {
      // The two say opposite things about whether the original's acceptance stood, so reusing one
      // for the other would tell the founder the redirect landed on a bead that says it was met.
      withFollowUpUnderTarget({ title: "the API is still untested" });
      showsWithNote(
        "already",
        followUpNote({ targetId: "feat", originId: "t1", summary: "the API is still untested" }),
      );

      const result = await reworkTicket(project, "feat", input());

      expect(result).toMatchObject({ mode: "follow-up", reworkedId: "anton-new", applied: true });
      expect(noteMock).toHaveBeenCalledWith(
        "/repo",
        "anton-new",
        expect.stringContaining("has already merged"),
        "founder",
      );
    });

    it("touches a follow-up that is already its own run target not at all", async () => {
      withFollowUpUnderTarget();
      showsWithNote(
        "already",
        followUpNote({ targetId: "feat", originId: "t1", summary: "Harden the retry path" }),
      );

      const result = await reworkTicket(project, "feat", followUp());

      expect(reparentMock).not.toHaveBeenCalled();
      expect(noteMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ applied: false, reworkedId: "already" });
    });
  });

  describe("the PR merges under the request", () => {
    /** Open when the mode was decided, merged by the time the retire is about to write. */
    function mergesMidFlight(): void {
      targetWithPr("open");
      prStateMock.mockReset();
      prStateMock.mockResolvedValueOnce("open").mockResolvedValue("merged");
    }

    it("retires nothing — clearing a merged PR's ref would un-gate its own finalization", async () => {
      mergesMidFlight();

      await expect(reworkTicket(project, "feat", input())).rejects.toBeInstanceOf(
        ReworkConflictError,
      );

      expect(retirePrRefMock).not.toHaveBeenCalled();
      // The target keeps `stage:in-review` too: it is what gate-check finalizes the merge through.
      expect(untagMock).not.toHaveBeenCalledWith("/repo", "feat", expect.anything());
    });

    it("writes NOTHING — the merge invalidates the mode itself, not just the retire", async () => {
      mergesMidFlight();

      await expect(reworkTicket(project, "feat", input())).rejects.toThrow(/send the ticket back/i);

      // The re-read gates the mode's writes too, so the ticket is left exactly as its run left it:
      // closed, still wearing its stage labels, with no instruction note steering a run that will
      // never happen. Landing the reopen and then refusing would strand it — nothing rolls a reopen
      // back, and the retry redirects the fix onto its own target.
      expect(noteMock).not.toHaveBeenCalled();
      expect(reopenMock).not.toHaveBeenCalled();
      expect(untagMock).not.toHaveBeenCalled();
      expect(createMock).not.toHaveBeenCalled();
    });

    it("503s instead, when `gh` goes unreadable between the two reads", async () => {
      // Unreadable is not merged: the remedy is fixing `gh`, not sending the ticket back — and
      // either way nothing may be written on a PR anton can no longer prove is live.
      targetWithPr("open");
      prStateMock.mockReset();
      prStateMock.mockResolvedValueOnce("open").mockResolvedValue("unknown");

      await expect(reworkTicket(project, "feat", input())).rejects.toBeInstanceOf(
        ReworkUnavailableError,
      );
      expect(noteMock).not.toHaveBeenCalled();
      expect(retirePrRefMock).not.toHaveBeenCalled();
    });

    it("re-reads the state rather than trusting the pre-lock one", async () => {
      mergesMidFlight();
      await expect(reworkTicket(project, "feat", input())).rejects.toBeInstanceOf(
        ReworkConflictError,
      );
      expect(prStateMock).toHaveBeenCalledTimes(2); // once to decide the mode, once before writing
    });

    /**
     * Still open at the mode decision AND at the retire's own check — merged only once the three
     * writes had landed. The window no lock can order: `gh` said open, then GitHub merged while
     * `untag`/`reopen`/`retirePrRef` were applying.
     */
    function mergesDuringTheWrites(settled: "merged" | "unknown" = "merged"): void {
      targetWithPr("open");
      showMock.mockImplementation(async (_cwd, id) =>
        id === "feat"
          ? makeBead({
              id,
              issue_type: "feature",
              status: "closed",
              labels: ["stage:in-review"],
              metadata: { pr: "gh-42" },
            })
          : // The reworked ticket as its run left it: closed, still wearing the run's stage label.
            makeBead({ id, status: "closed", labels: ["stage:in-review"] }),
      );
      prStateMock.mockReset();
      prStateMock
        .mockResolvedValueOnce("open")
        .mockResolvedValueOnce("open")
        .mockResolvedValue(settled);
    }

    it("rolls the retire back — a merged target keeps the ref and label it finalizes through", async () => {
      mergesDuringTheWrites();

      await expect(reworkTicket(project, "feat", input())).rejects.toBeInstanceOf(
        ReworkConflictError,
      );

      // The writes did land this time (the check before them saw an open PR)...
      expect(retirePrRefMock).toHaveBeenCalledWith(
        "/repo",
        expect.objectContaining({ id: "feat" }),
        "gh-42",
      );
      // ...and every one of them was put back: without this the merged PR has no ref and no
      // `stage:in-review`, so `finalizablePr` can never finalize it and the target re-runs shipped work.
      expect(setPrRefMock).toHaveBeenCalledWith("/repo", "feat", "gh-42");
      expect(tagMock).toHaveBeenCalledWith("/repo", "feat", ["stage:in-review"]);
      expect(closeMock).toHaveBeenCalledWith("/repo", "feat", expect.stringContaining("rolled back"));
    });

    it("restores the ref LAST — exposing it early strands a rollback nothing re-enters", async () => {
      // A retry never re-enters the retire once the ref is back: the PR reads as merged, which
      // resolves to `shipped`. So a close/tag that failed AFTER the ref would leave the target
      // live-ref in-review, open and stage-less forever. Failing BEFORE it leaves the retired shape,
      // which execute-epic parks on and the next send-back redirects.
      mergesDuringTheWrites();
      await expect(reworkTicket(project, "feat", input())).rejects.toBeInstanceOf(
        ReworkConflictError,
      );
      const refAt = setPrRefMock.mock.invocationCallOrder[0];
      expect(refAt).toBeGreaterThan(closeMock.mock.invocationCallOrder[0]);
      expect(refAt).toBeGreaterThan(tagMock.mock.invocationCallOrder[0]);
    });

    it("leaves the ref retired when the status restore fails, rather than half-rolling-back", async () => {
      // The invariant the order buys, stated as behaviour: if the rollback can't put the target's
      // own state back, it must not publish the live ref over a target that never got it back.
      mergesDuringTheWrites();
      closeMock.mockRejectedValueOnce(new Error("bd close failed"));

      await expect(reworkTicket(project, "feat", input())).rejects.toThrow(/bd close failed/);

      expect(setPrRefMock).not.toHaveBeenCalled();
      expect(retirePrRefMock).toHaveBeenCalled();
    });

    it("only re-tags the stage labels the target actually carried", async () => {
      mergesDuringTheWrites();
      await expect(reworkTicket(project, "feat", input())).rejects.toBeInstanceOf(
        ReworkConflictError,
      );
      // `stage:implementing` was never on the bead; putting it back would invent a state.
      expect(tagMock).toHaveBeenCalledWith("/repo", "feat", ["stage:in-review"]);
    });

    it("rolls the reopened CHILD back too — the target's rollback never reaches it", async () => {
      // On a grouped target the mode reopened a bead of its own. Left reopened and stage-stripped
      // under a merged target, nothing dispatches it — and the retry this 409 instructs opens a
      // standalone follow-up, so nothing repairs it either.
      mergesDuringTheWrites();

      await expect(reworkTicket(project, "feat", input())).rejects.toBeInstanceOf(
        ReworkConflictError,
      );

      // The reopen did land (the check before the writes saw an open PR)...
      expect(reopenMock).toHaveBeenCalledWith("/repo", "t1", "rework: the API is still untested");
      expect(untagMock).toHaveBeenCalledWith("/repo", "t1", ["stage:implementing", "stage:in-review"]);
      // ...and both of its writes were put back, on the ticket, not just on the target.
      expect(closeMock).toHaveBeenCalledWith("/repo", "t1", expect.stringContaining("rolled back"));
      expect(tagMock).toHaveBeenCalledWith("/repo", "t1", ["stage:in-review"]);
    });

    it("records the rollback under the instructions it left on that child", async () => {
      // bd notes are append-only, so the founder's words stay. A closed ticket wearing a send-back
      // that apparently did nothing is what the record underneath them explains.
      mergesDuringTheWrites();
      await expect(reworkTicket(project, "feat", input())).rejects.toBeInstanceOf(
        ReworkConflictError,
      );
      const noted = noteMock.mock.calls.filter((c) => c[1] === "t1").map((c) => c[2] as string);
      expect(noted[0]).toContain(INSTRUCTIONS); // the human note the reopen wrote
      expect(noted[1]).toContain("rolled back");
    });

    it("reports the ticket that went back with the target, so the founder knows what to look at", async () => {
      mergesDuringTheWrites();
      await expect(reworkTicket(project, "feat", input())).rejects.toThrow(/feat and t1/);
    });

    it("503s rather than 409s when `gh` goes unreadable across the writes", async () => {
      // Unreadable is not merged. The writes still come off — nothing may stand on a read anton
      // can't make — but "if it merged, the fix runs as its own target" would be advice about a
      // race that may never have happened, and the actual remedy is `gh`.
      mergesDuringTheWrites("unknown");

      await expect(reworkTicket(project, "feat", input())).rejects.toBeInstanceOf(
        ReworkUnavailableError,
      );

      // Rolled back exactly as a confirmed merge is: an unverified retire is not one to stand behind.
      expect(setPrRefMock).toHaveBeenCalledWith("/repo", "feat", "gh-42");
      expect(tagMock).toHaveBeenCalledWith("/repo", "feat", ["stage:in-review"]);
      expect(closeMock).toHaveBeenCalledWith("/repo", "t1", expect.stringContaining("rolled back"));
    });

    it("names `gh`, not a merge, in the 503 it raises", async () => {
      mergesDuringTheWrites("unknown");
      await expect(reworkTicket(project, "feat", input())).rejects.toThrow(/gh[\s\S]*authenticated/);
      const noted = noteMock.mock.calls.filter((c) => c[1] === "feat").map((c) => c[2] as string);
      expect(noted.join("\n")).toContain("could no longer be read");
      // ...and never the merged wording, which would send the founder after the wrong fix.
      expect(noted.some((n) => n.includes("reads as merged"))).toBe(false);
    });

    it("records on the target that the half-applied retire was undone", async () => {
      mergesDuringTheWrites();
      await expect(reworkTicket(project, "feat", input())).rejects.toBeInstanceOf(
        ReworkConflictError,
      );
      const noted = noteMock.mock.calls.map((c) => [c[1], c[2] as string] as const);
      expect(noted.find(([id]) => id === "feat")?.[1]).toContain("rolled back");
      // ...and no line claiming the marker was cleared, which is what the founder would act on.
      expect(noted.some(([id, text]) => id === "feat" && text.includes("was cleared"))).toBe(false);
    });

    /**
     * The same mid-write merge on a STANDALONE target, where the ticket IS the target: the reopen
     * moves the very bead the retire's rollback has to put back. The fake board reflects that — once
     * the mode has written, `show` reports the reopened, untagged bead.
     */
    function standaloneMergesDuringTheWrites(): void {
      const solo = (over: Partial<Bead>): Bead =>
        makeBead({
          id: "solo",
          title: "Standalone",
          issue_type: "task",
          status: "closed",
          labels: ["approved", "stage:in-review"],
          metadata: { pr: "gh-42" },
          ...over,
        });
      board(solo({}));
      let reopened = false;
      reopenMock.mockImplementation(async () => {
        reopened = true;
      });
      showMock.mockImplementation(async () =>
        reopened ? solo({ status: "open", labels: ["approved"] }) : solo({}),
      );
      prStateMock.mockReset();
      prStateMock
        .mockResolvedValueOnce("open")
        .mockResolvedValueOnce("open")
        .mockResolvedValue("merged");
    }

    it("rolls a standalone target back to what its RUN left, not to what this send-back made of it", async () => {
      standaloneMergesDuringTheWrites();

      await expect(
        reworkTicket(project, "solo", input({ ticketId: "solo" })),
      ).rejects.toBeInstanceOf(ReworkConflictError);

      expect(retirePrRefMock).toHaveBeenCalledWith(
        "/repo",
        expect.objectContaining({ id: "solo" }),
        "gh-42",
      );
      expect(setPrRefMock).toHaveBeenCalledWith("/repo", "solo", "gh-42");
      // The status and the label the mode's own reopen took off go back too. Restoring the
      // post-reopen state instead would leave the merged original open and untagged — invisible to
      // `finalizablePr`, and the instructed retry only opens a follow-up, so nothing repairs it.
      expect(closeMock).toHaveBeenCalledWith(
        "/repo",
        "solo",
        expect.stringContaining("rolled back"),
      );
      expect(tagMock).toHaveBeenCalledWith("/repo", "solo", ["stage:in-review"]);
    });
  });

  describe("a PR an EARLIER send-back already retired", () => {
    /**
     * The board a retire leaves behind: no live ref, and the PR it came off named on the bead. What
     * happens next depends on that PR, which can merge in the window before the rerun re-stamps it.
     */
    function retiredPr(state: "open" | "merged" | "unknown"): void {
      const target = () =>
        makeBead({ id: "feat", issue_type: "feature", metadata: { retiredPr: "gh-42" } });
      board(target(), ticketA(), ticketB());
      showMock.mockImplementation(async (_cwd, id) =>
        id === "feat" ? target() : makeBead({ id, status: "closed" }),
      );
      prStateMock.mockResolvedValue(state);
    }

    it("redirects a second send-back once that PR has MERGED", async () => {
      // Without the retired pointer this reads as a bead with no PR at all: an ordinary reopen,
      // promising a run on a base branch that already carries the work.
      retiredPr("merged");

      const result = await reworkTicket(project, "feat", input());

      expect(result.pipeline).toEqual({ outcome: "shipped", pr: "gh-42", redirected: true });
      expect(result).toMatchObject({ mode: "follow-up", reworkedId: "anton-new" });
      expect(createMock.mock.calls[0][1].deps).toBeUndefined(); // its own run target
      expect(reopenMock).not.toHaveBeenCalled();
    });

    it("has nothing to retire while it is still open — the marker is already off the bead", async () => {
      retiredPr("open");

      const result = await reworkTicket(project, "feat", input());

      expect(result).toMatchObject({ mode: "reopen", reworkedId: "t1", applied: true });
      expect(result.pipeline).toBeUndefined();
      expect(retirePrRefMock).not.toHaveBeenCalled();
      expect(untagMock).not.toHaveBeenCalledWith("/repo", "feat", expect.anything());
    });

    it("refuses rather than guesses when that PR can't be read", async () => {
      retiredPr("unknown");
      await expect(reworkTicket(project, "feat", input())).rejects.toBeInstanceOf(
        ReworkUnavailableError,
      );
      expect(noteMock).not.toHaveBeenCalled();
    });
  });

  it("never asks gh when the follow-up is its own run target either way", async () => {
    // A standalone task's follow-up comes out parentless whatever its PR did, so an unreachable
    // `gh` must not 503 a send-back whose answer it cannot change.
    board(
      makeBead({
        id: "solo",
        title: "Standalone",
        issue_type: "task",
        labels: ["approved", "stage:in-review"],
        metadata: { pr: "gh-42" },
      }),
    );
    prStateMock.mockRejectedValue(new Error("gh is not installed"));

    const result = await reworkTicket(
      project,
      "solo",
      input({ ticketId: "solo", mode: "follow-up" as const, summary: "Harden the retry path" }),
    );

    expect(prStateMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mode: "follow-up", applied: true });
    expect(result.pipeline).toBeUndefined();
    expect(createMock.mock.calls[0][1].deps).toBeUndefined();
  });

  it("still asks gh for a REOPEN on that same standalone target — its PR decides the mode", async () => {
    board(
      makeBead({
        id: "solo",
        title: "Standalone",
        issue_type: "task",
        labels: ["approved", "stage:in-review"],
        metadata: { pr: "gh-42" },
      }),
    );
    prStateMock.mockResolvedValue("unknown");

    await expect(
      reworkTicket(project, "solo", input({ ticketId: "solo" })),
    ).rejects.toBeInstanceOf(ReworkUnavailableError);
  });

  it("leaves a CLOSED-unmerged ref alone — that ref is what a recovery run follows back", async () => {
    targetWithPr("closed");
    const result = await reworkTicket(project, "feat", input());
    expect(result.pipeline).toBeUndefined();
    expect(retirePrRefMock).not.toHaveBeenCalled();
    expect(result.mode).toBe("reopen");
  });

  it("refuses rather than guesses when the PR state can't be read, writing nothing", async () => {
    targetWithPr("unknown");
    await expect(reworkTicket(project, "feat", input())).rejects.toBeInstanceOf(
      ReworkUnavailableError,
    );
    expect(noteMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });
});
