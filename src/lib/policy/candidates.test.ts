/**
 * The board → candidate projection (anton-qsr1). Two claims worth pinning: the editor counts OPEN
 * work only, and its blockedness is the same verdict the approve route and the runner enforce —
 * a panel that disagreed with them about "has an unmet blocker" would explain the wrong refusal.
 */
import { describe, expect, it } from "vitest";
import type { Bead } from "../beads/types";
import { policyCandidates } from "./candidates";

const bead = (o: Partial<Bead> & { id: string }): Bead => ({
  title: o.id,
  status: "open",
  issue_type: "task",
  ...o,
});

describe("policyCandidates", () => {
  it("projects only open beads, with the fields the predicate reads", () => {
    const board = [
      bead({ id: "a", issue_type: "bug", priority: 1, labels: ["severity:major"] }),
      bead({ id: "b", status: "closed" }),
      bead({ id: "c", status: "in_progress" }),
    ];
    expect(policyCandidates(board)).toEqual([
      { id: "a", title: "a", type: "bug", priority: 1, labels: ["severity:major"] },
    ]);
  });

  it("omits a type or priority the bead does not carry, rather than inventing one", () => {
    const [candidate] = policyCandidates([bead({ id: "a", issue_type: undefined })]);
    expect("type" in candidate).toBe(false);
    expect("priority" in candidate).toBe(false);
    expect(candidate.labels).toEqual([]);
  });

  it("marks a bead held by an open blocker, and clears it once the blocker is done", () => {
    const blocks = [{ issue_id: "a", depends_on_id: "gate", type: "blocks" }];
    const held = policyCandidates([
      bead({ id: "a", dependencies: blocks }),
      bead({ id: "gate", status: "open" }),
    ]);
    expect(held[0].blocked).toBe(true);

    const released = policyCandidates([
      bead({ id: "a", dependencies: blocks }),
      bead({ id: "gate", status: "closed" }),
    ]);
    expect(released[0].blocked).toBeUndefined();
  });

  it("leaves a bead with no blocks edge unmarked", () => {
    expect(policyCandidates([bead({ id: "a" })])[0].blocked).toBeUndefined();
  });
});
