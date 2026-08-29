/**
 * First-arm calibration (anton-c7iv), asserted against synthetic approval histories.
 *
 * Three claims are pinned, and each is a promise the panel makes to an operator's face:
 *
 *  1. A draft fitted to history ADMITS that history — every sampled approval satisfies the policy
 *     proposed from it. A proposal that would have refused the operator's own past decisions is not
 *     a recommendation, it is a bug with a paragraph of prose attached.
 *  2. Thin evidence yields the fallback, unfitted. A policy read off three beads is noise.
 *  3. Every criterion names the approvals behind it, so "why this?" has an answer on the screen.
 *
 * The boards below deliberately speak vocabularies anton does not ship (`severity:`, `team:`): the
 * derivation reads whatever the repo already says, which is where R2.8's agnosticism comes from.
 */
import { describe, expect, it } from "vitest";
import { LABELS, type Bead } from "../beads/bd";
import { pickerPolicySchema } from "../projects";
import { boardIssueTypes, calibratePolicy, FALLBACK_POLICY, MIN_CALIBRATION_APPROVALS } from "./calibrate";
import { namespaceOf, valueOf, type Policy } from "./types";

let seq = 0;

/** An approved bead, as `bd list --json` carries one. */
function approved(o: Partial<Bead> = {}): Bead {
  const id = `b${++seq}`;
  return {
    id,
    title: id,
    status: "closed",
    issue_type: "bug",
    priority: 1,
    created_at: "2026-08-01T00:00:00Z",
    ...o,
    labels: [LABELS.approved, ...(o.labels ?? [])],
  };
}

/** A bead nobody approved — the board around the history, which the namespace test compares against. */
function unapproved(o: Partial<Bead> = {}): Bead {
  const id = `u${++seq}`;
  return { id, title: id, status: "open", issue_type: "task", priority: 1, ...o };
}

const many = (n: number, make: (i: number) => Bead): Bead[] =>
  Array.from({ length: n }, (_, i) => make(i));

/**
 * The policy predicate, in the form this ticket's promise needs it: membership, a priority floor,
 * and fail-closed on a missing namespace. Deliberately local — the shipped predicate is its own
 * ticket (anton-hmyo), and the claim here is about what calibration PROPOSES, which has to be
 * checkable without waiting for it.
 */
function admits(policy: Policy, bead: Bead): boolean {
  if (policy.types && !(bead.issue_type && policy.types.includes(bead.issue_type))) return false;
  if (
    policy.maxPriority !== undefined &&
    !(typeof bead.priority === "number" && bead.priority <= policy.maxPriority)
  ) {
    return false;
  }
  return (policy.labels ?? []).every((c) =>
    (bead.labels ?? []).some((l) => {
      const value = valueOf(l);
      return namespaceOf(l) === c.namespace && !!value && c.values.includes(value);
    }),
  );
}

describe("calibratePolicy — a clear pattern", () => {
  // A board whose approvals are unmistakably one shape: bugs and chores, never below P2, always
  // `severity:` (a vocabulary anton has never heard of), and only ever two of its three values.
  const history = [
    ...many(4, () => approved({ issue_type: "bug", priority: 0, labels: ["severity:critical"] })),
    ...many(4, () => approved({ issue_type: "chore", priority: 2, labels: ["severity:major"] })),
  ];
  const board = [
    ...history,
    unapproved({ issue_type: "feature", priority: 3, labels: ["severity:minor"] }),
    unapproved({ issue_type: "epic", priority: 3, labels: ["severity:major"] }),
  ];
  const draft = calibratePolicy(board);

  it("fits the criteria to what was approved, in the board's own words", () => {
    expect(draft.basis).toBe("history");
    expect(draft.approvals).toBe(8);
    expect(draft.policy.types).toEqual(["bug", "chore"]);
    // The floor is the LEAST urgent approval, so the criterion covers the whole sample.
    expect(draft.policy.maxPriority).toBe(2);
    expect(draft.policy.labels).toEqual([{ namespace: "severity", values: ["critical", "major"] }]);
    expect(draft.policy.requireUnblocked).toBe(true);
  });

  it("proposes a policy that would have admitted every one of those approvals", () => {
    for (const approval of history) expect(admits(draft.policy, approval)).toBe(true);
  });

  it("stays narrower than the board — the proposal is a boundary, not a rubber stamp", () => {
    const outside = board.filter((b) => !b.labels?.includes(LABELS.approved));
    for (const bead of outside) expect(admits(draft.policy, bead)).toBe(false);
  });

  it("cites the approvals behind each criterion", () => {
    const cited = (criterion: string) =>
      draft.rationale.find((r) => r.criterion === criterion)?.citedBeadIds ?? [];
    const approvalIds = new Set(history.map((b) => b.id));
    for (const criterion of ["types", "priority", "labels:severity"]) {
      const ids = cited(criterion);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(approvalIds.has(id)).toBe(true);
    }
    // Every criterion the policy states is explained — a control with no "why" is a blank form again.
    expect(draft.rationale.map((r) => r.criterion).sort()).toEqual([
      "blockers",
      "labels:severity",
      "priority",
      "types",
    ]);
    expect(draft.rationale.find((r) => r.criterion === "types")?.summary).toContain("bug and chore");
    expect(draft.rationale.find((r) => r.criterion === "priority")?.summary).toContain("P2");
  });
});

describe("calibratePolicy — thin evidence", () => {
  it("falls back to the conservative universal default under ~5 approvals", () => {
    const board = many(MIN_CALIBRATION_APPROVALS - 1, () =>
      approved({ issue_type: "feature", priority: 3, labels: ["team:payments"] }),
    );
    const draft = calibratePolicy(board);

    expect(draft.basis).toBe("fallback");
    expect(draft.approvals).toBe(4);
    // Nothing of the (real but too small) history leaks into the proposal.
    expect(draft.policy).toEqual(FALLBACK_POLICY);
    expect(draft.policy.labels).toBeUndefined();
  });

  it("fits the history the moment there is enough of it", () => {
    const board = many(MIN_CALIBRATION_APPROVALS, () =>
      approved({ issue_type: "feature", priority: 3 }),
    );
    expect(calibratePolicy(board).basis).toBe("history");
  });

  it("says how little history it found, and cites it", () => {
    const board = [approved({ id: "only-one" })];
    const draft = calibratePolicy(board);
    const types = draft.rationale.find((r) => r.criterion === "types");
    expect(types?.summary).toContain("Only 1 prior approval");
    expect(types?.citedBeadIds).toEqual(["only-one"]);
  });

  it("proposes the fallback on an empty board rather than nothing at all", () => {
    const draft = calibratePolicy([]);
    expect(draft.policy).toEqual(FALLBACK_POLICY);
    expect(draft.approvals).toBe(0);
  });
});

describe("calibratePolicy — what counts as history", () => {
  it("ignores approvals the operator took back", () => {
    const board = [
      ...many(5, () => approved({ issue_type: "bug", priority: 1 })),
      approved({ issue_type: "feature", priority: 4, labels: [LABELS.abandoned] }),
    ];
    const draft = calibratePolicy(board);
    expect(draft.approvals).toBe(5);
    expect(draft.policy.types).toEqual(["bug"]);
    expect(draft.policy.maxPriority).toBe(1);
  });

  it("ignores beads nobody approved", () => {
    const board = [...many(5, () => approved()), ...many(20, () => unapproved())];
    expect(calibratePolicy(board).approvals).toBe(5);
  });
});

describe("calibratePolicy — a criterion it cannot state is not stated", () => {
  it("omits type when an approval carries none, rather than failing closed on its own evidence", () => {
    const board = [...many(5, () => approved()), approved({ issue_type: undefined })];
    const draft = calibratePolicy(board);
    expect(draft.policy.types).toBeUndefined();
    expect(draft.rationale.map((r) => r.criterion)).not.toContain("types");
  });

  it("omits priority when an approval carries none", () => {
    const board = [...many(5, () => approved()), approved({ priority: undefined })];
    const draft = calibratePolicy(board);
    expect(draft.policy.maxPriority).toBeUndefined();
    expect(draft.rationale.map((r) => r.criterion)).not.toContain("priority");
  });

  it("omits a namespace only some approvals carry", () => {
    const board = [
      ...many(4, () => approved({ labels: ["team:payments"] })),
      approved({ labels: [] }),
      unapproved({ labels: ["team:growth"] }),
    ];
    expect(calibratePolicy(board).policy.labels).toBeUndefined();
  });

  it("omits a namespace whose approved values are everything the board uses", () => {
    // `team:` narrows nothing — every value on the board has been approved — while `severity:` does.
    const board = [
      ...many(5, () => approved({ labels: ["team:payments", "severity:major"] })),
      unapproved({ labels: ["team:payments", "severity:minor"] }),
    ];
    expect(calibratePolicy(board).policy.labels).toEqual([
      { namespace: "severity", values: ["major"] },
    ]);
  });

  it("never proposes a criterion over anton's own bookkeeping labels", () => {
    const board = [
      ...many(5, () =>
        approved({ labels: ["stage:implementing", "source:stringer", "run-lease:123", "review-score:8"] }),
      ),
      unapproved({ labels: ["stage:in-review", "source:gardener"] }),
    ];
    expect(calibratePolicy(board).policy.labels).toBeUndefined();
  });
});

/**
 * A draft the API will actually take. The panel's accept button PATCHes the proposal straight
 * through `pickerPolicySchema`, so a criterion the schema rejects is an operator staring at a 400
 * with no control to resolve it — the proposal has to stay inside the store's own ceilings.
 */
describe("calibratePolicy — the proposal is storable", () => {
  it("omits a namespace with more approved values than a criterion may carry", () => {
    // 40 distinct values, still a proper subset of the board's 41, so the narrowing check passes.
    const board = [
      ...many(40, (i) => approved({ labels: [`kind:v${i}`, "severity:major"] })),
      unapproved({ labels: ["kind:v40", "severity:minor"] }),
    ];
    const { policy } = calibratePolicy(board);
    expect(policy.labels?.map((c) => c.namespace)).toEqual(["severity"]);
    expect(pickerPolicySchema.safeParse(policy).success).toBe(true);
  });

  it("keeps the most narrowing namespaces when a board offers more than the store holds", () => {
    // 20 namespaces, each narrowing; only 16 criteria fit, and the narrowest ones are the ones worth
    // keeping — dropping a criterion widens the draft, so it still admits every approval.
    const labelsOf = (i: number) => (i < 4 ? [`ns${i}:a`, `ns${i}:b`] : [`ns${i}:a`]);
    const history = many(5, () =>
      approved({ labels: Array.from({ length: 20 }, (_, i) => labelsOf(i)).flat() }),
    );
    const board = [
      ...history,
      unapproved({ labels: Array.from({ length: 20 }, (_, i) => `ns${i}:z`) }),
    ];
    const { policy } = calibratePolicy(board);
    expect(policy.labels).toHaveLength(16);
    // The four two-value namespaces are the ones dropped.
    expect(policy.labels?.some((c) => c.values.length > 1)).toBe(false);
    expect(pickerPolicySchema.safeParse(policy).success).toBe(true);
  });

  it("omits a priority floor bd's own scale does not carry", () => {
    const board = many(5, () => approved({ priority: 9 }));
    const { policy } = calibratePolicy(board);
    expect(policy.maxPriority).toBeUndefined();
    expect(pickerPolicySchema.safeParse(policy).success).toBe(true);
  });
});

describe("boardIssueTypes", () => {
  it("reports the types the board actually uses, sorted and deduped", () => {
    const board = [
      unapproved({ issue_type: "task" }),
      unapproved({ issue_type: "bug" }),
      unapproved({ issue_type: "task" }),
      unapproved({ issue_type: undefined }),
    ];
    expect(boardIssueTypes(board)).toEqual(["bug", "task"]);
  });
});
