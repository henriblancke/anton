/**
 * The per-kind autonomy policy (anton-nbyy) and the two hard floors under it: every kind decided,
 * `propose` until an operator says otherwise, and neither floor crossable by a setting.
 *
 * The first is about the MOVE — a `split` and a targetless re-parent have no mechanical answer, so
 * they resolve to `propose` under an all-`apply` policy. The second is about the RECORD (anton-m29g):
 * a kind whose own proposals the founder keeps declining resolves to `propose` too, tiered by what a
 * wrong move costs, over a rolling window so a rewritten detector is not judged by its predecessor's
 * record.
 */
import { describe, expect, it } from "vitest";
import { resolveAutonomyPolicy } from "@/lib/projects";
import {
  DEFAULT_PROPOSAL_AUTONOMY_POLICY,
  EARNED_AUTONOMY_BARS,
  EARNED_AUTONOMY_WINDOW,
  PROPOSAL_AUTONOMY_LEVELS,
  autonomyFor,
  autonomyTierOf,
  PICKER_AUTONOMY_TIER,
  earnedAutonomy,
  earnedAutonomyOfKind,
  earnedPickerAutonomy,
  emptyTrackRecord,
  resolveProposalAutonomyPolicy,
  type ProposalAutonomyPolicy,
  type ProposalTrackRecord,
} from "./autonomy";
import { GARDENER_DETECTION_KINDS, KINDS, type GardenerDetectionKind } from "./detections";

/** The most permissive policy expressible — what every floor case has to survive. */
const ALL_APPLY: ProposalAutonomyPolicy = Object.fromEntries(
  GARDENER_DETECTION_KINDS.map((kind) => [kind, "apply"]),
) as ProposalAutonomyPolicy;

/** The plan half `autonomyFor` reads: the kind's canonical move, pointed at something. */
function planFor(kind: GardenerDetectionKind) {
  return { ...KINDS[kind], target: "anton-target" };
}

/**
 * A record that clears every tier's bar — what the tests about the POLICY need, so the earned floor
 * (exercised on its own below) never silently decides one of their answers.
 */
const EARNED: ProposalTrackRecord = Object.fromEntries(
  GARDENER_DETECTION_KINDS.map((kind) => [kind, { settled: 30, applied: 30 }]),
) as ProposalTrackRecord;

/** The board as it stands for a kind nothing has ever settled — the shipped state of every kind. */
const NO_RECORD = emptyTrackRecord();

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
      expect(autonomyFor("stale", planFor("stale"), policy, EARNED)).toBe(level);
    }
  });

  it("decides each kind independently — arming one leaves its neighbours proposing", () => {
    const policy: ProposalAutonomyPolicy = {
      ...DEFAULT_PROPOSAL_AUTONOMY_POLICY,
      "implied-order": "shadow",
    };
    expect(autonomyFor("implied-order", planFor("implied-order"), policy, EARNED)).toBe("shadow");
    expect(autonomyFor("missing-order", planFor("missing-order"), policy, EARNED)).toBe("propose");
  });
});

describe("the hard floor — a move with no mechanical answer", () => {
  it("keeps a split at propose under an apply policy: decomposition writes new contracts", () => {
    expect(ALL_APPLY.oversized).toBe("apply");
    expect(autonomyFor("oversized", { move: "split" }, ALL_APPLY, EARNED)).toBe("propose");
  });

  it("keeps a TARGETLESS re-parent at propose under an apply policy — the ask is a question", () => {
    expect(autonomyFor("container-orphan", { move: "reparent" }, ALL_APPLY, EARNED)).toBe("propose");
    expect(autonomyFor("parentless-cluster", { move: "reparent" }, ALL_APPLY, EARNED)).toBe("propose");
  });

  it("floors shadow too — a manual proposal has nothing to shadow either", () => {
    const shadowAll: ProposalAutonomyPolicy = Object.fromEntries(
      GARDENER_DETECTION_KINDS.map((kind) => [kind, "shadow"]),
    ) as ProposalAutonomyPolicy;
    expect(autonomyFor("oversized", { move: "split" }, shadowAll, EARNED)).toBe("propose");
    expect(autonomyFor("container-orphan", { move: "reparent" }, shadowAll, EARNED)).toBe("propose");
  });

  it("leaves a re-parent that NAMES a target armable — the floor is about the move, not the kind", () => {
    expect(
      autonomyFor("container-orphan", { move: "reparent", target: "anton-feat" }, ALL_APPLY, EARNED),
    ).toBe("apply");
  });
});

describe("the earned floor — a kind is armable only once its proposals have a record (anton-m29g)", () => {
  /** A record where only `kind` has settled anything. */
  const recordOf = (
    kind: GardenerDetectionKind,
    settled: number,
    applied: number,
  ): ProposalTrackRecord => ({ ...NO_RECORD, [kind]: { settled, applied } });

  it("keeps an apply-policy kind at propose while it has no record at all", () => {
    // The board as it stands: no kind has ever had a proposal settled.
    for (const kind of GARDENER_DETECTION_KINDS) {
      expect(autonomyFor(kind, planFor(kind), ALL_APPLY, NO_RECORD)).toBe("propose");
    }
  });

  it("arms a kind once its record clears the bar, and only then", () => {
    const bar = EARNED_AUTONOMY_BARS.reversible;
    const short = recordOf("implied-order", bar.minSettled - 1, bar.minSettled - 1);
    const cleared = recordOf("implied-order", bar.minSettled, bar.minSettled);

    expect(autonomyFor("implied-order", planFor("implied-order"), ALL_APPLY, short)).toBe("propose");
    expect(autonomyFor("implied-order", planFor("implied-order"), ALL_APPLY, cleared)).toBe("apply");
  });

  it("keeps a kind at propose on a full-but-bad record — enough settled, too few applied", () => {
    // The one kind with a record on this board scores 25%, which is the whole reason the floor
    // exists: a clean shadow week would have authorised nine wrong re-parents.
    const record = recordOf("parentless-cluster", 12, 3);
    expect(autonomyFor("parentless-cluster", planFor("parentless-cluster"), ALL_APPLY, record)).toBe(
      "propose",
    );
    expect(earnedAutonomyOfKind("parentless-cluster", record).reason).toContain("3/12 applied (25%)");
  });

  it("no setting routes an unearned kind anywhere but propose", () => {
    // The same strength as the manual floor: `apply` demotes all the way, and the levels that write
    // nothing are untouched — `shadow` is how a record becomes readable in the first place.
    expect(autonomyFor("stale", planFor("stale"), ALL_APPLY, NO_RECORD)).toBe("propose");
    const shadowAll: ProposalAutonomyPolicy = Object.fromEntries(
      GARDENER_DETECTION_KINDS.map((kind) => [kind, "shadow"]),
    ) as ProposalAutonomyPolicy;
    expect(autonomyFor("stale", planFor("stale"), shadowAll, NO_RECORD)).toBe("shadow");
  });

  it("leaves the manual floor winning over both — a split is propose on a perfect record", () => {
    expect(autonomyFor("oversized", { move: "split" }, ALL_APPLY, EARNED)).toBe("propose");
    expect(autonomyFor("container-orphan", { move: "reparent" }, ALL_APPLY, EARNED)).toBe("propose");
  });

  it("tiers the bar by what a wrong move COSTS, not uniformly", () => {
    // A re-parent one write undoes and a close that records work as SHIPPED must not share a bar.
    expect(autonomyTierOf({ move: "reparent" })).toBe("reversible");
    expect(autonomyTierOf({ move: "link" })).toBe("reversible");
    expect(autonomyTierOf({ move: "reprioritize" })).toBe("reversible");
    expect(autonomyTierOf({ move: "unapprove" })).toBe("dequeued");
    expect(autonomyTierOf({ move: "retire", retireAs: "defer" })).toBe("dequeued");
    expect(autonomyTierOf({ move: "retire", retireAs: "close" })).toBe("history");
    expect(autonomyTierOf({ move: "retire", retireAs: "supersede" })).toBe("history");
    // An approve releases a run that spends what it spends — withdrawing the label afterwards does
    // not un-run it, which is the dearest tier's whole property (anton-1ivg).
    expect(autonomyTierOf({ move: "approve" })).toBe("history");

    const { reversible, dequeued, history } = EARNED_AUTONOMY_BARS;
    expect(reversible.minSettled).toBeLessThan(dequeued.minSettled);
    expect(dequeued.minSettled).toBeLessThan(history.minSettled);
    expect(reversible.minAppliedPct).toBeLessThan(dequeued.minAppliedPct);
    expect(dequeued.minAppliedPct).toBeLessThan(history.minAppliedPct);
    // The window has to be wider than the dearest bar, or clearing that bar would mean clearing it
    // on every proposal the kind has ever filed rather than on recent work.
    expect(history.minSettled).toBeLessThan(EARNED_AUTONOMY_WINDOW);
  });

  it("holds a close to a higher bar than a link on the SAME counts", () => {
    const counts = EARNED_AUTONOMY_BARS.reversible.minSettled;
    const link = recordOf("implied-order", counts, counts);
    const close = recordOf("shipped-orphan", counts, counts);
    expect(autonomyFor("implied-order", planFor("implied-order"), ALL_APPLY, link)).toBe("apply");
    expect(autonomyFor("shipped-orphan", planFor("shipped-orphan"), ALL_APPLY, close)).toBe("propose");
  });

  it("says WHY it is locked, with the counts and the bar — never a bare refusal", () => {
    const none = earnedAutonomyOfKind("stale", NO_RECORD);
    expect(none.eligible).toBe(false);
    expect(none.reason).toContain("no settled proposals yet");
    expect(none.reason).toContain(`${EARNED_AUTONOMY_BARS.dequeued.minSettled} settled`);

    const cleared = earnedAutonomyOfKind("implied-order", EARNED);
    expect(cleared.eligible).toBe(true);
    expect(cleared.reason).toBeUndefined();
    expect(cleared).toMatchObject({ settled: 30, applied: 30, tier: "reversible" });
  });

  it("prices a split at the dearest tier, so a fall-through can never be the cheapest", () => {
    expect(autonomyTierOf({ move: "split" })).toBe("history");
  });

  it("ships the approve move at propose, and arms it only on a record that earned the dearest bar", () => {
    // The verb that STARTS work joins the ladder at the bottom rung like every other kind: adding it
    // arms nothing, and it clears at the close's bar rather than the link's.
    expect(DEFAULT_PROPOSAL_AUTONOMY_POLICY["withheld-approval"]).toBe("propose");

    const dequeuedCounts = EARNED_AUTONOMY_BARS.dequeued.minSettled;
    const short = recordOf("withheld-approval", dequeuedCounts, dequeuedCounts);
    expect(autonomyFor("withheld-approval", planFor("withheld-approval"), ALL_APPLY, short)).toBe(
      "propose",
    );
    expect(autonomyFor("withheld-approval", planFor("withheld-approval"), ALL_APPLY, EARNED)).toBe(
      "apply",
    );
  });

  it("reads the record for the plan's OWN move, not just the kind's name", () => {
    // The kind and the move answer different halves; `earnedAutonomy` prices the plan in hand.
    const record = { ...NO_RECORD, misfiled: { settled: 10, applied: 10 } };
    expect(earnedAutonomy("misfiled", { move: "reparent" }, record).eligible).toBe(true);
    expect(earnedAutonomy("misfiled", { move: "retire", retireAs: "close" }, record).eligible).toBe(
      false,
    );
  });
});

describe("the same floor over the picker's record (anton-vkp9)", () => {
  const bar = EARNED_AUTONOMY_BARS[PICKER_AUTONOMY_TIER];

  it("prices an unattended start at the tier the approve move already costs", () => {
    // Not a second ladder with its own numbers: the picker writes `approved` and starts a run, which
    // is the `approve` move, and the table above already says what that costs.
    expect(PICKER_AUTONOMY_TIER).toBe(autonomyTierOf({ move: "approve" }));
    expect(PICKER_AUTONOMY_TIER).toBe("history");
  });

  it("blocks apply on an empty record, and says so in counts", () => {
    const verdict = earnedPickerAutonomy({ settled: 0, accepted: 0 });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe(
      `no answered picks yet — apply unlocks at ${bar.minSettled} answered with ${bar.minAppliedPct}% released`,
    );
  });

  it("blocks apply on a record that is too short to read, whatever its ratio", () => {
    // A perfect three-for-three is not a record; `minSettled` is "have you seen enough of these to
    // have an opinion", and it is not substitutable by the ratio beside it.
    const verdict = earnedPickerAutonomy({ settled: 3, accepted: 3 });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("3/3 released");
  });

  it("allows apply once the record supports it", () => {
    expect(
      earnedPickerAutonomy({ settled: bar.minSettled, accepted: bar.minSettled }).eligible,
    ).toBe(true);
  });

  it("blocks apply on a full record the operator kept vetoing, naming the percentage", () => {
    const accepted = Math.floor((bar.minSettled * (bar.minAppliedPct - 20)) / 100);
    const verdict = earnedPickerAutonomy({ settled: bar.minSettled, accepted });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain(`${accepted}/${bar.minSettled} released (`);
  });

  it("stops clearing the bar the moment the record degrades — the window rolls", () => {
    // The same counts, one release turned into a veto: what was armable is not, with no latch and
    // nothing for an operator to clear.
    const armed = { settled: bar.minSettled, accepted: bar.minSettled };
    const degraded = { settled: bar.minSettled, accepted: bar.minSettled - 3 };
    expect(earnedPickerAutonomy(armed).eligible).toBe(true);
    expect(earnedPickerAutonomy(degraded).eligible).toBe(false);
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
