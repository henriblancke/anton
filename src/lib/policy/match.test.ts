/**
 * The policy evaluator (anton-qsr1), asserted as the thing the editor actually needs: not "does it
 * match" but "which criterion refused it".
 *
 * Fail-closed (R2.5) is the load-bearing case — a bead missing the label a criterion names must be
 * REFUSED, and the refusal must say so in words an operator can act on, because on a foreign repo
 * that refusal is every bead on the board and a bare zero would read as a broken pass.
 *
 * The vocabularies below (`severity:`, `team:`) are deliberately ones anton ships nothing about.
 */
import { describe, expect, it } from "vitest";
import { explainPolicyMatch, partitionByPolicy, type PolicyCandidate } from "./match";
import type { Policy } from "./types";

let seq = 0;
function bead(o: Partial<PolicyCandidate> = {}): PolicyCandidate {
  const id = `c${++seq}`;
  return { id, title: id, type: "bug", priority: 1, labels: [], ...o };
}

/** The criterion keys a candidate failed. */
const failedKeys = (c: PolicyCandidate, p: Policy) =>
  explainPolicyMatch(c, p).map((v) => v.criterion);

describe("an unasserted criterion constrains nothing", () => {
  it("matches everything on an empty policy", () => {
    expect(explainPolicyMatch(bead({ type: undefined, priority: undefined }), {})).toEqual([]);
  });

  it("ignores type when the policy names no types", () => {
    expect(failedKeys(bead({ type: "epic" }), { maxPriority: 2 })).toEqual([]);
  });
});

describe("bd-native criteria", () => {
  it("admits a listed type and refuses an unlisted one, naming what is admitted", () => {
    const policy: Policy = { types: ["bug", "chore"] };
    expect(failedKeys(bead({ type: "bug" }), policy)).toEqual([]);
    const [verdict] = explainPolicyMatch(bead({ type: "feature" }), policy);
    expect(verdict.criterion).toBe("types");
    expect(verdict.reason).toContain("is a feature");
    expect(verdict.reason).toContain("bug or chore");
  });

  it("reads maxPriority as a FLOOR — bd's number inverts the operator's ordering", () => {
    const policy: Policy = { maxPriority: 2 };
    expect(failedKeys(bead({ priority: 0 }), policy)).toEqual([]);
    expect(failedKeys(bead({ priority: 2 }), policy)).toEqual([]);
    expect(explainPolicyMatch(bead({ priority: 3 }), policy)[0].reason).toBe(
      "is P3, below the P2 floor",
    );
  });

  it("fails closed on a bead that cannot answer the question at all", () => {
    // Not "unconstrained by omission": an asserted criterion a bead has no value for excludes it.
    expect(explainPolicyMatch(bead({ type: undefined }), { types: ["bug"] })[0].reason).toBe(
      "carries no issue type",
    );
    expect(explainPolicyMatch(bead({ priority: undefined }), { maxPriority: 2 })[0].reason).toBe(
      "carries no priority",
    );
  });

  it("refuses an unmet blocker only when the policy asks it to", () => {
    const blocked = bead({ blocked: true });
    expect(failedKeys(blocked, {})).toEqual([]);
    expect(failedKeys(blocked, { requireUnblocked: true })).toEqual(["blockers"]);
    expect(failedKeys(bead(), { requireUnblocked: true })).toEqual([]);
  });
});

describe("discovered namespaces are membership, and they fail closed (R2.5)", () => {
  const policy: Policy = { labels: [{ namespace: "severity", values: ["critical", "major"] }] };

  it("admits a bead carrying an admitted value", () => {
    expect(failedKeys(bead({ labels: ["severity:major", "team:payments"] }), policy)).toEqual([]);
  });

  it("refuses a bead carrying an unadmitted value under the namespace", () => {
    const [verdict] = explainPolicyMatch(bead({ labels: ["severity:minor"] }), policy);
    expect(verdict.criterion).toBe("labels:severity");
    expect(verdict.label).toBe("severity:");
    expect(verdict.reason).toContain("severity:minor");
    expect(verdict.reason).toContain("critical or major");
  });

  it("refuses a bead that has never heard of the namespace — the day-one case", () => {
    const [verdict] = explainPolicyMatch(bead({ labels: ["priority-ish:high"] }), policy);
    expect(verdict.reason).toBe(
      "carries no `severity:` label, and the policy requires critical or major",
    );
  });

  it("admits on ANY carried value, not all of them", () => {
    expect(failedKeys(bead({ labels: ["severity:minor", "severity:critical"] }), policy)).toEqual(
      [],
    );
  });

  it("treats ranking as ordering only — it never changes what is admitted", () => {
    const ranked: Policy = {
      labels: [{ namespace: "severity", values: ["major", "critical"], ranked: true }],
    };
    for (const value of ["major", "critical"]) {
      expect(failedKeys(bead({ labels: [`severity:${value}`] }), ranked)).toEqual([]);
    }
    expect(failedKeys(bead({ labels: ["severity:minor"] }), ranked)).toEqual(["labels:severity"]);
  });
});

describe("partitionByPolicy", () => {
  const board = [
    bead({ id: "keep-1", type: "bug", priority: 1, labels: ["severity:critical"] }),
    bead({ id: "drop-type", type: "feature", priority: 1, labels: ["severity:critical"] }),
    bead({ id: "drop-two", type: "feature", priority: 4, labels: [] }),
  ];
  const policy: Policy = {
    types: ["bug"],
    maxPriority: 2,
    labels: [{ namespace: "severity", values: ["critical"] }],
  };

  it("splits the board and carries every reason for each refusal", () => {
    const { matched, excluded } = partitionByPolicy(board, policy);
    expect(matched.map((c) => c.id)).toEqual(["keep-1"]);
    expect(excluded.map((e) => e.candidate.id)).toEqual(["drop-type", "drop-two"]);
    expect(excluded[0].failed.map((f) => f.criterion)).toEqual(["types"]);
    // A bead can fail more than one criterion, and the panel shows all of them — narrowing one and
    // finding the bead still absent is the confusion the per-bead answer exists to prevent.
    expect(excluded[1].failed.map((f) => f.criterion)).toEqual([
      "types",
      "priority",
      "labels:severity",
    ]);
  });

  it("matches the whole board when the policy asserts nothing", () => {
    expect(partitionByPolicy(board, {}).matched).toHaveLength(3);
  });
});
