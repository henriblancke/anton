/**
 * The Up Next projection (anton-t9m4): the recorded plan joined to the board it was ranked over.
 *
 * What is pinned here is what the lane is allowed to CLAIM about a pick — its position, its
 * priority, its type, and how much open work it frees. Those four are the ranking's own inputs, so a
 * lane that computed them some other way would explain a position with numbers the ranking never
 * used.
 */
import { describe, expect, it } from "vitest";

import type { Bead } from "@/lib/beads/types";
import type { BoardPickerPlan, PickerPlanEntry } from "@/lib/board-picker-plan";
import { upNextEntries, upNextVersion } from "@/lib/up-next";

const AGE = "2026-08-01T00:00:00.000Z";

function bead(over: Partial<Bead> & { id: string }): Bead {
  return {
    title: over.title ?? `bead ${over.id}`,
    status: "open",
    issue_type: "feature",
    priority: 2,
    created_at: AGE,
    ...over,
  };
}

/** A `blocks` edge as bd inlines it: `dependent` waits on `blocker`. */
function blocks(dependent: string, blocker: string) {
  return { type: "blocks" as const, issue_id: dependent, depends_on_id: blocker };
}

function plan(entries: PickerPlanEntry[]): BoardPickerPlan {
  return {
    projectId: "p1",
    planId: "plan-1",
    generatedAt: 1_770_000_000,
    stamp: { observedAtMs: 1_770_000_000_000, digest: "abc", beadCount: entries.length },
    entries,
    exclusions: [],
  };
}

describe("upNextEntries", () => {
  it("has no lane at all without a recorded plan", () => {
    expect(upNextEntries([bead({ id: "anton-1" })], undefined)).toBeUndefined();
  });

  it("carries rank, priority, type, unblocking count and age for each pick", () => {
    const board = [
      bead({ id: "anton-hub", issue_type: "feature", priority: 1 }),
      bead({ id: "anton-leaf", issue_type: "bug", priority: 3 }),
      // Two open beads wait on the hub, one of them transitively.
      bead({ id: "anton-mid", status: "blocked", dependencies: [blocks("anton-mid", "anton-hub")] }),
      bead({ id: "anton-tail", status: "blocked", dependencies: [blocks("anton-tail", "anton-mid")] }),
    ];

    const entries = upNextEntries(
      board,
      plan([
        { beadId: "anton-hub", rank: 1, rule: "policy" },
        { beadId: "anton-leaf", rank: 2, rule: "policy" },
      ]),
    );

    // `createdAt` rides along for the ranking's age tiebreak: a drag inside the lane has to know
    // whether the order it asks for is one the priority channel can actually establish.
    expect(entries).toEqual([
      { beadId: "anton-hub", rank: 1, priority: 1, type: "feature", unblocks: 2, createdAt: AGE },
      { beadId: "anton-leaf", rank: 2, priority: 3, type: "bug", unblocks: 0, createdAt: AGE },
    ]);
  });

  it("orders by the recorded rank, whatever order the entries were stored in", () => {
    const board = [bead({ id: "anton-1" }), bead({ id: "anton-2" }), bead({ id: "anton-3" })];
    const entries = upNextEntries(
      board,
      plan([
        { beadId: "anton-3", rank: 3, rule: "policy" },
        { beadId: "anton-1", rank: 1, rule: "policy" },
        { beadId: "anton-2", rank: 2, rule: "policy" },
      ]),
    );

    expect(entries?.map((e) => e.beadId)).toEqual(["anton-1", "anton-2", "anton-3"]);
  });

  it("drops a pick the board no longer holds — the plan is history, the board is now", () => {
    const entries = upNextEntries(
      [bead({ id: "anton-1" })],
      plan([
        { beadId: "anton-1", rank: 1, rule: "policy" },
        { beadId: "anton-gone", rank: 2, rule: "policy" },
      ]),
    );

    expect(entries?.map((e) => e.beadId)).toEqual(["anton-1"]);
  });

  it("reports an undated pick as undated rather than dropping the age tiebreak", () => {
    const entries = upNextEntries(
      [bead({ id: "anton-1", created_at: undefined })],
      plan([{ beadId: "anton-1", rank: 1, rule: "policy" }]),
    );

    expect(entries?.[0].createdAt).toBe("");
  });

  it("leaves an unprioritized pick without a priority rather than inventing one", () => {
    const entries = upNextEntries(
      [bead({ id: "anton-1", priority: undefined })],
      plan([{ beadId: "anton-1", rank: 1, rule: "policy" }]),
    );

    expect(entries?.[0]).not.toHaveProperty("priority");
  });

  it("drops a pick the operator vetoed since the pass ran", () => {
    const entries = upNextEntries(
      [bead({ id: "anton-1" }), bead({ id: "anton-2" })],
      plan([
        { beadId: "anton-1", rank: 1, rule: "policy" },
        { beadId: "anton-2", rank: 2, rule: "policy" },
      ]),
      new Map([["anton-1", 1_770_000_100_000]]),
    );

    expect(entries?.map((e) => e.beadId)).toEqual(["anton-2"]);
  });

  it("records a plan that admitted nothing as an empty lane, not as no lane", () => {
    expect(upNextEntries([bead({ id: "anton-1" })], plan([]))).toEqual([]);
  });
});

describe("upNextVersion", () => {
  it("moves when the picker is disarmed, which changes no plan row at all", () => {
    expect(upNextVersion(true)).not.toBe(upNextVersion(false));
  });
});
