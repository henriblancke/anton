/**
 * The Up Next projection (anton-t9m4): a ranking joined to the board it was ranked over — the live
 * decision the board read derives (anton-r0ew), or the plan row a pass recorded, which are the same
 * shape here.
 *
 * What is pinned here is what the lane is allowed to CLAIM about a pick — its position, its
 * priority, its type, and how much open work it frees. Those four are the ranking's own inputs, so a
 * lane that computed them some other way would explain a position with numbers the ranking never
 * used.
 */
import { describe, expect, it } from "vitest";

import type { Bead } from "@/lib/beads/types";
import type { BoardPickerPlan, PickerPlanEntry } from "@/lib/board-picker-plan";
import {
  UP_NEXT_AGE_FENCE_MS,
  upNextAbsence,
  upNextEntries,
  upNextVersion,
} from "@/lib/up-next";

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
  it("has no lane at all without a ranking", () => {
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

  // A vetoed target never reaches here: `decideBoardPickerPlan` excludes it as `deferred` before it
  // ranks anything (picker-decision.test.ts), and re-subtracting vetoes in the projection would be a
  // second answer to a question the ranking already answered.

  it("records a ranking that admitted nothing as an empty lane, not as no lane", () => {
    expect(upNextEntries([bead({ id: "anton-1" })], plan([]))).toEqual([]);
  });
});

describe("upNextVersion", () => {
  const on = { scheduled: true, levelOffers: true, policyKnown: true };
  const NOW = 1_770_000_000_000;
  /** A policy whose admission is a function of the clock — the soak, and the stale end of it. */
  const soak = { minAgeDays: 2 };

  it("moves when the picker is disarmed, which changes no plan row at all", () => {
    expect(upNextVersion(on, undefined, NOW)).not.toBe(
      upNextVersion({ ...on, scheduled: false }, undefined, NOW),
    );
  });

  it("tells the two off states apart, so a poll cannot 304 onto the wrong absence", () => {
    // Disarming a `propose` project moves no bead, no plan row and no policy — only this token.
    expect(upNextVersion({ ...on, scheduled: false }, undefined, NOW)).not.toBe(
      upNextVersion({ ...on, levelOffers: false }, undefined, NOW),
    );
  });

  it("moves when the policy read fails, so the lane comes back when it recovers", () => {
    // The withheld ranking and the one the same armed policy produces touch no bead, no plan row and
    // no policy — a token that ignored this would 304 the operator onto the absence indefinitely.
    expect(upNextVersion({ ...on, policyKnown: false }, undefined, NOW)).not.toBe(
      upNextVersion(on, undefined, NOW),
    );
  });

  it("moves with the clock under an age criterion, whose day boundary nothing else records", () => {
    // A bead crossing `minAgeDays` enters the derived ranking while every bead, setting, plan row and
    // hold sits still — the one input of the lane that moves on its own (PR #226 review).
    expect(upNextVersion(on, soak, NOW)).not.toBe(
      upNextVersion(on, soak, NOW + UP_NEXT_AGE_FENCE_MS),
    );
    expect(upNextVersion(on, { maxAgeDays: 30 }, NOW)).not.toBe(
      upNextVersion(on, { maxAgeDays: 30 }, NOW + UP_NEXT_AGE_FENCE_MS),
    );
  });

  it("holds still within the fence, so an age policy still 304s between boundaries", () => {
    // The token is a 304 gate: carrying the raw clock would move it on every poll and no board would
    // ever serve a 304 again.
    expect(upNextVersion(on, soak, NOW)).toBe(upNextVersion(on, soak, NOW + 1_000));
  });

  it("ignores the clock for a policy that says nothing about age", () => {
    // Nothing else the ranking reads changes with time, so an ordinary board polls exactly as before.
    const armed = { types: ["feature"], maxPriority: 2 };
    expect(upNextVersion(on, armed, NOW)).toBe(upNextVersion(on, armed, NOW + 86_400_000));
    expect(upNextVersion(on, undefined, NOW)).toBe(upNextVersion(on, undefined, NOW + 86_400_000));
  });
});

/**
 * Which absence the lane names (anton-w579). Only the ones an operator can clear get a name: the
 * lane holds its column for those and says what would fill it, while a ranking simply withheld stays
 * out of the layout rather than telling the operator to act on a wait.
 */
describe("upNextAbsence", () => {
  const armed = { scheduled: true, levelOffers: true, policyKnown: true };

  it("names a disarmed pass ahead of the level, since nothing runs to reach it", () => {
    expect(upNextAbsence({ ...armed, scheduled: false, levelOffers: false }, undefined)).toBe(
      "disarmed",
    );
    expect(upNextAbsence({ ...armed, scheduled: false }, undefined)).toBe("disarmed");
  });

  it("names the level when the pass runs but promises nothing offered", () => {
    expect(upNextAbsence({ ...armed, levelOffers: false }, undefined)).toBe("proposes-only");
  });

  it("names an unreadable policy ahead of the level, which came from the same failed read", () => {
    // "It offers" is fail-soft guesswork once the settings read threw; what is actually true is that
    // anton cannot see the policy, and that is what the lane must say (PR #226 review).
    expect(upNextAbsence({ ...armed, policyKnown: false, levelOffers: true }, undefined)).toBe(
      "policy-unreadable",
    );
    expect(upNextAbsence({ ...armed, policyKnown: false, levelOffers: false }, undefined)).toBe(
      "policy-unreadable",
    );
  });

  it("names an empty ranking as a board with nothing claimable on it", () => {
    expect(upNextAbsence(armed, [])).toBe("no-claimable-work");
  });

  it("names nothing for a ranking that was withheld rather than empty", () => {
    // No plan recorded, or one the board has moved past: the next pass clears it, not the operator.
    expect(upNextAbsence(armed, undefined)).toBeUndefined();
  });

  it("names nothing while there is a lane to draw", () => {
    expect(
      upNextAbsence(armed, [
        { beadId: "anton-1", rank: 1, type: "feature", unblocks: 0, createdAt: AGE },
      ]),
    ).toBeUndefined();
  });
});
