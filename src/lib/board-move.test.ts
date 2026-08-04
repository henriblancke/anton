import { afterEach, describe, expect, it, vi } from "vitest";
import { beads } from "./beads/bd";
import { withBeadWriteLock } from "./beads/claim-lock";
import { moveCard, planMove } from "./board-move";
import type { Bead } from "./beads/bd";
import type { Project } from "./types";

// Propagation is off the response path and covered in board-move.integration.test.ts; stubbing it
// keeps these cases free of the durable-queue database.
vi.mock("./beads/sync-nudge", () => ({ nudgeSync: vi.fn() }));

function makeBead(overrides: Partial<Bead> & { id: string; title: string }): Bead {
  return {
    status: "open",
    labels: [],
    ...overrides,
  };
}

describe("planMove", () => {
  it("backlog: untags both stage labels, no reopen when already open", () => {
    const bead = makeBead({ id: "b-1", title: "t", status: "open" });
    expect(planMove(bead, "backlog")).toEqual([
      { kind: "untag", labels: ["stage:implementing", "stage:in-review"] },
    ]);
  });

  it("backlog: reopens first when the bead is closed (moving out of done)", () => {
    const bead = makeBead({ id: "b-1", title: "t", status: "closed" });
    expect(planMove(bead, "backlog")).toEqual([
      { kind: "reopen" },
      { kind: "untag", labels: ["stage:implementing", "stage:in-review"] },
    ]);
  });

  it("implementing: tags implementing, untags in-review, no reopen when open", () => {
    const bead = makeBead({ id: "b-2", title: "t", status: "open" });
    expect(planMove(bead, "implementing")).toEqual([
      { kind: "tag", labels: ["stage:implementing"] },
      { kind: "untag", labels: ["stage:in-review"] },
    ]);
  });

  it("implementing: reopens first when the bead is closed", () => {
    const bead = makeBead({ id: "b-2", title: "t", status: "closed" });
    expect(planMove(bead, "implementing")).toEqual([
      { kind: "reopen" },
      { kind: "tag", labels: ["stage:implementing"] },
      { kind: "untag", labels: ["stage:in-review"] },
    ]);
  });

  it("in-review: tags in-review, untags implementing", () => {
    const bead = makeBead({ id: "b-3", title: "t", status: "in_progress" });
    expect(planMove(bead, "in-review")).toEqual([
      { kind: "tag", labels: ["stage:in-review"] },
      { kind: "untag", labels: ["stage:implementing"] },
    ]);
  });

  it("in-review: does not reopen a closed bead (not part of the contract)", () => {
    const bead = makeBead({ id: "b-3", title: "t", status: "closed" });
    expect(planMove(bead, "in-review")).toEqual([
      { kind: "tag", labels: ["stage:in-review"] },
      { kind: "untag", labels: ["stage:implementing"] },
    ]);
  });

  it("done: closes the bead", () => {
    const bead = makeBead({ id: "b-4", title: "t", status: "open" });
    expect(planMove(bead, "done")).toEqual([{ kind: "close" }]);
  });

  it("done: closing an already-closed bead is still a close op", () => {
    const bead = makeBead({ id: "b-4", title: "t", status: "closed" });
    expect(planMove(bead, "done")).toEqual([{ kind: "close" }]);
  });
});

// A drag to Done closes the card, and the gardener decides whether it may hang work under that card
// from a read taken inside the card's write lock (apply.ts `homeUnusable`/`assertHomeIsCard`), then
// yields before its write. Outside the lock this close lands in exactly that gap: the re-parent
// passes every check and attaches open work beneath a card that is closed by the time it writes,
// settling as successfully applied.
describe("moveCard serializes with the gardener's apply lock", () => {
  const project: Project = {
    id: "p",
    slug: "p",
    name: "p",
    repoPath: "/repo",
    defaultBranch: "main",
    hasBeads: true,
    createdAt: 0,
  };

  /** Let the pending move reach the lock (or the write it would have made without one). */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

  afterEach(() => vi.restoreAllMocks());

  it("waits for the card's write lock instead of closing under a concurrent apply", async () => {
    let card = makeBead({ id: "anton-card", title: "t", status: "open" });
    vi.spyOn(beads, "show").mockImplementation(async () => card);
    const close = vi.spyOn(beads, "close").mockResolvedValue("");

    let release!: () => void;
    const apply = withBeadWriteLock(
      project.repoPath,
      card.id,
      () => new Promise<void>((r) => (release = r)),
    );

    const moving = moveCard(project, card.id, "done");
    await settle();
    expect(close).not.toHaveBeenCalled();

    // The apply settles the card while it holds the lock; the plan must be derived from THAT board,
    // not the one this move read before it started waiting.
    card = { ...card, status: "closed" };
    release();
    await apply;
    await moving;

    expect(beads.show).toHaveBeenCalledTimes(1); // the read is inside the lock, not before it
    expect(close).toHaveBeenCalledTimes(1);
  });
});
