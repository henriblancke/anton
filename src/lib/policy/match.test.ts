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
import {
  explainPolicyMatch,
  matchesPolicy,
  partitionByPolicy,
  type PolicyCandidate,
} from "./match";
import type { Policy, PolicyCriterionKey } from "./types";

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

/**
 * Every criterion in isolation, as a table (anton-hmyo): one policy asserting ONE thing, one bead,
 * and the exact sentence the editor prints when it is refused. The reason is asserted rather than the
 * boolean because on a board whose vocabulary the policy does not speak, the refusal IS the product —
 * a bare `0 match` reads as a broken pass (R2.6).
 */
interface CriterionCase {
  name: string;
  policy: Policy;
  candidate: Partial<PolicyCandidate>;
  /** The criteria this bead must fail. Empty means the policy admits it. */
  failed: PolicyCriterionKey[];
  /** The sentence beside the bead, for the single-criterion refusals. */
  reason?: string;
}

const SEVERITY_RANKING = ["critical", "major", "minor"];

const CASES: CriterionCase[] = [
  // type — native, but an ENUM: membership, because nothing ordered bd's issue types.
  { name: "type: admits a listed type", policy: { types: ["bug"] }, candidate: {}, failed: [] },
  {
    name: "type: refuses an unlisted type",
    policy: { types: ["bug"] },
    candidate: { type: "feature" },
    failed: ["types"],
    reason: "is a feature, and the policy admits only bug",
  },
  {
    name: "type: fails closed on a bead carrying none",
    policy: { types: ["bug"] },
    candidate: { type: undefined },
    failed: ["types"],
    reason: "carries no issue type",
  },

  // priority — ordered, so BOTH ends (R2.3). bd's number inverts: larger is less urgent.
  { name: "priority: admits the floor itself", policy: { maxPriority: 2 }, candidate: { priority: 2 }, failed: [] },
  {
    name: "priority: refuses below the floor",
    policy: { maxPriority: 2 },
    candidate: { priority: 3 },
    failed: ["priority"],
    reason: "is P3, below the P2 floor",
  },
  {
    name: "priority: refuses above the ceiling — the urgent end an operator withheld",
    policy: { minPriority: 1 },
    candidate: { priority: 0 },
    failed: ["priority"],
    reason: "is P0, above the P1 ceiling",
  },
  {
    name: "priority: admits inside a two-ended window",
    policy: { minPriority: 1, maxPriority: 2 },
    candidate: { priority: 2 },
    failed: [],
  },
  {
    name: "priority: fails closed on a bead carrying none",
    policy: { maxPriority: 2 },
    candidate: { priority: undefined },
    failed: ["priority"],
    reason: "carries no priority",
  },

  // parentage — ordered as DEPTH, so `maxParentDepth: 0` is "parentless work only".
  { name: "parentage: admits top-level under a 0 ceiling", policy: { maxParentDepth: 0 }, candidate: { depth: 0 }, failed: [] },
  {
    name: "parentage: refuses work nested deeper than the policy admits",
    policy: { maxParentDepth: 0 },
    candidate: { depth: 2 },
    failed: ["parentage"],
    reason: "sits 2 levels under a parent, and the policy admits nothing deeper than top-level",
  },
  {
    name: "parentage: refuses work shallower than the policy requires",
    policy: { minParentDepth: 1 },
    candidate: { depth: 0 },
    failed: ["parentage"],
    reason: "is top-level, and the policy admits nothing shallower than 1 level under a parent",
  },
  {
    name: "parentage: fails closed when the parent chain leaves the board",
    policy: { maxParentDepth: 1 },
    candidate: { depth: undefined },
    failed: ["parentage"],
    reason: "sits under a parent this board does not carry",
  },

  // age — ordered in days. The soak is the point: a rule must not start what a human was still editing.
  { name: "age: admits a bead that has served the soak exactly", policy: { minAgeDays: 2 }, candidate: { ageDays: 2 }, failed: [] },
  {
    name: "age: refuses a bead still inside the soak",
    policy: { minAgeDays: 2 },
    candidate: { ageDays: 0 },
    failed: ["age"],
    reason: "was filed 0 days ago, inside the 2 days the policy waits before starting anything",
  },
  {
    name: "age: refuses work the board has ignored for longer than the window",
    policy: { maxAgeDays: 90 },
    candidate: { ageDays: 400 },
    failed: ["age"],
    reason: "was filed 400 days ago, past the 90 days the policy admits",
  },
  {
    name: "age: fails closed on a bead with no creation date",
    policy: { maxAgeDays: 90 },
    candidate: { ageDays: undefined },
    failed: ["age"],
    reason: "carries no creation date",
  },

  // blockers
  {
    name: "blockers: refuses a held target only when asked to",
    policy: { requireUnblocked: true },
    candidate: { blocked: true },
    failed: ["blockers"],
    reason: "has an unmet blocker on the `blocks` graph",
  },

  // discovered namespaces — membership, and fail closed (R2.5).
  {
    name: "namespace: admits a carried value",
    policy: { labels: [{ namespace: "severity", values: ["critical", "major"] }] },
    candidate: { labels: ["severity:major"] },
    failed: [],
  },
  {
    name: "namespace: refuses an unadmitted value",
    policy: { labels: [{ namespace: "severity", values: ["critical", "major"] }] },
    candidate: { labels: ["severity:minor"] },
    failed: ["labels:severity"],
    reason: "is severity:minor, and the policy admits only critical or major",
  },
  {
    name: "namespace: refuses a bead that has never heard of it — the day-one case",
    policy: { labels: [{ namespace: "severity", values: ["critical", "major"] }] },
    candidate: { labels: ["team:payments"] },
    failed: ["labels:severity"],
    reason: "carries no `severity:` label, and the policy requires critical or major",
  },

  // …unless the OPERATOR ranked the namespace, which is the only order this module ever has.
  {
    name: "ranked ≤: admits everything at or before the bound",
    policy: {
      labels: [
        { namespace: "severity", values: SEVERITY_RANKING, ranked: true, compare: { op: "lte", value: "major" } },
      ],
    },
    candidate: { labels: ["severity:critical"] },
    failed: [],
  },
  {
    name: "ranked ≤: admits the bound itself",
    policy: {
      labels: [
        { namespace: "severity", values: SEVERITY_RANKING, ranked: true, compare: { op: "lte", value: "major" } },
      ],
    },
    candidate: { labels: ["severity:major"] },
    failed: [],
  },
  {
    name: "ranked ≤: refuses past the bound, quoting the operator's own ranking",
    policy: {
      labels: [
        { namespace: "severity", values: SEVERITY_RANKING, ranked: true, compare: { op: "lte", value: "major" } },
      ],
    },
    candidate: { labels: ["severity:minor"] },
    failed: ["labels:severity"],
    reason:
      "is severity:minor, and the policy admits only at or before `major` in your `severity:` ranking (critical or major)",
  },
  {
    name: "ranked ≥: the other direction along the same ranking",
    policy: {
      labels: [
        { namespace: "severity", values: SEVERITY_RANKING, ranked: true, compare: { op: "gte", value: "major" } },
      ],
    },
    candidate: { labels: ["severity:critical"] },
    failed: ["labels:severity"],
    reason:
      "is severity:critical, and the policy admits only at or after `major` in your `severity:` ranking (major or minor)",
  },
  {
    name: "ranked ≤: still fails closed on a bead missing the namespace",
    policy: {
      labels: [
        { namespace: "severity", values: SEVERITY_RANKING, ranked: true, compare: { op: "lte", value: "major" } },
      ],
    },
    candidate: { labels: [] },
    failed: ["labels:severity"],
    reason:
      "carries no `severity:` label, and the policy requires at or before `major` in your `severity:` ranking (critical or major)",
  },
  {
    name: "a comparison with no ranking behind it is never softened into membership",
    policy: {
      labels: [{ namespace: "severity", values: SEVERITY_RANKING, compare: { op: "lte", value: "major" } }],
    },
    candidate: { labels: ["severity:critical"] },
    failed: ["labels:severity"],
    reason: "cannot be judged: the policy compares `severity:` against a ranking it does not carry",
  },
  {
    name: "a comparison bounded on a value the ranking lost refuses everything, and says so",
    policy: {
      labels: [
        { namespace: "severity", values: SEVERITY_RANKING, ranked: true, compare: { op: "lte", value: "blocker" } },
      ],
    },
    candidate: { labels: ["severity:critical"] },
    failed: ["labels:severity"],
    reason: "cannot be judged: the policy compares `severity:` against `blocker`, which is not in its ranking",
  },
];

describe.each(CASES)("$name", ({ policy, candidate, failed, reason }) => {
  const target = bead(candidate);

  it("names exactly the criteria that refused it", () => {
    expect(failedKeys(target, policy)).toEqual(failed);
  });

  it("agrees with the yes/no the picker reads", () => {
    expect(matchesPolicy(target, policy)).toBe(failed.length === 0);
  });

  it("explains every refusal", () => {
    const verdicts = explainPolicyMatch(target, policy);
    for (const verdict of verdicts) {
      expect(verdict.label).not.toBe("");
      expect(verdict.reason).not.toBe("");
    }
    if (reason !== undefined) {
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0].reason).toBe(reason);
    }
  });
});
