/**
 * Unit tests for the send-back's pipeline (anton-bd00): what the target's own pull request allows
 * (anton-leit), the retire that acts on that answer, and the rollback for a verify it can no longer
 * stand behind.
 *
 * Driven directly rather than through `reworkTicket`, because the thing worth pinning here is the
 * ORDER of the writes — which is the module's recovery story, not a style choice — and the seam it
 * turns on: one unstable fact (`gh`'s answer for one PR) read three times, before the writes, under
 * the lock, and again after them. An end-to-end fixture picks those reads for you; these don't.
 *
 * bd and `gh` are faked. That the writes actually land on a board is the integration suite's job:
 * src/app/api/projects/[slug]/epics/[epicId]/rework/route.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "./beads/bd";
import type { Project } from "./types";

const showMock = vi.fn<(cwd: string, id: string) => Promise<Bead>>();
const noteMock = vi.fn();
const reopenMock = vi.fn();
const untagMock = vi.fn();
const tagMock = vi.fn();
const closeMock = vi.fn();
const retirePrRefMock = vi.fn();
const setPrRefMock = vi.fn();
const prStateMock = vi.fn<(repo: string, ref: string) => Promise<string>>();

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
      tag: (...args: unknown[]) => tagMock(...args),
      close: (...args: unknown[]) => closeMock(...args),
      retirePrRef: (...args: unknown[]) => retirePrRefMock(...args),
      setPrRef: (...args: unknown[]) => setPrRefMock(...args),
    },
  };
});

vi.mock("./git/ops", () => ({
  pullRequestState: (...args: [string, string]) => prStateMock(...args),
}));

const {
  RUN_STAGE_LABELS,
  assertRetireStood,
  planRework,
  resolvePipeline,
  retireFinishedRun,
  retireWrote,
  snapshotBeforeWrites,
  stageLabelsOn,
} = await import("./rework-pipeline");
const { ReworkConflictError, ReworkUnavailableError } = await import("./rework-contract");

const project: Project = { id: "p1", slug: "p", name: "p", repoPath: "/repo" } as Project;

function makeBead(over: Partial<Bead> & { id: string }): Bead {
  return { title: over.id, status: "open", issue_type: "task", labels: [], ...over };
}

/** The ordinary grouped run: a feature run target with a ticket under it. */
const feature = (over: Partial<Bead> = {}) =>
  makeBead({ id: "feat", issue_type: "feature", ...over });
const ticket = (over: Partial<Bead> = {}) => makeBead({ id: "t1", parent: "feat", ...over });
/** A target carrying a LIVE PR ref — the marker resolvePipeline and the retire both read first. */
const withPr = (pr = "gh-42", over: Partial<Bead> = {}) => feature({ metadata: { pr }, ...over });

/** Every bd write this module can make — asserted absent wherever it must write nothing at all. */
const allWrites = [noteMock, reopenMock, untagMock, tagMock, closeMock, retirePrRefMock, setPrRefMock];

/** The bead a bd call was made on: most take an id, `retirePrRef` takes the bead itself. */
function beadArg(call: unknown[]): string | undefined {
  const arg = call[1];
  return typeof arg === "string" ? arg : (arg as Bead | undefined)?.id;
}

/** WHEN `mock` wrote to `id` — the seam for asserting one write landed before another. */
function orderOn(mock: ReturnType<typeof vi.fn>, id: string, nth = 0): number {
  const matches = mock.mock.calls
    .map((call, i) => ({ call, i }))
    .filter(({ call }) => beadArg(call) === id);
  expect(matches.length, `expected ${nth + 1} call(s) on ${id}`).toBeGreaterThan(nth);
  return mock.mock.invocationCallOrder[matches[nth]!.i]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The board as the retire re-reads it, unless a case says otherwise. No PR ref, so a stray `gh`
  // read is a test failure rather than a silently satisfied one.
  showMock.mockImplementation(async (_cwd, id) => makeBead({ id }));
  prStateMock.mockResolvedValue("unknown");
});

describe("stageLabelsOn", () => {
  it("reports the run stage labels the bead is actually wearing, and nothing else", () => {
    expect(stageLabelsOn(makeBead({ id: "t1", labels: ["stage:in-review", "approved"] }))).toEqual([
      "stage:in-review",
    ]);
    expect(stageLabelsOn(makeBead({ id: "t1", labels: ["approved"] }))).toEqual([]);
    expect(stageLabelsOn(makeBead({ id: "t1" }))).toEqual([]);
  });

  it("reports them in the order the retire strips them, so a rollback puts back exactly that", () => {
    const wornBackwards = makeBead({ id: "t1", labels: [...RUN_STAGE_LABELS].reverse() });
    expect(stageLabelsOn(wornBackwards)).toEqual(RUN_STAGE_LABELS);
  });
});

describe("resolvePipeline", () => {
  it("says nothing about a target with no PR at all — and never asks gh", async () => {
    await expect(resolvePipeline("/repo", feature(), "reopen")).resolves.toBeUndefined();
    expect(prStateMock).not.toHaveBeenCalled();
  });

  it("retires an OPEN live ref, so the next run executes on that same branch", async () => {
    prStateMock.mockResolvedValue("open");
    await expect(resolvePipeline("/repo", withPr(), "reopen")).resolves.toEqual({
      outcome: "retired",
      pr: "gh-42",
      redirected: false,
    });
    expect(prStateMock).toHaveBeenCalledWith("/repo", "gh-42");
  });

  it("ships a MERGED one and redirects the reopen onto its own run target", async () => {
    prStateMock.mockResolvedValue("merged");
    await expect(resolvePipeline("/repo", withPr(), "reopen")).resolves.toEqual({
      outcome: "shipped",
      pr: "gh-42",
      redirected: true,
    });
    // A follow-up was already going where the merge sends it, so nothing is redirected.
    await expect(resolvePipeline("/repo", withPr(), "follow-up")).resolves.toMatchObject({
      outcome: "shipped",
      redirected: false,
    });
  });

  it("leaves a CLOSED-unmerged ref exactly as it is — step 0a already falls through it", async () => {
    prStateMock.mockResolvedValue("closed");
    await expect(resolvePipeline("/repo", withPr(), "reopen")).resolves.toBeUndefined();
  });

  it("reads an already-RETIRED ref for the merge it may have missed since", async () => {
    const retired = feature({ metadata: { retiredPr: "gh-42" } });
    prStateMock.mockResolvedValue("merged");
    await expect(resolvePipeline("/repo", retired, "reopen")).resolves.toMatchObject({
      outcome: "shipped",
      pr: "gh-42",
    });
    // Still open: the marker this would retire is already off the bead, so there is nothing to say.
    prStateMock.mockResolvedValue("open");
    await expect(resolvePipeline("/repo", retired, "reopen")).resolves.toBeUndefined();
  });

  it("asks about the LIVE ref, not a stale retired one, when the bead carries both", async () => {
    prStateMock.mockResolvedValue("open");
    const both = feature({ metadata: { pr: "gh-99", retiredPr: "gh-42" } });
    await expect(resolvePipeline("/repo", both, "reopen")).resolves.toMatchObject({ pr: "gh-99" });
    expect(prStateMock).toHaveBeenCalledExactlyOnceWith("/repo", "gh-99");
  });

  it("refuses an unreadable PR rather than picking one of two opposite answers", async () => {
    prStateMock.mockResolvedValue("unknown");
    await expect(resolvePipeline("/repo", withPr(), "reopen")).rejects.toBeInstanceOf(
      ReworkUnavailableError,
    );
    await expect(resolvePipeline("/repo", withPr(), "reopen")).rejects.toThrow(/gh-42/);
  });
});

describe("planRework", () => {
  it("spares gh entirely for a follow-up that comes out parentless anyway", async () => {
    const solo = makeBead({ id: "solo", metadata: { pr: "gh-42" } });
    await expect(planRework("/repo", solo, solo, [solo], "follow-up")).resolves.toEqual({
      pipeline: undefined,
      mode: "follow-up",
      rollsBackTicket: false,
    });
    expect(prStateMock).not.toHaveBeenCalled();
  });

  it("still asks about a REOPEN of a standalone target — that one runs under the target", async () => {
    prStateMock.mockResolvedValue("open");
    const solo = makeBead({ id: "solo", metadata: { pr: "gh-42" } });
    await expect(planRework("/repo", solo, solo, [solo], "reopen")).resolves.toMatchObject({
      mode: "reopen",
      pipeline: { outcome: "retired" },
    });
  });

  it("carries the PR's redirect into the mode it plans", async () => {
    prStateMock.mockResolvedValue("merged");
    const all = [withPr(), ticket()];
    const plan = await planRework("/repo", withPr(), ticket(), all, "reopen");
    expect(plan.mode).toBe("follow-up");
    expect(plan.pipeline).toMatchObject({ outcome: "shipped", redirected: true });
    // A redirected send-back writes no reopen, so there is no child write left to roll back.
    expect(plan.rollsBackTicket).toBe(false);
  });

  it("flags a child rollback only for a reopen of a bead that is not the target itself", async () => {
    const all = [feature(), ticket()];
    await expect(planRework("/repo", feature(), ticket(), all, "reopen")).resolves.toMatchObject({
      rollsBackTicket: true,
    });
    await expect(planRework("/repo", feature(), ticket(), all, "follow-up")).resolves.toMatchObject({
      rollsBackTicket: false,
    });
    const solo = makeBead({ id: "solo" });
    await expect(planRework("/repo", solo, solo, [solo], "reopen")).resolves.toMatchObject({
      rollsBackTicket: false,
    });
  });
});

describe("snapshotBeforeWrites", () => {
  it("reads both beads off bd, but the ticket only where a rollback would reach it", async () => {
    showMock.mockImplementation(async (_cwd, id) => makeBead({ id, status: "closed" }));

    const both = await snapshotBeforeWrites("/repo", feature(), ticket(), true);
    expect([both.target.id, both.ticket?.id]).toEqual(["feat", "t1"]);
    expect(showMock.mock.calls).toEqual([
      ["/repo", "feat"],
      ["/repo", "t1"],
    ]);

    showMock.mockClear();
    await expect(snapshotBeforeWrites("/repo", feature(), ticket(), false)).resolves.toMatchObject({
      ticket: undefined,
    });
    expect(showMock.mock.calls).toEqual([["/repo", "feat"]]);
  });

  it("guards on the FRESH target's ref, not the caller's older copy of it", async () => {
    // The caller's bead was read before the locks; the ref a rival request left is only on the
    // re-read, and it is that one the mode's writes are about to be predicated on.
    showMock.mockImplementation(async (_cwd, id) => makeBead({ id, metadata: { pr: "gh-42" } }));
    prStateMock.mockResolvedValue("open");
    await expect(snapshotBeforeWrites("/repo", feature(), ticket(), false)).resolves.toMatchObject({
      target: { id: "feat" },
    });
    expect(prStateMock).toHaveBeenCalledWith("/repo", "gh-42");
  });

  it("refuses a 409 before ANY write when the PR stopped being open under the request", async () => {
    showMock.mockImplementation(async (_cwd, id) => makeBead({ id, metadata: { pr: "gh-42" } }));
    prStateMock.mockResolvedValue("merged");
    await expect(snapshotBeforeWrites("/repo", feature(), ticket(), false)).rejects.toBeInstanceOf(
      ReworkConflictError,
    );
    await expect(snapshotBeforeWrites("/repo", feature(), ticket(), false)).rejects.toThrow(
      /nothing was written/,
    );
    for (const write of allWrites) expect(write).not.toHaveBeenCalled();
  });

  it("separates a 503 for gh going unreadable from that lost race", async () => {
    showMock.mockImplementation(async (_cwd, id) => makeBead({ id, metadata: { pr: "gh-42" } }));
    prStateMock.mockResolvedValue("unknown");
    await expect(snapshotBeforeWrites("/repo", feature(), ticket(), false)).rejects.toBeInstanceOf(
      ReworkUnavailableError,
    );
    for (const write of allWrites) expect(write).not.toHaveBeenCalled();
  });

  it("has nothing to invalidate on a target a rival request already retired", async () => {
    // No live ref left, so the guard passes without asking gh — the retire below reports it as
    // `already-retired` rather than as a race.
    await expect(snapshotBeforeWrites("/repo", feature(), ticket(), false)).resolves.toMatchObject({
      target: { id: "feat" },
    });
    expect(prStateMock).not.toHaveBeenCalled();
  });
});

describe("retireFinishedRun", () => {
  /** The target as the retire re-reads it under the lock: finished, closed, still wearing its ref. */
  function freshTarget(over: Partial<Bead> = {}): void {
    showMock.mockImplementation(async (_cwd, id) =>
      makeBead({ id, status: "closed", metadata: { pr: "gh-42" }, ...over }),
    );
  }

  const beforeTarget = () => feature({ status: "closed", labels: ["stage:in-review"] });

  it("writes the three retires in the order that makes a failure part-way re-enterable", async () => {
    freshTarget();
    prStateMock.mockResolvedValue("open");

    await expect(retireFinishedRun(project, beforeTarget())).resolves.toEqual({
      outcome: "retired",
    });

    expect(untagMock).toHaveBeenCalledWith("/repo", "feat", RUN_STAGE_LABELS);
    expect(reopenMock).toHaveBeenCalledWith("/repo", "feat", "rework: sent back for another round");
    expect(retirePrRefMock).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ id: "feat" }),
      "gh-42",
    );
    // The live ref is the only marker that brings a retry back into the retire, so it moves LAST:
    // a failure before it leaves the send-back re-enterable instead of stranding a mid-retire target.
    expect(orderOn(untagMock, "feat")).toBeLessThan(orderOn(reopenMock, "feat"));
    expect(orderOn(reopenMock, "feat")).toBeLessThan(orderOn(retirePrRefMock, "feat"));
  });

  it("verifies the retire against gh AFTER the writes, and only then records it", async () => {
    freshTarget();
    prStateMock.mockResolvedValue("open");

    await retireFinishedRun(project, beforeTarget());

    // A merge landing WHILE the writes applied passes the pre-write guard, so the state is re-read
    // once they have landed — and the note that says "it ran again" comes after that answer.
    expect(prStateMock).toHaveBeenCalledExactlyOnceWith("/repo", "gh-42");
    const verifiedAt = prStateMock.mock.invocationCallOrder[0]!;
    expect(verifiedAt).toBeGreaterThan(orderOn(retirePrRefMock, "feat"));
    expect(verifiedAt).toBeLessThan(orderOn(noteMock, "feat"));
    expect(noteMock.mock.calls[0]![2]).toContain("gh-42 is still open");
  });

  it("is a no-op on a target whose ref is already gone, and never asks gh", async () => {
    await expect(retireFinishedRun(project, feature())).resolves.toEqual({
      outcome: "already-retired",
    });
    for (const write of allWrites) expect(write).not.toHaveBeenCalled();
    expect(prStateMock).not.toHaveBeenCalled();
  });

  it("asks the FRESH board what is left to write — an already-reopened target is not reopened", async () => {
    // On a standalone target the mode's own reopen has already landed by now.
    freshTarget({ status: "open" });
    prStateMock.mockResolvedValue("open");

    await expect(retireFinishedRun(project, beforeTarget())).resolves.toEqual({
      outcome: "retired",
    });
    expect(reopenMock).not.toHaveBeenCalled();
    expect(untagMock).toHaveBeenCalledOnce();
    expect(retirePrRefMock).toHaveBeenCalledOnce();
  });

  it("undoes its own writes when the verify no longer reads the PR as open", async () => {
    freshTarget();
    prStateMock.mockResolvedValue("merged");
    const reopenedTicket = ticket({ status: "closed", labels: ["stage:in-review"] });

    await expect(retireFinishedRun(project, beforeTarget(), reopenedTicket)).resolves.toEqual({
      outcome: "raced",
      pr: "gh-42",
      state: "merged",
    });

    // Put back from the SNAPSHOT, not from the fresh read: closed, wearing exactly the stage it had.
    expect(closeMock).toHaveBeenCalledWith(
      "/repo",
      "feat",
      "rework: retire rolled back — gh-42 reads as merged now",
    );
    expect(tagMock).toHaveBeenCalledWith("/repo", "feat", ["stage:in-review"]);
    expect(setPrRefMock).toHaveBeenCalledWith("/repo", "feat", "gh-42");
    expect(noteMock.mock.calls.at(-1)![2]).toContain("gh-42 reads as merged now");
  });

  it("restores in the mirrored order: the live ref last, the target before the child, the notes after", async () => {
    freshTarget();
    prStateMock.mockResolvedValue("merged");

    await retireFinishedRun(project, beforeTarget(), ticket({ status: "closed", labels: ["stage:in-review"] }));

    // Restoring the live ref publishes the target as a finished one again, and nothing after it is
    // retriable — so it goes last of the target's three, and the child's own rollback follows it.
    expect(orderOn(closeMock, "feat")).toBeLessThan(orderOn(tagMock, "feat"));
    expect(orderOn(tagMock, "feat")).toBeLessThan(orderOn(setPrRefMock, "feat"));
    expect(orderOn(setPrRefMock, "feat")).toBeLessThan(orderOn(closeMock, "t1"));
    expect(orderOn(closeMock, "t1")).toBeLessThan(orderOn(tagMock, "t1"));
    expect(orderOn(tagMock, "t1")).toBeLessThan(orderOn(noteMock, "t1"));
    expect(orderOn(noteMock, "t1")).toBeLessThan(orderOn(noteMock, "feat"));
  });

  it("puts back only what it took: no reopen-undo for an open target, no tag for a stage-less one", async () => {
    freshTarget();
    prStateMock.mockResolvedValue("merged");

    await retireFinishedRun(project, feature());

    expect(closeMock).not.toHaveBeenCalled();
    expect(tagMock).not.toHaveBeenCalled();
    expect(setPrRefMock).toHaveBeenCalledWith("/repo", "feat", "gh-42");
  });

  it("leaves the child alone on a target whose rollback already covers the ticket", async () => {
    freshTarget();
    prStateMock.mockResolvedValue("merged");

    await retireFinishedRun(project, beforeTarget());

    expect(closeMock.mock.calls.map((c) => c[1])).toEqual(["feat"]);
    expect(noteMock.mock.calls.map((c) => c[1])).toEqual(["feat"]);
  });

  it("tells the founder, on the child, that the send-back above it was rolled back", async () => {
    freshTarget();
    prStateMock.mockResolvedValue("merged");

    await retireFinishedRun(project, beforeTarget(), ticket({ status: "closed" }));

    const childNote = noteMock.mock.calls.find((c) => c[1] === "t1")![2] as string;
    expect(childNote).toContain("the send-back that left the instructions above was rolled back");
    expect(childNote).toContain("feat's pull request gh-42 reads as merged now");
  });

  it("rolls back an UNREADABLE verify too, and reports it apart from a lost race", async () => {
    freshTarget();
    prStateMock.mockResolvedValue("unknown");

    await expect(retireFinishedRun(project, beforeTarget())).resolves.toEqual({
      outcome: "unverifiable",
      pr: "gh-42",
    });
    // Not proof the PR moved, but the loss of the proof the writes stood on — so they come off.
    expect(setPrRefMock).toHaveBeenCalledWith("/repo", "feat", "gh-42");
    expect(noteMock.mock.calls.at(-1)![2]).toContain(
      "gh-42's state could no longer be read as it was applying",
    );
  });
});

describe("retireWrote", () => {
  it("counts every outcome that touched the board, including a rolled-back one", () => {
    expect(retireWrote({ outcome: "retired" })).toBe(true);
    expect(retireWrote({ outcome: "raced", pr: "gh-42", state: "merged" })).toBe(true);
    expect(retireWrote({ outcome: "unverifiable", pr: "gh-42" })).toBe(true);
    expect(retireWrote({ outcome: "already-retired" })).toBe(false);
    expect(retireWrote({ outcome: "not-attempted" })).toBe(false);
  });
});

describe("assertRetireStood", () => {
  const applied = { targetId: "feat", ticketId: "t1", reworkedId: "t1", rollsBackTicket: false };

  it("is silent for a retire that stood, and for one never attempted", () => {
    expect(() => assertRetireStood({ outcome: "retired" }, applied)).not.toThrow();
    expect(() => assertRetireStood({ outcome: "not-attempted" }, applied)).not.toThrow();
    expect(() => assertRetireStood({ outcome: "already-retired" }, applied)).not.toThrow();
  });

  it("names both rolled-back beads on a grouped reopen, and only the target otherwise", () => {
    const raced = { outcome: "raced", pr: "gh-42", state: "merged" } as const;
    expect(() => assertRetireStood(raced, { ...applied, rollsBackTicket: true })).toThrow(
      /applied to feat and t1 was rolled back/,
    );
    expect(() => assertRetireStood(raced, applied)).toThrow(/applied to feat was rolled back/);
  });

  it("separates 'the PR moved' (409) from 'anton went blind' (503)", () => {
    expect(() =>
      assertRetireStood({ outcome: "raced", pr: "gh-42", state: "merged" }, applied),
    ).toThrow(ReworkConflictError);
    expect(() => assertRetireStood({ outcome: "unverifiable", pr: "gh-42" }, applied)).toThrow(
      ReworkUnavailableError,
    );
  });

  it("keeps the instructions pointed at the bead that carries them", () => {
    expect(() =>
      assertRetireStood({ outcome: "raced", pr: "gh-42", state: "merged" }, {
        ...applied,
        reworkedId: "anton-new",
      }),
    ).toThrow(/instructions stay on anton-new/);
  });
});
