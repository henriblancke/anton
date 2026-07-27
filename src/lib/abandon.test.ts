import { describe, expect, it } from "vitest";
import { openDescendants } from "./abandon";
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

describe("openDescendants (epic abandon cascade)", () => {
  it("walks the whole three-tier subtree, not just direct children", () => {
    const board = [
      makeBead({ id: "epic", issue_type: "epic" }),
      makeBead({ id: "feature", issue_type: "feature", parent: "epic" }),
      makeBead({ id: "t1", parent: "feature" }),
      makeBead({ id: "t2", parent: "feature" }),
    ];

    expect(openDescendants(board, "epic").map((b) => b.id)).toEqual(["feature", "t1", "t2"]);
  });

  it("descends through a settled feature to reach its still-open tickets", () => {
    const board = [
      makeBead({ id: "epic", issue_type: "epic" }),
      makeBead({ id: "feature", issue_type: "feature", parent: "epic", status: "closed" }),
      makeBead({ id: "t1", parent: "feature" }),
    ];

    expect(openDescendants(board, "epic").map((b) => b.id)).toEqual(["t1"]);
  });

  it("leaves other epics' subtrees and parentless beads alone", () => {
    const board = [
      makeBead({ id: "epic", issue_type: "epic" }),
      makeBead({ id: "feature", issue_type: "feature", parent: "epic" }),
      makeBead({ id: "other-epic", issue_type: "epic" }),
      makeBead({ id: "other-task", parent: "other-epic" }),
      makeBead({ id: "loose" }),
    ];

    expect(openDescendants(board, "epic").map((b) => b.id)).toEqual(["feature"]);
  });

  it("reads the parent from parent_id when that is the field bd populated", () => {
    const board = [
      makeBead({ id: "epic", issue_type: "epic" }),
      makeBead({ id: "feature", issue_type: "feature", parent_id: "epic" }),
      makeBead({ id: "t1", parent_id: "feature" }),
    ];

    expect(openDescendants(board, "epic").map((b) => b.id)).toEqual(["feature", "t1"]);
  });

  it("terminates on a malformed parent cycle", () => {
    // The epic is recorded as its own grandchild's child — the seen-set guard stops the loop.
    const board = [
      makeBead({ id: "epic", issue_type: "epic", parent: "b" }),
      makeBead({ id: "a", parent: "epic" }),
      makeBead({ id: "b", parent: "a" }),
    ];

    expect(openDescendants(board, "epic").map((b) => b.id)).toEqual(["a", "b"]);
  });

  it("returns nothing for an epic with no children", () => {
    expect(openDescendants([makeBead({ id: "epic", issue_type: "epic" })], "epic")).toEqual([]);
  });
});
