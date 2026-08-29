/**
 * finalizeMergedEpic's board write (anton-aijz): a merged run target and its still-open children
 * must close in ONE bd transaction, and `stage:in-review` may only drop once that transaction
 * lands — a failure has to leave the label in place so the next sweep re-selects the epic and
 * retries, rather than orphaning a still-open ticket behind a run already marked done.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "../beads/bd";

const batchMock = vi.fn();
const untagMock = vi.fn();
const noteMock = vi.fn();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      batch: (...args: unknown[]) => batchMock(...args),
      untag: (...args: unknown[]) => untagMock(...args),
      note: (...args: unknown[]) => noteMock(...args),
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

  it("keeps stage:in-review when the transaction fails, so the next sweep retries", async () => {
    batchMock.mockRejectedValue(new Error("bd batch: rolled back"));

    await finalize(bead("epic-1"), [bead("t1")]);

    // Nothing closed (bd rolled the batch back) and the epic is still in review — the two halves
    // of "retryable" that a half-closed unit would have destroyed.
    expect(untagMock).not.toHaveBeenCalled();
  });
});
