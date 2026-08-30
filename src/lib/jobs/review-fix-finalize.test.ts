/**
 * finalizeMergedEpic's board write (anton-aijz): a merged run target and its still-open children
 * must close in ONE bd transaction, and `stage:in-review` may only drop once that transaction
 * lands — a failure has to leave the label in place so the next sweep re-selects the epic and
 * retries, rather than orphaning a still-open ticket behind a run already marked done.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "../beads/bd";
import { contractGaps } from "../beads/contract";

const batchMock = vi.fn();
const untagMock = vi.fn();
const noteMock = vi.fn();
const createMock = vi.fn();
const reparentMock = vi.fn();
const deleteMock = vi.fn();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      batch: (...args: unknown[]) => batchMock(...args),
      untag: (...args: unknown[]) => untagMock(...args),
      note: (...args: unknown[]) => noteMock(...args),
      create: (...args: unknown[]) => createMock(...args),
      reparent: (...args: unknown[]) => reparentMock(...args),
      delete: (...args: unknown[]) => deleteMock(...args),
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

const { finalizeMergedEpic } = await import("./review-fix");

const bead = (id: string, status = "open", labels: string[] = []): Bead =>
  ({ id, title: id, status, labels }) as Bead;

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
    noteMock.mockReset().mockResolvedValue(undefined);
    createMock.mockReset().mockResolvedValue("epic-2");
    reparentMock.mockReset().mockResolvedValue(undefined);
    deleteMock.mockReset().mockResolvedValue(undefined);
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

  it("leaves a `not-delivered` child open — a merged PR does not contain it", async () => {
    // The run that opened this PR absorbed a ticket timeout: `t2` was rolled back and `t3` was
    // skipped behind it, so neither is in the merged diff. Closing them here would file work that
    // was never done as shipped and lose it silently.
    await finalize(bead("epic-1"), [
      bead("t1"),
      bead("t2", "blocked", ["not-delivered"]),
      bead("t3", "open", ["not-delivered"]),
    ]);

    expect(batchMock.mock.calls[0][1]).toEqual([
      { op: "close", id: "t1" },
      { op: "close", id: "epic-1" },
    ]);
    // The target still closes — the PR it points at is merged and terminal — so the preserved
    // tickets say for themselves why they outlived it.
    expect(untagMock).toHaveBeenCalledWith("/repo", "epic-1", ["stage:in-review"]);
    expect(noteMock.mock.calls.map((c) => c[1])).toEqual(["t2", "t3"]);
    expect(noteMock.mock.calls[0][2]).toContain("merged WITHOUT this ticket");
  });

  it("rehomes the preserved tickets under a new run target", async () => {
    // A ticket parented to the merged (now closed) target is not a run target, and the target
    // itself short-circuits on its merged PR ref — so without a new home the note telling the
    // operator to re-run this work names nothing anton can claim.
    await finalize(bead("epic-1", "open", ["area:runs", "approved"]), [
      bead("t1"),
      bead("t2", "blocked", ["not-delivered"]),
    ]);

    expect(createMock).toHaveBeenCalledTimes(1);
    const opts = createMock.mock.calls[0][1];
    expect(opts.type).toBe("epic"); // an epic with no feature children IS a run target
    expect(opts.labels).toEqual(["area:runs"]); // inherited; `approved` deliberately is NOT
    // Runnable means runnable: the follow-up must clear the same contract gate the approve route
    // and execute-epic apply, or anton would refuse the target it just wrote for itself.
    const created = {
      id: "epic-2",
      issue_type: opts.type,
      acceptance: opts.acceptance,
      description: opts.description,
      labels: opts.labels,
    } as Bead;
    expect(contractGaps([created], "blocking")).toEqual([]);
    expect(reparentMock).toHaveBeenCalledWith("/repo", "t2", "epic-2");
    expect(noteMock.mock.calls[0][2]).toContain("now lives under epic-2");
  });

  it("names the manual remedy when the ticket cannot be rehomed", async () => {
    createMock.mockRejectedValue(new Error("bd create: DB locked"));

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    // Finalization still completes — its closes already landed — but the note must not claim a
    // home the ticket never reached.
    expect(untagMock).toHaveBeenCalledWith("/repo", "epic-1", ["stage:in-review"]);
    expect(noteMock.mock.calls[0][2]).toContain("could NOT be rehomed");
  });

  it("deletes the follow-up target again when no ticket reaches it", async () => {
    reparentMock.mockRejectedValue(new Error("bd update: DB locked"));

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    // A childless epic is a poison run, not a home — leaving one behind trades an unreachable
    // ticket for an unrunnable target.
    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-2");
    expect(noteMock.mock.calls[0][2]).toContain("could NOT be rehomed");
  });

  it("closes a leaf target marked not-delivered rather than preserving itself", async () => {
    // A leaf run target is its own ticket, so it appears on both sides. Excluding it from the close
    // would leave `stage:in-review` on forever and re-select it on every sweep.
    const leaf = bead("epic-1", "open", ["not-delivered"]);

    await finalize(leaf, [leaf]);

    expect(batchMock.mock.calls[0][1]).toEqual([{ op: "close", id: "epic-1" }]);
    expect(createMock).not.toHaveBeenCalled();
    expect(untagMock).toHaveBeenCalledWith("/repo", "epic-1", ["stage:in-review"]);
  });

  it("keeps stage:in-review when the transaction fails, so the next sweep retries", async () => {
    batchMock.mockRejectedValue(new Error("bd batch: rolled back"));

    await finalize(bead("epic-1"), [bead("t1")]);

    // Nothing closed (bd rolled the batch back) and the epic is still in review — the two halves
    // of "retryable" that a half-closed unit would have destroyed.
    expect(untagMock).not.toHaveBeenCalled();
  });
});
