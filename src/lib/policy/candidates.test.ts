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
      { id: "a", title: "a", type: "bug", priority: 1, depth: 0, labels: ["severity:major"] },
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

  it("counts parent hops, so a policy can say `parentless work only` (anton-hmyo)", () => {
    const board = [
      bead({ id: "epic" }),
      bead({ id: "feature", parent: "epic" }),
      bead({ id: "ticket", parent: "feature" }),
    ];
    const depths = Object.fromEntries(policyCandidates(board).map((c) => [c.id, c.depth]));
    expect(depths).toEqual({ epic: 0, feature: 1, ticket: 2 });
  });

  it("reports no depth when the chain leaves the board, rather than guessing top-level", () => {
    // The predicate fails an asserted parentage criterion closed on this. Defaulting it to 0 would
    // admit a nested bead as if it were parentless.
    const [orphan] = policyCandidates([bead({ id: "a", parent: "gone" })]);
    expect(orphan.depth).toBeUndefined();
  });

  it("survives a parent cycle a malformed board could hold", () => {
    const board = [bead({ id: "a", parent: "b" }), bead({ id: "b", parent: "a" })];
    expect(policyCandidates(board).map((c) => c.depth)).toEqual([undefined, undefined]);
  });

  it("ages a bead in whole days against the caller's clock, never its own", () => {
    const now = new Date("2026-08-29T12:00:00Z");
    const board = [
      bead({ id: "fresh", created_at: "2026-08-29T02:00:00Z" }),
      bead({ id: "soaked", created_at: "2026-08-27T13:00:00Z" }),
      bead({ id: "undated", created_at: undefined }),
    ];
    const ages = Object.fromEntries(policyCandidates(board, now).map((c) => [c.id, c.ageDays]));
    // Floored: "at least a day old" means a full day has passed, not that the hour rounded up.
    expect(ages).toEqual({ fresh: 0, soaked: 1, undated: undefined });
  });
});
