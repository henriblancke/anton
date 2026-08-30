/**
 * Unit tests for the two things a send-back can DO (anton-hlkd): reopen the ticket that lied about
 * being done, or open a follow-up beside the one that shipped — plus, for the follow-up, the four
 * shapes the board can leave it in (created under the target, created standing alone, already there,
 * or there but half-made).
 *
 * Driven directly rather than through `reworkTicket`, because what is worth pinning here is which
 * write each input selects and in what ORDER — the module's recovery story — and the seams those
 * turn on: the re-read under the lock, the board snapshot the dedupe scans, and the target's PR. An
 * end-to-end fixture picks those for you; these don't.
 *
 * bd is faked. That the writes actually land on a board is the integration suite's job:
 * src/app/api/projects/[slug]/epics/[epicId]/rework/route.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "./beads/bd";
import { formatHumanNote } from "./beads/notes";
import type { ReviewFinding } from "./jobs/review-context";
import type { ReworkRequest } from "./rework-contract";
import type { Project, ReworkMode, ReworkPipeline } from "./types";

const showMock = vi.fn<(cwd: string, id: string) => Promise<Bead>>();
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
const reparentMock = vi.fn();
const refreshMock = vi.fn<() => Promise<Bead[]>>();
const operatorMock = vi.fn<() => Promise<string | undefined>>();

vi.mock("./beads/bd", async () => {
  const actual = await vi.importActual<typeof import("./beads/bd")>("./beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      show: (...args: [string, string]) => showMock(...args),
      note: (...args: unknown[]) => noteMock(...args),
      reopen: (...args: unknown[]) => reopenMock(...args),
      untag: (...args: unknown[]) => untagMock(...args),
      create: (...args: unknown[]) => createMock(...(args as [string, CreateOpts])),
      link: (...args: unknown[]) => linkMock(...args),
      reparent: (...args: unknown[]) => reparentMock(...args),
    },
  };
});

vi.mock("./beads/issues", () => ({ refreshAllIssues: () => refreshMock() }));

vi.mock("./operator", () => ({ resolveOperator: () => operatorMock() }));

const { applyFollowUp, applyReopen, existingFollowUp, inheritedLabels } = await import(
  "./rework-modes"
);
const { hasHumanNote, reworkNoteBody } = await import("./rework-notes");
const { RUN_STAGE_LABELS } = await import("./rework-pipeline");

const project: Project = { id: "p1", slug: "p", name: "p", repoPath: "/repo" } as Project;

function makeBead(over: Partial<Bead> & { id: string }): Bead {
  return { title: over.id, status: "open", issue_type: "task", labels: [], ...over };
}

/** The ordinary grouped run: a feature run target with the ticket that just failed its review. */
const feature = (over: Partial<Bead> = {}) =>
  makeBead({ id: "feat", issue_type: "feature", ...over });
const ticket = (over: Partial<Bead> = {}) =>
  makeBead({ id: "t1", title: "Ticket one", parent: "feat", ...over });
/** That ticket as the finished run left it: closed, still wearing the stage it ended in. */
const finishedTicket = (over: Partial<Bead> = {}) =>
  ticket({ status: "closed", labels: ["agent:nextjs", "size:M", "approved", "stage:in-review"], ...over });
/** A standalone task: its own run target, and so NOT a board card — nothing can be parented under it. */
const solo = (over: Partial<Bead> = {}) => makeBead({ id: "solo", title: "Ship the thing", ...over });

const SUMMARY = "Harden the retry path";
const INSTRUCTIONS = "Add a test that fails without the null guard.";
const FINDINGS: ReviewFinding[] = [
  { severity: "blocking", location: "src/lib/retry.ts:12", note: "the null guard is untested" },
];

const request = (over: Partial<ReworkRequest> = {}): ReworkRequest => ({
  ticketId: "t1",
  mode: "reopen" as ReworkMode,
  summary: SUMMARY,
  instructions: INSTRUCTIONS,
  findings: [],
  ...over,
});

type NoteArgs = Parameters<typeof reworkNoteBody>[0];

/** The note a reopen of `t1` under `feat` lands — also the blob its dedupe matches on. */
const reopenBody = (over: Partial<NoteArgs> = {}) =>
  reworkNoteBody({
    mode: "reopen",
    targetId: "feat",
    summary: SUMMARY,
    instructions: INSTRUCTIONS,
    findings: [],
    ...over,
  });

/** The note a follow-up of `t1` lands. `redirected` is the one flag that changes what it claims. */
const followUpBody = (over: Partial<NoteArgs> = {}) =>
  reworkNoteBody({
    mode: "follow-up",
    targetId: "feat",
    originId: "t1",
    summary: SUMMARY,
    instructions: INSTRUCTIONS,
    findings: [],
    redirected: false,
    ...over,
  });

/** A merged PR on the target — the one pipeline state that forces a follow-up to stand alone. */
const SHIPPED: ReworkPipeline = { outcome: "shipped", pr: "gh-42", redirected: false };

function board(...onBoard: Bead[]): void {
  refreshMock.mockResolvedValue(onBoard);
}

/**
 * Serve `id` from `bd show` carrying this note — `bd list` doesn't carry notes, so every dedupe
 * re-reads the bead. The re-read otherwise mirrors the snapshot, because that is what bd returns;
 * `over` is how a case makes it DISAGREE (a concurrent move landing between the two reads).
 */
function showsWithNote(id: string, body: string, over: Partial<Bead> = {}): void {
  const base = showMock.getMockImplementation()!;
  showMock.mockImplementation(async (cwd, beadId) =>
    beadId === id
      ? makeBead({
          ...(await base(cwd, beadId)),
          id,
          notes: formatHumanNote(body, "founder", new Date()),
          ...over,
        })
      : base(cwd, beadId),
  );
}

/** A follow-up candidate: unsettled, titled like the request, linked `discovered-from` the ticket. */
function candidate(id: string, over: Partial<Bead> = {}): Bead {
  return makeBead({
    id,
    title: SUMMARY,
    parent: "feat",
    dependencies: [{ issue_id: id, depends_on_id: "t1", type: "discovered-from" }],
    ...over,
  });
}

/** Every bd write these modes can make — asserted absent wherever a request must write nothing. */
const allWrites = [noteMock, reopenMock, untagMock, createMock, linkMock, reparentMock];

/** The bead a bd call was made on, and when it happened — the seam for asserting write order. */
function orderOn(mock: ReturnType<typeof vi.fn>, id: string, nth = 0): number {
  const matches = mock.mock.calls
    .map((call, i) => ({ call, i }))
    .filter(({ call }) => call[1] === id);
  expect(matches.length, `expected ${nth + 1} call(s) on ${id}`).toBeGreaterThan(nth);
  return mock.mock.invocationCallOrder[matches[nth]!.i]!;
}

/** The text of the nth note written to `id`. */
function noteOn(id: string, nth = 0): string {
  const texts = noteMock.mock.calls.filter((c) => c[1] === id).map((c) => c[2] as string);
  expect(texts.length, `expected ${nth + 1} note(s) on ${id}`).toBeGreaterThan(nth);
  return texts[nth]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  operatorMock.mockResolvedValue("founder");
  createMock.mockResolvedValue("anton-new");
  board(feature(), finishedTicket());
  // The re-read agrees with the snapshot unless a case says otherwise — that is what bd returns —
  // and a candidate a case passes in without boarding it reads as the plain open bead it is.
  showMock.mockImplementation(
    async (_cwd, id) => (await refreshMock()).find((b) => b.id === id) ?? makeBead({ id }),
  );
});

describe("applyReopen", () => {
  it("writes the instructions, then the status, then strips the finished run's stage labels", async () => {
    const applied = await applyReopen(project, feature(), finishedTicket(), request());

    expect(applied).toEqual({
      result: {
        mode: "reopen",
        ticketId: "t1",
        reworkedId: "t1",
        note: reopenBody(),
        applied: true,
      },
      // A reopen always lands on a bead of the target's own run, so the retire can act on it.
      runsUnderTarget: true,
    });
    expect(reopenMock).toHaveBeenCalledWith("/repo", "t1", `rework: ${SUMMARY}`);
    expect(untagMock).toHaveBeenCalledWith("/repo", "t1", RUN_STAGE_LABELS);
    // Instructions first: a note on a bead that failed to reopen is recoverable, a reopened bead
    // with no instructions re-dispatches the SAME spec that just failed review.
    expect(orderOn(noteMock, "t1")).toBeLessThan(orderOn(reopenMock, "t1"));
    expect(orderOn(reopenMock, "t1")).toBeLessThan(orderOn(untagMock, "t1"));
  });

  it("lands the note as a HUMAN note the dedupe reads back — attributed to the operator", async () => {
    const applied = await applyReopen(project, feature(), finishedTicket(), request());

    expect(noteMock.mock.calls[0]![3]).toBe("founder");
    expect(hasHumanNote(makeBead({ id: "t1", notes: noteOn("t1") }), applied.result.note)).toBe(true);
  });

  it("still writes when the operator's identity can't be resolved — a rework takes nothing", async () => {
    operatorMock.mockResolvedValue(undefined);

    await applyReopen(project, feature(), finishedTicket(), request());

    // Nothing to attribute it to, so bd is given no author and the note wears the generic one.
    expect(noteMock.mock.calls[0]![3]).toBeUndefined();
    expect(noteOn("t1")).toMatch(/^\[human-note operator /);
  });

  it("leaves a bead the run never closed open — `bd reopen` has nothing to do there", async () => {
    // Parked before the close, or reworked mid-flight: the reason lives in the note either way.
    board(feature(), ticket({ status: "open", labels: ["stage:implementing"] }));

    await expect(
      applyReopen(project, feature(), finishedTicket(), request()),
    ).resolves.toMatchObject({ result: { applied: true } });
    expect(reopenMock).not.toHaveBeenCalled();
    expect(noteMock).toHaveBeenCalledOnce();
    expect(untagMock).toHaveBeenCalledOnce();
  });

  it("is a no-op only when the note AND the state it produces are already on the bead", async () => {
    showsWithNote("t1", reopenBody(), { status: "open", labels: ["approved"] });

    await expect(applyReopen(project, feature(), finishedTicket(), request())).resolves.toEqual({
      result: {
        mode: "reopen",
        ticketId: "t1",
        reworkedId: "t1",
        note: reopenBody(),
        applied: false,
      },
      runsUnderTarget: true,
    });
    for (const write of allWrites) expect(write).not.toHaveBeenCalled();
  });

  it("re-applies its own note on a bead a LATER run re-closed — text alone would leave it closed", async () => {
    showsWithNote("t1", reopenBody(), { status: "closed", labels: [] });

    await expect(
      applyReopen(project, feature(), finishedTicket(), request()),
    ).resolves.toMatchObject({ result: { applied: true } });
    expect(reopenMock).toHaveBeenCalledWith("/repo", "t1", `rework: ${SUMMARY}`);
  });

  it("re-applies it on a bead still wearing a stage label — that untag hasn't run yet", async () => {
    showsWithNote("t1", reopenBody(), { status: "open", labels: ["stage:in-review"] });

    await expect(
      applyReopen(project, feature(), finishedTicket(), request()),
    ).resolves.toMatchObject({ result: { applied: true } });
    expect(untagMock).toHaveBeenCalledWith("/repo", "t1", RUN_STAGE_LABELS);
    expect(reopenMock).not.toHaveBeenCalled();
  });

  it("dedupes on a DIFFERENT request's note as a new send-back, not a duplicate", async () => {
    // Same ticket, same target, other instructions: a founder may send one bead back twice.
    showsWithNote("t1", reopenBody({ instructions: "Something else entirely" }), { status: "open" });

    await expect(
      applyReopen(project, feature(), finishedTicket(), request()),
    ).resolves.toMatchObject({ result: { applied: true } });
  });
});

describe("applyFollowUp", () => {
  const followUp = (over: Partial<ReworkRequest> = {}) => request({ mode: "follow-up", ...over });

  it("creates the bead, the edge, the instructions, then the origin's pointer — in that order", async () => {
    const applied = await applyFollowUp(project, feature(), finishedTicket(), followUp());

    expect(applied).toEqual({
      result: {
        mode: "follow-up",
        ticketId: "t1",
        reworkedId: "anton-new",
        note: followUpBody(),
        applied: true,
      },
      // Under a board card the new bead is a ticket of the target's NEXT run, so the retire counts.
      runsUnderTarget: true,
    });
    expect(createMock).toHaveBeenCalledWith("/repo", {
      title: SUMMARY,
      type: "task",
      description: expect.stringContaining("## Goal"),
      labels: ["agent:nextjs", "size:M"],
      deps: ["parent-child:feat"],
    });
    expect(linkMock).toHaveBeenCalledWith("/repo", "anton-new", "t1", "discovered-from");
    // The edge before the instructions: a failure between them leaves an unlinked bead the founder
    // can see, not an instruction on a bead nothing points at.
    expect(createMock.mock.invocationCallOrder[0]!).toBeLessThan(orderOn(linkMock, "anton-new"));
    expect(orderOn(linkMock, "anton-new")).toBeLessThan(orderOn(noteMock, "anton-new"));
    expect(orderOn(noteMock, "anton-new")).toBeLessThan(orderOn(noteMock, "t1"));
  });

  it("points the ORIGINAL at what its review produced, exactly once, and leaves it otherwise as it shipped", async () => {
    await applyFollowUp(project, feature(), finishedTicket(), followUp());

    expect(noteMock.mock.calls.filter((c) => c[1] === "t1")).toHaveLength(1);
    expect(noteOn("t1")).toContain("Follow-up anton-new was opened from this ticket's review");
    expect(reopenMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  it("stands a follow-up of a STANDALONE target alone — a child of one is a ticket of no run", async () => {
    board(solo());

    const applied = await applyFollowUp(project, solo(), solo(), followUp());

    expect(applied.runsUnderTarget).toBe(false);
    expect(createMock.mock.calls[0]![1].deps).toBeUndefined();
    expect(createMock.mock.calls[0]![1].description).toContain("It is its own run target");
  });

  it("stands it alone under a SHIPPED target too — its run has nothing left to dispatch", async () => {
    const applied = await applyFollowUp(
      project,
      feature(),
      finishedTicket(),
      followUp(),
      SHIPPED,
    );

    expect(applied.runsUnderTarget).toBe(false);
    expect(createMock.mock.calls[0]![1].deps).toBeUndefined();
  });

  it("says on the bead and on the origin when a merged PR REDIRECTED a reopen into it", async () => {
    const applied = await applyFollowUp(project, feature(), finishedTicket(), followUp(), {
      ...SHIPPED,
      redirected: true,
    });

    // The redirected head says the opposite of an ordinary follow-up's: the acceptance was NOT met.
    expect(applied.result.note).toBe(followUpBody({ redirected: true }));
    expect(createMock.mock.calls[0]![1].description).toContain("had already merged");
    expect(noteOn("t1")).toContain("rather than reopening work that has shipped");
  });

  it("reports an identical follow-up as already sent back, and writes nothing at all", async () => {
    board(feature(), finishedTicket(), candidate("dup"));
    showsWithNote("dup", followUpBody());

    await expect(applyFollowUp(project, feature(), finishedTicket(), followUp())).resolves.toEqual({
      result: {
        mode: "follow-up",
        ticketId: "t1",
        reworkedId: "dup",
        note: followUpBody(),
        applied: false,
      },
      runsUnderTarget: true,
      reconciled: false,
    });
    for (const write of allWrites) expect(write).not.toHaveBeenCalled();
  });

  it("finishes a half-created follow-up rather than opening a second one beside it", async () => {
    // `bd create` and `bd link` landed, the note after them didn't — the bead speaks for no request.
    board(feature(), finishedTicket(), candidate("half"));

    await expect(
      applyFollowUp(project, feature(), finishedTicket(), followUp()),
    ).resolves.toMatchObject({
      // It DID write: the instructions were nowhere on the board a moment ago.
      result: { reworkedId: "half", applied: true },
      runsUnderTarget: true,
    });
    expect(createMock).not.toHaveBeenCalled();
    expect(linkMock).not.toHaveBeenCalled();
    expect(hasHumanNote(makeBead({ id: "half", notes: noteOn("half") }), followUpBody())).toBe(true);
    expect(noteOn("t1")).toContain("Follow-up half was opened from this ticket's review");
  });

  it("detaches a follow-up stranded under a target whose PR merged under it, and reports the write", async () => {
    board(feature(), finishedTicket(), candidate("dup"));
    showsWithNote("dup", followUpBody());

    const applied = await applyFollowUp(project, feature(), finishedTicket(), followUp(), SHIPPED);

    expect(applied).toMatchObject({
      result: { reworkedId: "dup", applied: false },
      // Parentless now, so the target's own run carries nothing and must not retire its PR gate.
      runsUnderTarget: false,
      reconciled: true,
    });
    expect(reparentMock).toHaveBeenCalledWith("/repo", "dup", "");
    expect(noteOn("dup")).toContain("gh-42");
    expect(noteOn("dup")).toContain("its own run target now");
  });

  it("leaves an already-parentless match alone when the target has shipped — nothing to reconcile", async () => {
    board(feature(), finishedTicket(), candidate("dup", { parent: undefined }));
    showsWithNote("dup", followUpBody());

    await expect(
      applyFollowUp(project, feature(), finishedTicket(), followUp(), SHIPPED),
    ).resolves.toMatchObject({ runsUnderTarget: false, reconciled: false });
    expect(reparentMock).not.toHaveBeenCalled();
  });

  it("reads the match's parentage off the RE-READ, not the snapshot a rival may have moved", async () => {
    board(feature(), finishedTicket(), candidate("dup"));
    // The gardener reparented it between the two reads; the snapshot still says "under the target".
    showsWithNote("dup", followUpBody(), { parent: undefined });

    await expect(
      applyFollowUp(project, feature(), finishedTicket(), followUp()),
    ).resolves.toMatchObject({ runsUnderTarget: false });
  });

  it("never reads the request's own mode — an unknown one selects no third path here", async () => {
    // Which of the two modes is right is decided upstream (`knownMode`, rework-contract.ts); each
    // entry point applies its own, so a bad mode field cannot steer this module anywhere.
    const bogus = request({ mode: "delete" as never });

    await expect(applyReopen(project, feature(), finishedTicket(), bogus)).resolves.toMatchObject({
      result: { mode: "reopen", note: reopenBody() },
    });
    await expect(applyFollowUp(project, feature(), finishedTicket(), bogus)).resolves.toMatchObject({
      result: { mode: "follow-up", note: followUpBody() },
    });
  });

  it("carries the reviewer's own findings into whichever note the mode lands", async () => {
    const withFindings = request({ findings: FINDINGS });

    const reopened = await applyReopen(project, feature(), finishedTicket(), withFindings);
    expect(reopened.result.note).toContain(
      "- [blocking] src/lib/retry.ts:12 — the null guard is untested",
    );

    const followed = await applyFollowUp(project, feature(), finishedTicket(), {
      ...withFindings,
      mode: "follow-up",
    });
    expect(followed.result.note).toBe(followUpBody({ findings: FINDINGS }));
  });
});

describe("existingFollowUp", () => {
  it("finds nothing on a board that carries no candidate — the create path is what runs", async () => {
    await expect(
      existingFollowUp("/repo", [feature(), finishedTicket()], "t1", SUMMARY, followUpBody()),
    ).resolves.toBeUndefined();
    expect(showMock).not.toHaveBeenCalled();
  });

  it("prefers the bead carrying THIS request's note over an unfinished one", async () => {
    // The half-made bead comes first: an exact match anywhere wins, so a founder's SECOND send-back
    // is never mistaken for the unfinished remains of their first.
    showsWithNote("done", followUpBody());

    await expect(
      existingFollowUp("/repo", [candidate("half"), candidate("done")], "t1", SUMMARY, followUpBody()),
    ).resolves.toEqual({ bead: expect.objectContaining({ id: "done" }), partial: false });
  });

  it("adopts a bead with NO human note at all as this request's half-done work", async () => {
    await expect(
      existingFollowUp("/repo", [candidate("half")], "t1", SUMMARY, followUpBody()),
    ).resolves.toMatchObject({ partial: true, bead: { id: "half" } });
  });

  it("rejects a bead carrying a DIFFERENT request's note — reusing it would report a note nowhere on it", async () => {
    showsWithNote("other", followUpBody({ instructions: "Something else entirely" }));

    await expect(
      existingFollowUp("/repo", [candidate("other")], "t1", SUMMARY, followUpBody()),
    ).resolves.toBeUndefined();
  });

  it("skips a candidate closed between the snapshot and the re-read", async () => {
    // The lock covers the ticket and the target, not the follow-up. A closed bead is nobody's
    // follow-up — matching it would report the send-back as done and drop it.
    showsWithNote("shut", followUpBody(), { status: "closed" });

    await expect(
      existingFollowUp("/repo", [candidate("shut")], "t1", SUMMARY, followUpBody()),
    ).resolves.toBeUndefined();
  });

  it("ignores a bead that is closed, differently titled, or not linked — without a single `bd show`", async () => {
    const all: Bead[] = [
      candidate("closed", { status: "closed" }),
      candidate("retitled", { title: "Something else" }),
      makeBead({ id: "unlinked", title: SUMMARY }),
    ];

    await expect(existingFollowUp("/repo", all, "t1", SUMMARY, followUpBody())).resolves.toBeUndefined();
    expect(showMock).not.toHaveBeenCalled();
  });

  it("ignores an edge ANOTHER bead owns — a hydrated read carries those too", async () => {
    // A sibling follow-up's own `discovered-from t1`, riding along on this bead's dependency list.
    // Without the `issue_id` check it would make any same-titled bead look like this ticket's.
    const borrowed = candidate("borrowed", {
      dependencies: [{ issue_id: "sibling", depends_on_id: "t1", type: "discovered-from" }],
    });

    await expect(
      existingFollowUp("/repo", [borrowed], "t1", SUMMARY, followUpBody()),
    ).resolves.toBeUndefined();
    expect(showMock).not.toHaveBeenCalled();
  });

  it("matches the title the way a founder retypes it — trimmed and case-insensitive", async () => {
    showsWithNote("done", followUpBody());

    await expect(
      existingFollowUp("/repo", [candidate("done", { title: `  ${SUMMARY.toUpperCase()} ` })], "t1", SUMMARY, followUpBody()),
    ).resolves.toMatchObject({ bead: { id: "done" }, partial: false });
  });
});

describe("inheritedLabels", () => {
  it("carries routing and shaping over, and nothing that describes a run", () => {
    const shaped = makeBead({
      id: "t1",
      labels: [
        "agent:nextjs",
        "domain:eng",
        "risk:low",
        "size:M",
        "area:codehealth",
        "approved",
        "stage:in-review",
        "run-lease:123",
        "review-score:4",
        "abandoned",
      ],
    });

    expect(inheritedLabels(shaped)).toEqual([
      "agent:nextjs",
      "domain:eng",
      "risk:low",
      "size:M",
      "area:codehealth",
    ]);
  });

  it("inherits nothing from a bead wearing nothing", () => {
    expect(inheritedLabels(makeBead({ id: "t1", labels: undefined }))).toEqual([]);
  });
});
