import { describe, expect, it } from "vitest";
import { planMove } from "./board-move";
import type { Bead } from "./beads/bd";

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
