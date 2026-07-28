import { describe, expect, it } from "vitest";
import { runTickets } from "./ticket-view";
import type { Bead } from "./beads/bd";

function makeBead(overrides: Partial<Bead> & { id: string }): Bead {
  return {
    title: overrides.id,
    status: "open",
    issue_type: "task",
    labels: [],
    ...overrides,
  };
}

describe("runTickets (the tickets a run target contains)", () => {
  it("collects the whole working-layer subtree, not just direct children", () => {
    // epic → feature → task → subtask. The subtask ships in the feature's worktree and PR, so the
    // run must execute it — a direct-children run merged the PR and stranded it open.
    const board = [
      makeBead({ id: "epic-p", issue_type: "epic" }),
      makeBead({ id: "feat-1", issue_type: "feature", parent: "epic-p" }),
      makeBead({ id: "task-1", parent: "feat-1" }),
      makeBead({ id: "sub-1", parent: "task-1" }),
    ];
    expect(runTickets(board, "feat-1").map((b) => b.id)).toEqual(["task-1", "sub-1"]);
  });

  it("stops descending at a nested card — it owns its own subtree and its own PR", () => {
    const board = [
      makeBead({ id: "feat-1", issue_type: "feature" }),
      makeBead({ id: "task-1", parent: "feat-1" }),
      makeBead({ id: "feat-2", issue_type: "feature", parent: "feat-1" }),
      makeBead({ id: "task-2", parent: "feat-2" }),
    ];
    expect(runTickets(board, "feat-1").map((b) => b.id)).toEqual(["task-1"]);
    expect(runTickets(board, "feat-2").map((b) => b.id)).toEqual(["task-2"]);
  });

  it("carries a legacy epic's tickets, however deep", () => {
    const board = [
      makeBead({ id: "epic-legacy", issue_type: "epic" }),
      makeBead({ id: "task-1", parent: "epic-legacy" }),
      makeBead({ id: "sub-1", parent: "task-1" }),
    ];
    expect(runTickets(board, "epic-legacy").map((b) => b.id)).toEqual(["task-1", "sub-1"]);
  });

  it("gives a container epic no tickets — its features each run on their own", () => {
    const board = [
      makeBead({ id: "epic-p", issue_type: "epic" }),
      makeBead({ id: "feat-1", issue_type: "feature", parent: "epic-p" }),
      makeBead({ id: "task-1", parent: "feat-1" }),
      // A task parked directly under the container ships in no run — it belongs to no card.
      makeBead({ id: "loose-1", parent: "epic-p" }),
    ];
    expect(runTickets(board, "epic-p")).toEqual([]);
  });

  it("closes over a malformed parent cycle rather than hanging", () => {
    const board = [
      makeBead({ id: "feat-1", issue_type: "feature" }),
      makeBead({ id: "a", parent: "b" }),
      makeBead({ id: "b", parent: "a" }),
    ];
    expect(runTickets(board, "feat-1")).toEqual([]);
  });
});
