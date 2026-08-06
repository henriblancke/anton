/**
 * The per-kind autonomy policy (anton-nbyy): every kind decided, `propose` until an operator says
 * otherwise, and one hard floor no setting can cross — a `split` and a targetless re-parent have no
 * mechanical move, so they resolve to `propose` under an all-`apply` policy.
 */
import { describe, expect, it } from "vitest";
import { resolveAutonomyPolicy } from "@/lib/projects";
import {
  DEFAULT_PROPOSAL_AUTONOMY_POLICY,
  PROPOSAL_AUTONOMY_LEVELS,
  autonomyFor,
  resolveProposalAutonomyPolicy,
  type ProposalAutonomyPolicy,
} from "./autonomy";
import { GARDENER_DETECTION_KINDS, KINDS, type GardenerDetectionKind } from "./detections";

/** The most permissive policy expressible — what every floor case has to survive. */
const ALL_APPLY: ProposalAutonomyPolicy = Object.fromEntries(
  GARDENER_DETECTION_KINDS.map((kind) => [kind, "apply"]),
) as ProposalAutonomyPolicy;

/** The plan half `autonomyFor` reads: the kind's canonical move, pointed at something. */
function planFor(kind: GardenerDetectionKind) {
  return { move: KINDS[kind].move, target: "anton-target" };
}

describe("the policy is total over the detection kinds", () => {
  it("decides every kind — a new kind without a default is a type error, and a missing one fails here", () => {
    expect(Object.keys(DEFAULT_PROPOSAL_AUTONOMY_POLICY).sort()).toEqual(
      [...GARDENER_DETECTION_KINDS].sort(),
    );
  });

  it("ships as propose everywhere, so an upgrade arms nothing", () => {
    for (const kind of GARDENER_DETECTION_KINDS) {
      expect(DEFAULT_PROPOSAL_AUTONOMY_POLICY[kind]).toBe("propose");
    }
  });

  it("offers exactly three levels", () => {
    expect(PROPOSAL_AUTONOMY_LEVELS).toEqual(["propose", "shadow", "apply"]);
  });
});

describe("autonomyFor", () => {
  it("answers with the policy's value for the kind when the move is mechanical", () => {
    for (const level of PROPOSAL_AUTONOMY_LEVELS) {
      const policy: ProposalAutonomyPolicy = { ...DEFAULT_PROPOSAL_AUTONOMY_POLICY, stale: level };
      expect(autonomyFor("stale", planFor("stale"), policy)).toBe(level);
    }
  });

  it("decides each kind independently — arming one leaves its neighbours proposing", () => {
    const policy: ProposalAutonomyPolicy = {
      ...DEFAULT_PROPOSAL_AUTONOMY_POLICY,
      "implied-order": "shadow",
    };
    expect(autonomyFor("implied-order", planFor("implied-order"), policy)).toBe("shadow");
    expect(autonomyFor("missing-order", planFor("missing-order"), policy)).toBe("propose");
  });
});

describe("the hard floor — a move with no mechanical answer", () => {
  it("keeps a split at propose under an apply policy: decomposition writes new contracts", () => {
    expect(ALL_APPLY.oversized).toBe("apply");
    expect(autonomyFor("oversized", { move: "split" }, ALL_APPLY)).toBe("propose");
  });

  it("keeps a TARGETLESS re-parent at propose under an apply policy — the ask is a question", () => {
    expect(autonomyFor("container-orphan", { move: "reparent" }, ALL_APPLY)).toBe("propose");
    expect(autonomyFor("parentless-cluster", { move: "reparent" }, ALL_APPLY)).toBe("propose");
  });

  it("floors shadow too — a manual proposal has nothing to shadow either", () => {
    const shadowAll: ProposalAutonomyPolicy = Object.fromEntries(
      GARDENER_DETECTION_KINDS.map((kind) => [kind, "shadow"]),
    ) as ProposalAutonomyPolicy;
    expect(autonomyFor("oversized", { move: "split" }, shadowAll)).toBe("propose");
    expect(autonomyFor("container-orphan", { move: "reparent" }, shadowAll)).toBe("propose");
  });

  it("leaves a re-parent that NAMES a target armable — the floor is about the move, not the kind", () => {
    expect(
      autonomyFor("container-orphan", { move: "reparent", target: "anton-feat" }, ALL_APPLY),
    ).toBe("apply");
  });
});

describe("resolveAutonomyPolicy", () => {
  it("returns propose for every kind on empty settings", () => {
    const policy = resolveAutonomyPolicy({});
    expect(policy).toEqual(DEFAULT_PROPOSAL_AUTONOMY_POLICY);
    for (const kind of GARDENER_DETECTION_KINDS) expect(policy[kind]).toBe("propose");
  });

  it("applies the kinds an operator armed and leaves the rest shipped", () => {
    const policy = resolveAutonomyPolicy({ proposalAutonomy: { stale: "shadow" } });
    expect(policy.stale).toBe("shadow");
    expect(policy.superseded).toBe("propose");
  });

  it("drops an unknown kind rather than throwing — a pass must not die on a stale settings blob", () => {
    const policy = resolveProposalAutonomyPolicy({ "kind-from-the-future": "apply", stale: "apply" });
    expect(policy.stale).toBe("apply");
    expect(policy).not.toHaveProperty("kind-from-the-future");
    expect(Object.keys(policy).sort()).toEqual([...GARDENER_DETECTION_KINDS].sort());
  });

  it("drops an unreadable VALUE back to propose rather than throwing", () => {
    for (const bad of ["armed", 1, null, {}]) {
      expect(resolveProposalAutonomyPolicy({ stale: bad }).stale).toBe("propose");
    }
  });

  it("survives a stored value that isn't a policy at all", () => {
    for (const bad of [null, undefined, "shadow", 7, ["stale"]]) {
      expect(resolveProposalAutonomyPolicy(bad)).toEqual(DEFAULT_PROPOSAL_AUTONOMY_POLICY);
    }
  });

  it("never mutates the shipped default", () => {
    resolveProposalAutonomyPolicy({ stale: "apply" }).stale = "shadow";
    expect(DEFAULT_PROPOSAL_AUTONOMY_POLICY.stale).toBe("propose");
  });
});
