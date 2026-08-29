/**
 * The board → candidate projection (anton-qsr1). Two claims worth pinning: the editor counts the OPEN
 * work anton could actually start — run targets, never container epics or child tickets — and its
 * blockedness is the same verdict the approve route and the runner enforce, since a panel that
 * disagreed with them about "has an unmet blocker" would explain the wrong refusal.
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

  it("omits a priority the bead does not carry, rather than inventing one", () => {
    // Type is never absent here — a bead with no issue_type is not a run target — but priority and
    // labels are, and an asserted criterion has to fail closed on them rather than on a default.
    const [candidate] = policyCandidates([bead({ id: "a", priority: undefined })]);
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
      bead({ id: "epic", issue_type: "epic" }),
      bead({ id: "sub", issue_type: "epic", parent: "epic" }),
      bead({ id: "standalone" }),
    ];
    const depths = Object.fromEntries(policyCandidates(board).map((c) => [c.id, c.depth]));
    expect(depths).toEqual({ epic: 0, sub: 1, standalone: 0 });
  });

  it("projects only what the picker could start — no container epics, no child tickets", () => {
    // The same isRunTarget gate the approve route enforces: an epic that groups features runs
    // nothing itself, and a ticket under a feature runs as part of that feature's run.
    const board = [
      bead({ id: "container", issue_type: "epic" }),
      bead({ id: "feature", issue_type: "feature", parent: "container" }),
      bead({ id: "ticket", parent: "feature" }),
      bead({ id: "chore", issue_type: "chore" }),
      bead({ id: "standalone", issue_type: "bug" }),
    ];
    expect(policyCandidates(board).map((c) => c.id)).toEqual(["feature", "standalone"]);
  });

  it("marks a unit blocked by a blocker on one of its own children (anton-qsr1)", () => {
    // The blocks edge names the CHILD, so a per-bead read of the edges would call the feature ready
    // while the approve route refuses it — the panel's count has to agree with the gate.
    const board = [
      bead({ id: "feature", issue_type: "feature" }),
      bead({
        id: "ticket",
        parent: "feature",
        dependencies: [{ issue_id: "ticket", depends_on_id: "gate", type: "blocks" }],
      }),
      bead({ id: "gate", status: "open" }),
    ];
    const blocked = Object.fromEntries(policyCandidates(board).map((c) => [c.id, c.blocked]));
    expect(blocked).toEqual({ feature: true, gate: undefined });
  });

  it("leaves a unit unblocked while one of its children can still run", () => {
    const board = [
      bead({ id: "feature", issue_type: "feature" }),
      bead({
        id: "held",
        parent: "feature",
        dependencies: [{ issue_id: "held", depends_on_id: "gate", type: "blocks" }],
      }),
      bead({ id: "free", parent: "feature" }),
      bead({ id: "gate", status: "open" }),
    ];
    expect(policyCandidates(board).find((c) => c.id === "feature")?.blocked).toBeUndefined();
  });

  it("reports no depth when the chain leaves the board, rather than guessing top-level", () => {
    // The predicate fails an asserted parentage criterion closed on this. Defaulting it to 0 would
    // admit a nested bead as if it were parentless.
    const [orphan] = policyCandidates([bead({ id: "a", issue_type: "feature", parent: "gone" })]);
    expect(orphan.depth).toBeUndefined();
  });

  it("survives a parent cycle a malformed board could hold", () => {
    // Features, so both stay run targets: a task with a parent is a child ticket and never projected.
    const board = [
      bead({ id: "a", issue_type: "feature", parent: "b" }),
      bead({ id: "b", issue_type: "feature", parent: "a" }),
    ];
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
