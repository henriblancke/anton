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
const runIsLiveMock = vi.fn<(projectId: string, targetId: string) => boolean>();

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
    },
  };
});

vi.mock("./jobs/service", () => ({
  runIsLiveForTarget: (...args: [string, string]) => runIsLiveMock(...args),
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

const input = (over: Partial<Parameters<typeof reworkTicket>[2]> = {}) => ({
  ticketId: "t1",
  mode: "reopen" as const,
  summary: "the API is still untested",
  instructions: "Add a test that fails without the null guard.",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  runIsLiveMock.mockReturnValue(false);
  createMock.mockResolvedValue("anton-new");
  showMock.mockImplementation(async (_cwd, id) => makeBead({ id, status: "closed" }));
  board(feature(), ticketA(), ticketB());
});

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
    for (const section of ["## Goal", "## Acceptance", "## Context", "## Out of scope", "## Verify"]) {
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
    const result = await reworkTicket(project, "feat", followUp());
    expect(result).toMatchObject({ applied: false, reworkedId: "already" });
    expect(createMock).not.toHaveBeenCalled();
    expect(noteMock).not.toHaveBeenCalled();
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
});

describe("pipeline warning", () => {
  it("says so when an open PR will make the target's next run short-circuit", async () => {
    board(
      makeBead({ id: "feat", issue_type: "feature", metadata: { pr: "gh-42" } }),
      ticketA(),
    );
    const result = await reworkTicket(project, "feat", input());
    expect(result.warning).toContain("gh-42");
  });

  it("stays silent when nothing stands between the bead and the next run", async () => {
    const result = await reworkTicket(project, "feat", input());
    expect(result.warning).toBeUndefined();
  });
});
