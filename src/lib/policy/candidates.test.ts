/**
 * The board → candidate projection (anton-qsr1). Two claims worth pinning: the editor counts the
 * work anton could actually START — the structurally eligible set, never a container epic, a child
 * ticket, a claimed target or one held by a blocker — and everything else on the board is reported
 * as a count rather than dropped, so the panel's shrunken denominator is explained.
 *
 * The eligibility gate is the picker's own ({@link eligibleTargets}), because a panel that
 * disagreed with it would claim available work where the picker has none.
 */
import { describe, expect, it } from "vitest";
import type { Bead } from "../beads/types";
import { policyCandidates } from "./candidates";

/** A dated, contract-shaped bead — nothing for the approve gate to fault. */
const bead = (o: Partial<Bead> & { id: string }): Bead => ({
  title: o.id,
  status: "open",
  issue_type: "task",
  created_at: "2026-08-01T00:00:00Z",
  description: "## Goal\n\nShip it.\n",
  acceptance_criteria: "- [ ] it ships",
  ...o,
});

const ids = (board: Bead[], now?: Date) => policyCandidates(board, now).candidates.map((c) => c.id);

describe("policyCandidates", () => {
  it("projects only startable beads, with the fields the predicate reads", () => {
    const now = new Date("2026-08-11T00:00:00Z");
    const board = [
      bead({ id: "a", issue_type: "bug", priority: 1, labels: ["severity:major"] }),
      bead({ id: "b", status: "closed" }),
      bead({ id: "c", status: "in_progress" }),
    ];
    expect(policyCandidates(board, now).candidates).toEqual([
      {
        id: "a",
        title: "a",
        type: "bug",
        priority: 1,
        depth: 0,
        ageDays: 10,
        labels: ["severity:major"],
      },
    ]);
  });

  it("omits a priority the bead does not carry, rather than inventing one", () => {
    // Type is never absent here — a bead with no issue_type is not a run target — but priority and
    // labels are, and an asserted criterion has to fail closed on them rather than on a default.
    const { candidates } = policyCandidates([bead({ id: "a", priority: undefined })]);
    expect("priority" in candidates[0]).toBe(false);
    expect(candidates[0].labels).toEqual([]);
  });

  it("withholds a target the picker would refuse before any policy is consulted", () => {
    // Assigned, and short of the approve contract: neither can be started, so counting either would
    // let the panel claim available work the picker has none of.
    const board = [
      bead({ id: "free" }),
      bead({ id: "held", assignee: "someone" }),
      bead({ id: "unshaped", description: "", acceptance_criteria: "" }),
    ];
    const { candidates, notStartable } = policyCandidates(board);
    expect(candidates.map((c) => c.id)).toEqual(["free"]);
    // Reported, not silently dropped — the panel explains why its denominator is smaller than the
    // board rather than looking like a board with less work on it.
    expect(notStartable).toBe(2);
  });

  it("withholds a target held by an open blocker, and admits it once the blocker lands", () => {
    const blocks = [{ issue_id: "a", depends_on_id: "gate", type: "blocks" }];
    const held = policyCandidates([
      bead({ id: "a", dependencies: blocks }),
      bead({ id: "gate", status: "open" }),
    ]);
    expect(held.candidates.map((c) => c.id)).toEqual(["gate"]);
    expect(held.notStartable).toBe(1);

    const released = policyCandidates([
      bead({ id: "a", dependencies: blocks }),
      bead({ id: "gate", status: "closed" }),
    ]);
    expect(released.candidates.map((c) => c.id)).toEqual(["a"]);
    expect(released.notStartable).toBe(0);
  });

  it("withholds a unit blocked by a blocker on one of its own children (anton-qsr1)", () => {
    // The blocks edge names the CHILD, so a per-bead read of the edges would call the feature
    // startable while the approve route refuses it — the panel has to agree with the gate.
    const board = [
      bead({ id: "feature", issue_type: "feature" }),
      bead({
        id: "ticket",
        parent: "feature",
        dependencies: [{ issue_id: "ticket", depends_on_id: "gate", type: "blocks" }],
      }),
      bead({ id: "gate", status: "open" }),
    ];
    expect(ids(board)).toEqual(["gate"]);
  });

  it("keeps a unit whose children can still run", () => {
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
    expect(ids(board)).toContain("feature");
  });

  it("counts parent hops, so a policy can say `parentless work only` (anton-hmyo)", () => {
    const board = [
      bead({ id: "epic", issue_type: "epic" }),
      bead({ id: "sub", issue_type: "epic", parent: "epic" }),
      bead({ id: "standalone" }),
    ];
    const depths = Object.fromEntries(
      policyCandidates(board).candidates.map((c) => [c.id, c.depth]),
    );
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
    expect(ids(board)).toEqual(["feature", "standalone"]);
    // A container epic and a child ticket were never startable work, so neither counts against the
    // denominator the panel explains.
    expect(policyCandidates(board).notStartable).toBe(0);
  });

  it("reports no depth when the chain leaves the board, rather than guessing top-level", () => {
    // The predicate fails an asserted parentage criterion closed on this. Defaulting it to 0 would
    // admit a nested bead as if it were parentless.
    const { candidates } = policyCandidates([
      bead({ id: "a", issue_type: "feature", parent: "gone" }),
    ]);
    expect(candidates[0].depth).toBeUndefined();
  });

  it("survives a parent cycle a malformed board could hold", () => {
    // Features, so both stay run targets: a task with a parent is a child ticket and never projected.
    // The gate refuses the pair, and the walk that counts their parent hops terminates rather than
    // following the cycle forever.
    const board = [
      bead({ id: "a", issue_type: "feature", parent: "b" }),
      bead({ id: "b", issue_type: "feature", parent: "a" }),
    ];
    expect(policyCandidates(board)).toEqual({ candidates: [], notStartable: 2 });
  });

  it("ages a bead in whole days against the caller's clock, never its own", () => {
    const now = new Date("2026-08-29T12:00:00Z");
    const board = [
      bead({ id: "fresh", created_at: "2026-08-29T02:00:00Z" }),
      bead({ id: "soaked", created_at: "2026-08-27T13:00:00Z" }),
      bead({ id: "undated", created_at: undefined }),
    ];
    const ages = Object.fromEntries(
      policyCandidates(board, now).candidates.map((c) => [c.id, c.ageDays]),
    );
    // Floored: "at least a day old" means a full day has passed, not that the hour rounded up.
    expect(ages).toEqual({ fresh: 0, soaked: 1, undated: undefined });
  });
});
