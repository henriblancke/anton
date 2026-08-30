/**
 * finalizeMergedEpic's board write (anton-aijz): a merged run target and its still-open children
 * must close in ONE bd transaction, and `stage:in-review` may only drop once that transaction
 * lands — a failure has to leave the label in place so the next sweep re-selects the epic and
 * retries, rather than orphaning a still-open ticket behind a run already marked done.
 *
 * And what that transaction may contain (anton-67xj.1): the children the run never delivered — the
 * ones it blocked, and the ones left waiting behind them — stay open, or the merge silently retires
 * work a human still has to run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LABELS, type Bead } from "../beads/bd";

const batchMock = vi.fn();
const untagMock = vi.fn();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      batch: (...args: unknown[]) => batchMock(...args),
      untag: (...args: unknown[]) => untagMock(...args),
    },
  };
});

vi.mock("../git/worktree", () => ({
  findWorktree: vi.fn().mockResolvedValue(undefined),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  worktreePathFor: (repo: string, branch: string) => `${repo}/.wt/${branch}`,
  createWorktree: vi.fn(),
}));

vi.mock("../runs", () => ({
  findOpenRunForEpic: vi.fn().mockResolvedValue(null),
  updateRun: vi.fn(),
}));

const { finalizeMergedEpic, undeliveredAtMerge } = await import("./review-fix");

const bead = (id: string, status = "open"): Bead => ({ id, title: id, status }) as Bead;

/** A ticket that waits on `blocker` — the `blocks` edge bd carries inline on the dependent. */
const waitsOn = (id: string, blocker: string, status = "open"): Bead =>
  ({
    ...bead(id, status),
    dependencies: [{ issue_id: id, depends_on_id: blocker, type: "blocks" }],
  }) as Bead;

const finalize = (epic: Bead, children: Bead[]) =>
  finalizeMergedEpic({
    db: {} as never,
    clock: { now: () => 0 } as never,
    repo: "/repo",
    projectId: "p1",
    epic,
    children,
    branch: "anton/epic-1",
  });

describe("finalizeMergedEpic", () => {
  beforeEach(() => {
    batchMock.mockReset().mockResolvedValue(undefined);
    untagMock.mockReset().mockResolvedValue(undefined);
  });

  it("closes the still-open children and the target in one batch, children first", async () => {
    await finalize(bead("epic-1"), [bead("t1"), bead("t2", "closed"), bead("t3")]);

    expect(batchMock).toHaveBeenCalledTimes(1);
    // Already-closed t2 is left out: re-closing it is noise, and its outcome is already settled.
    expect(batchMock.mock.calls[0][1]).toEqual([
      { op: "close", id: "t1" },
      { op: "close", id: "t3" },
      { op: "close", id: "epic-1" },
    ]);
    expect(untagMock).toHaveBeenCalledWith("/repo", "epic-1", ["stage:in-review"]);
  });

  it("leaves an already-closed target out of the batch but still clears the stage", async () => {
    // The idempotent re-run: a prior sweep closed everything and only the label write failed.
    await finalize(bead("epic-1", "closed"), [bead("t1", "closed")]);

    expect(batchMock.mock.calls[0][1]).toEqual([]); // nothing left to close (the seam spawns no bd)
    expect(untagMock).toHaveBeenCalledWith("/repo", "epic-1", ["stage:in-review"]);
  });

  it("keeps stage:in-review when the transaction fails, so the next sweep retries", async () => {
    batchMock.mockRejectedValue(new Error("bd batch: rolled back"));

    await finalize(bead("epic-1"), [bead("t1")]);

    // Nothing closed (bd rolled the batch back) and the epic is still in review — the two halves
    // of "retryable" that a half-closed unit would have destroyed.
    expect(untagMock).not.toHaveBeenCalled();
  });

  it("leaves a blocked child open and still closes the target and the plain open one", async () => {
    // The shape anton-67xj.1 exists for: t1 ran out of its budget and was rolled back, so its work
    // is on no branch. The merge must not close it — its note tells a human to re-scope and run it.
    await finalize(bead("epic-1"), [bead("t1", "blocked"), bead("t2")]);

    expect(batchMock.mock.calls[0][1]).toEqual([
      { op: "close", id: "t2" },
      { op: "close", id: "epic-1" },
    ]);
    expect(untagMock).toHaveBeenCalledWith("/repo", "epic-1", ["stage:in-review"]);
  });

  it("leaves a ticket skipped behind a blocked one open too", async () => {
    // t2 was never dispatched (anton-67xj) — it stays `open` for the board, so only the `blocks`
    // edge to the rolled-back t1 tells the merge it delivered nothing.
    await finalize(bead("epic-1"), [bead("t1", "blocked"), waitsOn("t2", "t1"), bead("t3")]);

    expect(batchMock.mock.calls[0][1]).toEqual([
      { op: "close", id: "t3" },
      { op: "close", id: "epic-1" },
    ]);
  });

  it("leaves a ticket stranded behind an abandoned dependency open", async () => {
    // t2 was abandoned by hand — closed, but with no commit behind it — so t3 was never dispatched
    // and must not be retired by the merge.
    await finalize(bead("epic-1"), [
      bead("t1", "blocked"),
      { ...waitsOn("t2", "t1", "closed"), labels: [LABELS.abandoned] } as Bead,
      waitsOn("t3", "t2"),
    ]);

    expect(batchMock.mock.calls[0][1]).toEqual([{ op: "close", id: "epic-1" }]);
  });

  it("closes a delivered dependent whose close write failed, repairing it", async () => {
    // t1 timed out AFTER committing, so the run carried on and t2 ran and committed too — but t2's
    // best-effort `beads.close` failed, leaving it claimed and `in_progress`. The merge is what
    // repairs that, so t2 (and t3 behind it) must close rather than be read as never-dispatched.
    await finalize(bead("epic-1"), [
      bead("t1", "blocked"),
      waitsOn("t2", "t1", "in_progress"),
      waitsOn("t3", "t2"),
    ]);

    expect(batchMock.mock.calls[0][1]).toEqual([
      { op: "close", id: "t2" },
      { op: "close", id: "t3" },
      { op: "close", id: "epic-1" },
    ]);
  });
});

describe("undeliveredAtMerge", () => {
  it("holds back the blocked child and everything transitively behind it", () => {
    const children = [
      bead("t1", "blocked"),
      waitsOn("t2", "t1"),
      waitsOn("t3", "t2"), // transitive: t3 waits on a ticket that itself never ran
      bead("t4"),
    ];

    expect(undeliveredAtMerge(children)).toEqual(new Set(["t1", "t2", "t3"]));
  });

  it("stops at a closed dependent — its commit is on the branch whatever its blocker did", () => {
    // t2 committed before t1's budget ran out, so t3 has the mechanism it was written against.
    const children = [bead("t1", "blocked"), waitsOn("t2", "t1", "closed"), waitsOn("t3", "t2")];

    expect(undeliveredAtMerge(children)).toEqual(new Set(["t1"]));
  });

  it("stops at an in_progress dependent — it committed, only its close write failed", () => {
    // A blocker that timed out after its commit doesn't stop the run, so t2 was dispatched and
    // committed; `beads.close` is best-effort, so a transient bd failure is all that stands between
    // it and `closed`. Neither it nor t3 behind it is undelivered work.
    const children = [
      bead("t1", "blocked"),
      waitsOn("t2", "t1", "in_progress"),
      waitsOn("t3", "t2"),
    ];

    expect(undeliveredAtMerge(children)).toEqual(new Set(["t1"]));
  });

  it("walks through an abandoned dependent — it is closed on a won't-do, not on a commit", () => {
    // `abandoned` is the one closed status that carries no delivery: execute-epic drops such a
    // ticket from `live` for exactly this reason, so t3 behind it never ran either.
    const abandoned = { ...waitsOn("t2", "t1", "closed"), labels: [LABELS.abandoned] } as Bead;
    const children = [bead("t1", "blocked"), abandoned, waitsOn("t3", "t2")];

    expect(undeliveredAtMerge(children)).toEqual(new Set(["t1", "t2", "t3"]));
  });

  it("ignores non-blocks edges and edges leaving the run", () => {
    const parented = { ...bead("t2"), dependencies: [{ issue_id: "t2", depends_on_id: "t1", type: "parent-child" }] } as Bead;
    const outside = waitsOn("t3", "other-epic-ticket");

    expect(undeliveredAtMerge([bead("t1", "blocked"), parented, outside])).toEqual(new Set(["t1"]));
  });

  it("holds nothing back when every child delivered", () => {
    expect(undeliveredAtMerge([bead("t1"), waitsOn("t2", "t1")])).toEqual(new Set());
  });

  it("terminates on a dependency cycle", () => {
    const children = [bead("t1", "blocked"), waitsOn("t2", "t1"), waitsOn("t1b", "t2")];
    children[0] = { ...children[0], dependencies: [{ issue_id: "t1", depends_on_id: "t1b", type: "blocks" }] } as Bead;

    expect(undeliveredAtMerge(children)).toEqual(new Set(["t1", "t2", "t1b"]));
  });
});
