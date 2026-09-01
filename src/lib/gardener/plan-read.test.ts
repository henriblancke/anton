/**
 * The wire plan read back off a proposal bead (anton-uxl9), asked field by field.
 *
 * The read decides which beads get MUTATED, so every field it validates is a field a hand-edited
 * blob could rot — and the guarantee this suite holds is that each one is refused ON ITS OWN and the
 * refusal SAYS WHICH. A bare `undefined` told an operator only that a proposal would never apply;
 * naming the field is what makes a rotted plan diagnosable without re-deriving the hash by hand.
 *
 * `apply.test.ts` covers the read where it composes — the legacy identity, the fingerprint's binding
 * of subjects and target. Here it is the field spec itself: one case per rejectable field, and a
 * coverage assertion so a field added to the plan without a case is a failing test.
 */
import { describe, expect, it } from "vitest";

import {
  describePlanRejection,
  makeDetection,
  parseGardenerPlan,
  planOf,
  readGardenerPlan,
  readProposalPlan,
  type GardenerPlan,
  type PlanRejection,
} from "./detections";

/** A re-parent: target and no parameter — the plainest shape a plan comes in. */
const ORPHAN = planOf(
  makeDetection({
    kind: "container-orphan",
    move: "reparent",
    subjects: ["anton-a"],
    target: "anton-card",
    summary: "anton-a rides a container epic",
    evidence: ["anton-a's parent is a container"],
  }),
);

/** The one kind whose identity is its target, so it is also the one carrying a subject guard. */
const CLUSTER = planOf(
  makeDetection({
    kind: "parentless-cluster",
    move: "reparent",
    subjects: ["anton-a", "anton-b"],
    target: "anton-card",
    summary: "two loose beads belong under anton-card",
    evidence: ["anton-a and anton-b are parentless"],
  }),
);

/** A retirement — the only shape that carries a verb. */
const STALE = planOf(
  makeDetection({
    kind: "stale",
    move: "retire",
    retireAs: "defer",
    subjects: ["anton-a"],
    summary: "anton-a has not moved in months",
    evidence: ["anton-a last changed 200 days ago"],
  }),
);

/** The only shape that carries a non-bead parameter. */
const MISPRIORITY = planOf(
  makeDetection({
    kind: "mispriority",
    move: "reprioritize",
    detail: "P1",
    subjects: ["anton-a"],
    summary: "anton-a is worth more than its priority says",
    evidence: ["anton-a unblocks four beads at P3"],
  }),
);

/** The plan minus one field — how a case says "the emitter wrote it, someone deleted it". */
function without(plan: GardenerPlan, field: keyof GardenerPlan): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...plan };
  delete raw[field];
  return raw;
}

/** The refusal a value earns, or a failure if it was readable after all. */
function rejection(value: unknown): PlanRejection {
  const read = readGardenerPlan(value);
  if ("plan" in read) throw new Error(`expected a rejection, got ${JSON.stringify(read.plan)}`);
  return read.rejected;
}

describe("a plan the emitter wrote reads back whole", () => {
  it.each([
    ["a re-parent", ORPHAN],
    ["a cluster, subject guard and all", CLUSTER],
    ["a retirement with its verb", STALE],
    ["a reprioritize with its parameter", MISPRIORITY],
  ])("accepts %s", (_case, plan) => {
    expect(parseGardenerPlan(plan)).toEqual(plan);
    expect(readGardenerPlan(plan)).toEqual({ plan });
  });
});

describe("every rejectable field is refused on its own, and the refusal names it", () => {
  const CASES: [string, unknown, string][] = [
    // The value as a whole: metadata is whatever was written there, including nothing plan-shaped.
    ["a string where a plan should be", "reparent", "(plan)"],
    ["an array where a plan should be", [ORPHAN], "(plan)"],
    ["null where a plan should be", null, "(plan)"],

    ["a plan with no kind", without(ORPHAN, "kind"), "kind"],
    ["a kind no detector emits", { ...ORPHAN, kind: "vibes" }, "kind"],

    ["a plan with no move", without(ORPHAN, "move"), "move"],
    ["a move anton has no executor for", { ...ORPHAN, move: "compact" }, "move"],
    // The kind→move pairing is one of the two things the fingerprint cannot cover.
    ["a move the kind does not mean", { ...ORPHAN, move: "link" }, "move"],

    ["a plan with no fingerprint", without(ORPHAN, "fingerprint"), "fingerprint"],
    ["a fingerprint that is not label-shaped", { ...ORPHAN, fingerprint: "gardener:stale:nope" }, "fingerprint"],
    ["a fingerprint from another namespace's format", { ...ORPHAN, fingerprint: "stale:abc123abc123" }, "fingerprint"],
    ["a fingerprint whose hash is the wrong width", { ...ORPHAN, fingerprint: "gardener:stale:abc123" }, "fingerprint"],
    // Editing what the claim is ABOUT invalidates the plan rather than redirecting the move.
    ["subjects edited under a kept fingerprint", { ...ORPHAN, subjects: ["anton-zzz"] }, "fingerprint"],
    ["a target redirected under a kept fingerprint", { ...ORPHAN, target: "anton-elsewhere" }, "fingerprint"],
    ["a detail swapped under a kept fingerprint", { ...MISPRIORITY, detail: "P0" }, "fingerprint"],

    ["a plan with no subjects", without(ORPHAN, "subjects"), "subjects"],
    ["an empty subject list", { ...ORPHAN, subjects: [] }, "subjects"],
    ["a subject that is not an id", { ...ORPHAN, subjects: [7] }, "subjects"],
    ["an empty string for a subject", { ...ORPHAN, subjects: [""] }, "subjects"],
    // A subject list is a set: a bead named twice is not two members of anything.
    ["a subject named twice", { ...CLUSTER, subjects: ["anton-a", "anton-a"] }, "subjects"],

    ["a target that is not an id", { ...ORPHAN, target: 7 }, "target"],
    ["an empty string for a target", { ...ORPHAN, target: "" }, "target"],

    // Required exactly for a retire, forbidden otherwise, and it must be the kind's own verb.
    ["a retirement with no verb", without(STALE, "retireAs"), "retireAs"],
    ["a retirement verb bd has no wrapper for", { ...STALE, retireAs: "delete" }, "retireAs"],
    ["a retirement verb the kind does not mean", { ...STALE, retireAs: "close" }, "retireAs"],
    ["a retirement verb on a move that takes none", { ...ORPHAN, retireAs: "close" }, "retireAs"],

    ["a reprioritize with no parameter", without(MISPRIORITY, "detail"), "detail"],
    ["a parameter that is not a priority", { ...MISPRIORITY, detail: "urgent" }, "detail"],
    ["an empty string for a parameter", { ...MISPRIORITY, detail: "" }, "detail"],
    ["a parameter on a kind that takes none", { ...ORPHAN, detail: "P1" }, "detail"],

    // The guard the target-identified kind carries in place of a membership hash.
    ["a cluster with its subject guard dropped", without(CLUSTER, "subjectChecksum"), "subjectChecksum"],
    ["a subject guard that does not match the list", { ...CLUSTER, subjectChecksum: "0".repeat(12) }, "subjectChecksum"],
    ["a subject guard that is not a string", { ...CLUSTER, subjectChecksum: 12 }, "subjectChecksum"],
    ["a subject guard on a kind whose fingerprint already binds the list", { ...ORPHAN, subjectChecksum: CLUSTER.subjectChecksum }, "subjectChecksum"],
  ];

  it.each(CASES)("refuses %s, naming the field", (_case, value, field) => {
    expect(rejection(value).field).toBe(field);
    expect(rejection(value).reason).not.toBe("");
    // The contract every caller that only decides whether to apply depends on is unchanged.
    expect(parseGardenerPlan(value)).toBeUndefined();
  });

  // The point of the spec over the guard chain it replaced: a field added to the plan is a row in
  // the table, and this is what fails when the row arrives without a case to refuse it.
  it("covers every field a plan can carry", () => {
    const carried = new Set(
      [ORPHAN, CLUSTER, STALE, MISPRIORITY].flatMap((plan) => Object.keys(plan)),
    );
    const named = new Set(CASES.map(([, , field]) => field));
    expect([...carried].filter((field) => !named.has(field))).toEqual([]);
    expect(named).toContain("(plan)");
  });
});

describe("the reason, which is what the field spec buys", () => {
  it("says a retire has no default verb rather than failing silently", () => {
    expect(rejection(without(STALE, "retireAs")).reason).toMatch(/no default verb/);
  });

  it("names the verb the kind actually retires as", () => {
    expect(rejection({ ...STALE, retireAs: "close" }).reason).toMatch(/stale retires as defer/);
  });

  it("says what a fingerprint is supposed to look like when it is not one", () => {
    expect(rejection({ ...ORPHAN, fingerprint: "nope" }).reason).toMatch(/<namespace>:<kind>:<hash>/);
  });

  it("distinguishes a fingerprint's FORMAT from a fingerprint that no longer hashes its fields", () => {
    expect(rejection({ ...ORPHAN, subjects: ["anton-zzz"] }).reason).toMatch(/does not hash/);
  });
});

/**
 * The refusal has to survive the read the APPLY takes, not just the parse: every production path
 * reaches a proposal bead through {@link readProposalPlan}, so a field that rots is only diagnosable
 * if the field's name gets that far ({@link applyProposal} puts it in the message the operator sees).
 */
describe("the read a proposal bead is applied through keeps the field", () => {
  const beadFor = (plan: GardenerPlan, labels = [plan.fingerprint]) => ({
    labels,
    metadata: { gardener: plan },
  });

  it("reads the plan back off the bead the emitter filed", () => {
    expect(readProposalPlan(beadFor(CLUSTER))).toEqual({ plan: CLUSTER });
  });

  it("names the field a rotted plan failed on rather than reducing it to nothing", () => {
    const edited = { ...STALE, retireAs: "close" };
    expect(readProposalPlan(beadFor(edited as GardenerPlan))).toEqual({
      rejected: { field: "retireAs", reason: expect.stringMatching(/retires as defer/) },
    });
  });

  // The bead's own label is the third record of the claim, and disagreeing with it is a rejection
  // like any other — not a silently different failure mode.
  it("refuses a plan the bead's label does not answer for, naming the fingerprint", () => {
    const read = readProposalPlan(beadFor(ORPHAN, [CLUSTER.fingerprint]));
    expect("rejected" in read && read.rejected.field).toBe("fingerprint");
  });

  it("has no plan to read when the bead carries no metadata at all", () => {
    expect(readProposalPlan({ labels: [ORPHAN.fingerprint] })).toEqual({
      rejected: { field: "(plan)", reason: "is not an object" },
    });
  });

  it("reads as one clause a message can carry", () => {
    expect(describePlanRejection(rejection(without(STALE, "retireAs")))).toMatch(
      /^retireAs .*no default verb/,
    );
  });
});
