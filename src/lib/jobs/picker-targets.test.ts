/**
 * Eligibility (anton-o76r): "may anton take this?", asserted against hand-built boards.
 *
 * Two things are pinned here and both are load-bearing for a pass that writes `approved` on its own
 * authority: the SET — nothing enters it that the runner would then refuse — and the REASON on
 * everything left out, because the policy editor and the Up Next lane answer "why not this one?"
 * from these strings (R2.6) and a surface cannot parse a verdict that was never recorded.
 */
import { describe, expect, it, vi } from "vitest";
import { LABELS, type Bead, type BeadDep } from "../beads/bd";
import type { PickerExclusionReason } from "../board-picker-plan";
import { eligibleTargets, ineligibility } from "./picker-targets";

// Nothing in the decision may shell out: it is a pure function of a snapshot, and a `bd` spawn on
// the picker's tick is the cost the whole mechanical-picker design exists to avoid (D3).
const spawned = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawned,
}));

/**
 * A bead as `bd list --json` carries it. No `description`/`created_at` by default, which is bd's own
 * "this projection never carried the contract fields" shape — so the contract is not faulted and
 * each case tests the one rule it is about. The contract cases opt in below.
 */
function bead(id: string, o: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "task", ...o };
}

/** A `blocks` edge as bd inlines it: from = the dependent, to = the blocker. */
const blockedBy = (dependent: string, blocker: string): BeadDep => ({
  issue_id: dependent,
  depends_on_id: blocker,
  type: "blocks",
});

/** A bead a bd read genuinely produced, so the contract applies to it. */
const authored = (id: string, o: Partial<Bead> = {}): Bead =>
  bead(id, {
    created_at: "2026-08-01T00:00:00Z",
    description: "## Goal\n\nShip it.\n",
    acceptance_criteria: "- [ ] it ships",
    ...o,
  });

interface Case {
  name: string;
  board: Bead[];
  eligible: string[];
  exclusions: { beadId: string; reason: PickerExclusionReason; detail?: RegExp }[];
}

const cases: Case[] = [
  {
    name: "a container epic is refused and its feature admitted — each feature is its own run",
    board: [bead("e1", { issue_type: "epic" }), bead("f1", { issue_type: "feature", parent: "e1" })],
    eligible: ["f1"],
    exclusions: [{ beadId: "e1", reason: "not-a-run-target", detail: /container epic/ }],
  },
  {
    name: "a childless epic stays a run target — the legacy shape still runs",
    board: [bead("e1", { issue_type: "epic" }), bead("t1", { parent: "e1" })],
    eligible: ["e1"],
    exclusions: [{ beadId: "t1", reason: "not-a-run-target", detail: /sits under e1/ }],
  },
  {
    name: "a parentless task and bug are admitted as epics-of-one",
    board: [bead("t1"), bead("b1", { issue_type: "bug" })],
    eligible: ["t1", "b1"],
    exclusions: [],
  },
  {
    name: "a chore and the pipeline's own plumbing are never runnable on their own",
    board: [
      bead("c1", { issue_type: "chore" }),
      bead("m1", { issue_type: "molecule" }),
      bead("g1", { issue_type: "gate" }),
    ],
    eligible: [],
    exclusions: [
      { beadId: "c1", reason: "not-a-run-target", detail: /"chore" is not runnable/ },
      { beadId: "m1", reason: "not-a-run-target" },
      { beadId: "g1", reason: "not-a-run-target" },
    ],
  },
  {
    name: "a feature a human claimed is never taken back, and names who holds it",
    board: [
      bead("f1", { issue_type: "feature", assignee: "alice" }),
      // bd's unclaimed is a blank assignee, not an absent field.
      bead("f2", { issue_type: "feature", assignee: "  " }),
    ],
    eligible: ["f2"],
    exclusions: [{ beadId: "f1", reason: "claimed", detail: /held by alice/ }],
  },
  {
    name: "only `open` is free work — in flight and deferred each report their status",
    board: [
      bead("t1", { status: "in_progress" }),
      bead("t2", { status: "deferred" }),
      bead("t3"),
    ],
    eligible: ["t3"],
    exclusions: [
      { beadId: "t1", reason: "not-open", detail: /in_progress/ },
      { beadId: "t2", reason: "not-open", detail: /deferred/ },
    ],
  },
  {
    name: "an abandoned target says so — a crashed cascade can leave the label on an OPEN bead",
    board: [bead("t1", { labels: [LABELS.abandoned] })],
    eligible: [],
    exclusions: [{ beadId: "t1", reason: "abandoned" }],
  },
  {
    name: "a blocked target waits and its blocker is what the pass would start",
    board: [bead("t1", { dependencies: [blockedBy("t1", "t2")] }), bead("t2")],
    eligible: ["t2"],
    exclusions: [{ beadId: "t1", reason: "blocked", detail: /blocked by t2/ }],
  },
  {
    name: "an authored bead with no Acceptance fails approval's contract promise",
    board: [authored("t1", { acceptance_criteria: undefined, description: "## Goal\n\nShip it.\n" })],
    eligible: [],
    exclusions: [{ beadId: "t1", reason: "approval-gap", detail: /no Acceptance criteria/ }],
  },
  {
    // Scoped to the subtree, exactly as the approve route scopes it: the malformed feature withdraws
    // its own eligibility AND the target that owns it, while unrelated work is untouched.
    name: "a feature hanging off a ticket fails approval's structure promise, for it and its owner",
    board: [authored("f1", { issue_type: "feature", parent: "t1" }), authored("t1"), authored("t9")],
    eligible: ["t9"],
    exclusions: [
      { beadId: "f1", reason: "approval-gap", detail: /not an epic/ },
      { beadId: "t1", reason: "approval-gap", detail: /not an epic/ },
    ],
  },
  {
    name: "an authored, unblocked, unclaimed run target is eligible without carrying `approved`",
    // The picker WRITES the label (R1.5), so requiring it would leave the pass nothing to start.
    board: [authored("t1"), authored("t2", { labels: [LABELS.approved] })],
    eligible: ["t1", "t2"],
    exclusions: [],
  },
];

describe("eligibleTargets", () => {
  for (const c of cases) {
    it(c.name, () => {
      const { eligible, exclusions } = eligibleTargets(c.board);

      expect(eligible.map((b) => b.id)).toEqual(c.eligible);
      expect(exclusions.map((e) => ({ beadId: e.beadId, reason: e.reason }))).toEqual(
        c.exclusions.map(({ beadId, reason }) => ({ beadId, reason })),
      );
      for (const expected of c.exclusions) {
        if (!expected.detail) continue;
        const actual = exclusions.find((e) => e.beadId === expected.beadId);
        expect(actual?.detail ?? "").toMatch(expected.detail);
      }
    });
  }

  it("refuses closed work without reporting it — nobody asks why finished work is not up next", () => {
    const board = [bead("t1", { status: "closed" }), bead("t2")];

    const { eligible, exclusions } = eligibleTargets(board);

    expect(eligible.map((b) => b.id)).toEqual(["t2"]);
    expect(exclusions).toEqual([]);
  });

  it("accounts for every live bead — each is either eligible or refused with a reason", () => {
    const board = [
      bead("e1", { issue_type: "epic" }),
      bead("f1", { issue_type: "feature", parent: "e1", assignee: "alice" }),
      bead("t1", { parent: "f1" }),
      bead("t2", { status: "deferred" }),
      bead("t3"),
    ];

    const { eligible, exclusions } = eligibleTargets(board);

    expect([...eligible.map((b) => b.id), ...exclusions.map((e) => e.beadId)].sort()).toEqual([
      "e1",
      "f1",
      "t1",
      "t2",
      "t3",
    ]);
    expect(exclusions.every((e) => e.reason.length > 0)).toBe(true);
  });

  it("is pure — the same snapshot decides the same way, and nothing spawns bd", () => {
    const board = [
      bead("e1", { issue_type: "epic" }),
      bead("f1", { issue_type: "feature", parent: "e1" }),
      bead("t1", { dependencies: [blockedBy("t1", "f1")] }),
    ];

    expect(eligibleTargets(board)).toEqual(eligibleTargets(board));
    expect(spawned).not.toHaveBeenCalled();
  });

  it("leaves the set in board order — the PRIME ranking owns the sequence", () => {
    const board = [bead("t3"), bead("t1"), bead("t2")];

    expect(eligibleTargets(board).eligible.map((b) => b.id)).toEqual(["t3", "t1", "t2"]);
  });
});

describe("ineligibility", () => {
  it("answers for one bead without a bound gate — the surface's `why not this one?`", () => {
    const board = [bead("e1", { issue_type: "epic" }), bead("f1", { issue_type: "feature", parent: "e1" })];

    expect(ineligibility(board[0], board)).toMatchObject({
      beadId: "e1",
      reason: "not-a-run-target",
    });
    expect(ineligibility(board[1], board)).toBeUndefined();
  });

  it("reports the worst-scoped reason and carries every gap in the detail", () => {
    // Blocked AND missing its rubric: naming only one would send the operator back for the other.
    const board = [
      authored("t1", { acceptance_criteria: undefined, dependencies: [blockedBy("t1", "t2")] }),
      authored("t2"),
    ];

    const excluded = ineligibility(board[0], board);

    expect(excluded?.reason).toBe("approval-gap");
    expect(excluded?.detail).toMatch(/no Acceptance criteria/);
    expect(excluded?.detail).toMatch(/blocked by t2/);
  });
});
