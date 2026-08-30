/**
 * The pass itself (anton-albm, R1.2): eligibility → policy → ranking, composed into one plan.
 *
 * The pieces are pinned by their own suites (picker-targets, beads/rank, board-picker-plan); what is
 * pinned HERE is that they are actually wired together, in that order, and that the plan a surface
 * reads carries what it needs — a rank per target, the rule that admitted it, and a reason for every
 * candidate left out. Purity is asserted the way the rest of the picker asserts it: nothing on this
 * path may spawn a process.
 */
import { describe, expect, it, vi } from "vitest";
import type { Bead, BeadDep } from "../beads/bd";
import { decideBoardPickerPlan, ADMIT_ALL_POLICY, type PickerPolicy } from "./picker-decision";

const spawned = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawned,
}));

const OBSERVED = 1_800_000_000_000;

/**
 * A bead a real `bd` read produced: dated (the ranking's age input) and contract-shaped, so the
 * approve gate has nothing to fault and each case tests the one rule it is about.
 */
function bead(id: string, o: Partial<Bead> = {}): Bead {
  return {
    id,
    title: id,
    status: "open",
    issue_type: "task",
    created_at: "2026-08-01T00:00:00Z",
    description: "## Goal\n\nShip it.\n",
    acceptance_criteria: "- [ ] it ships",
    ...o,
  };
}

/** A `blocks` edge as bd inlines it: from = the dependent, to = the blocker. */
const blockedBy = (dependent: string, blocker: string): BeadDep => ({
  issue_id: dependent,
  depends_on_id: blocker,
  type: "blocks",
});

const decide = (board: Bead[], policy: PickerPolicy = ADMIT_ALL_POLICY) =>
  decideBoardPickerPlan({ board, policy, runtime: { observedAtMs: OBSERVED } });

describe("decideBoardPickerPlan", () => {
  it("ranks the claimable set in the PRIME order and numbers it from 1", () => {
    // P0 first, then unblocking value, then age. `t4` is the only bead here that frees other work,
    // so it outranks the older `t2` despite being younger — the whole reason the rank is not a date.
    const board = [
      bead("t1", { priority: 2, created_at: "2026-08-05T00:00:00Z" }),
      bead("t2", { priority: 1, created_at: "2026-08-01T00:00:00Z" }),
      bead("t3", { priority: 0, created_at: "2026-08-09T00:00:00Z" }),
      bead("t4", {
        priority: 1,
        created_at: "2026-08-07T00:00:00Z",
        dependencies: [blockedBy("t1", "t4")],
      }),
    ];

    const plan = decide(board);

    expect(plan.entries.map((e) => e.beadId)).toEqual(["t3", "t4", "t2"]);
    expect(plan.entries.map((e) => e.rank)).toEqual([1, 2, 3]);
    // `t1` is what `t4` unblocks, so it is ranked ON but not IN the plan — value comes from work
    // the eligible set does not contain.
    expect(plan.exclusions).toContainEqual(
      expect.objectContaining({ beadId: "t1", reason: "blocked" }),
    );
  });

  it("records the rule that admitted each target, so a start stays auditable", () => {
    const policy: PickerPolicy = {
      admits: (target) =>
        target.issue_type === "bug"
          ? { admitted: true, rule: "type ∈ {bug}" }
          : { admitted: false, detail: "type ∉ {bug}" },
    };

    const plan = decide([bead("b1", { issue_type: "bug" }), bead("t1")], policy);

    expect(plan.entries).toEqual([{ beadId: "b1", rank: 1, rule: "type ∈ {bug}" }]);
    // A bead the BOARD would have allowed and the POLICY would not is excluded as `policy`, with the
    // criterion that refused it — that is what "why not this one?" reads (R2.6).
    expect(plan.exclusions).toContainEqual({
      beadId: "t1",
      reason: "policy",
      detail: "type ∉ {bug}",
    });
  });

  it("keeps the structural refusals beside the policy ones, each with its reason", () => {
    const board = [
      bead("t1", { assignee: "someone" }),
      bead("t2", { dependencies: [blockedBy("t2", "c1")] }),
      bead("t3", { status: "closed" }),
      bead("c1", { issue_type: "chore" }),
      bead("t4"),
    ];

    const plan = decide(board);

    expect(plan.entries.map((e) => e.beadId)).toEqual(["t4"]);
    expect(plan.exclusions.map((x) => [x.beadId, x.reason])).toEqual([
      ["c1", "not-a-run-target"],
      ["t1", "claimed"],
      ["t2", "blocked"],
    ]);
    // t3 is closed: refused, but never reported. Nobody asks why finished work is not up next.
    expect(plan.exclusions.some((x) => x.beadId === "t3")).toBe(false);
  });

  it("is a function of its inputs — the same board in any order decides the same plan", () => {
    // Determinism is load-bearing, not a nicety: two machines reading one board must name the same
    // target, and `bd list` promises no order at all.
    const board = [bead("t1", { priority: 1 }), bead("t2", { priority: 1 }), bead("t3")];

    const plan = decide(board);
    const reversed = decide([...board].reverse());

    expect(reversed).toEqual(plan);
    expect(reversed.stamp.digest).toBe(plan.stamp.digest);
  });

  it("stamps the snapshot it decided over, at the instant the caller observed it", () => {
    const plan = decide([bead("t1"), bead("t2")]);

    expect(plan.stamp.observedAtMs).toBe(OBSERVED);
    expect(plan.stamp.beadCount).toBe(2);
    // A board that moved decides a plan the lane can tell apart from this one.
    expect(decide([bead("t1"), bead("t2", { priority: 0 })]).stamp.digest).not.toBe(
      plan.stamp.digest,
    );
  });

  it("decides an EMPTY plan on a board with nothing claimable, rather than no plan", () => {
    // "Decided, nothing to start" is an answer; the lane renders it, and it must not read as
    // "the pass never ran".
    const plan = decide([bead("t1", { status: "closed" })]);

    expect(plan.entries).toEqual([]);
    expect(plan.stamp.beadCount).toBe(1);
  });

  it("never shells out — the decision costs no bd call", () => {
    decide([bead("t1"), bead("t2", { issue_type: "feature" })]);
    expect(spawned).not.toHaveBeenCalled();
  });
});
