/**
 * The repair trust dial (R5.3).
 *
 * Three claims, and each is a way an operator's setting could quietly stop meaning what it says:
 *   • THE SHIPPED POLICY WRITES NOTHING. A project that never opens the setting gets `shadow` on the
 *     factual pair and `propose` on the classes anton cannot repair at all.
 *   • IT IS NEVER PARTIAL. Every class is decided, so no branch can read an absent key as "fine".
 *   • AN UNREADABLE ENTRY FALLS BACK TO THE SHIPPED DEFAULT rather than throwing inside a run that
 *     is already settling a blocked ticket.
 */
import { describe, expect, it } from "vitest";

import { PROPOSAL_AUTONOMY_LEVELS } from "./autonomy";
import { REPAIR_CLASSES } from "./repair";
import {
  DEFAULT_REPAIR_AUTONOMY_POLICY,
  resolveRepairAutonomyPolicy,
} from "./repair-autonomy";

describe("the shipped repair policy", () => {
  it("decides every class — adding one without a default is a type error, not a silent gap", () => {
    expect(Object.keys(DEFAULT_REPAIR_AUTONOMY_POLICY).sort()).toEqual([...REPAIR_CLASSES].sort());
    for (const level of Object.values(DEFAULT_REPAIR_AUTONOMY_POLICY)) {
      expect(PROPOSAL_AUTONOMY_LEVELS).toContain(level);
    }
  });

  it("arms nothing: an upgrade never starts writing to a board on its own", () => {
    for (const level of Object.values(DEFAULT_REPAIR_AUTONOMY_POLICY)) {
      expect(level).not.toBe("apply");
    }
    // The factual pair is worked out and recorded; the classes with no repair behind them are not
    // offered as merely unarmed.
    expect(DEFAULT_REPAIR_AUTONOMY_POLICY["ref-stale"]).toBe("shadow");
    expect(DEFAULT_REPAIR_AUTONOMY_POLICY["dep-missing"]).toBe("shadow");
    expect(DEFAULT_REPAIR_AUTONOMY_POLICY["acceptance-missing"]).toBe("propose");
    expect(DEFAULT_REPAIR_AUTONOMY_POLICY.oversized).toBe("propose");
  });
});

describe("resolveRepairAutonomyPolicy", () => {
  it("returns the shipped policy for a project that stored nothing", () => {
    for (const stored of [undefined, null, {}, "nope", [], 7]) {
      expect(resolveRepairAutonomyPolicy(stored)).toEqual(DEFAULT_REPAIR_AUTONOMY_POLICY);
    }
  });

  it("applies the classes the operator moved, and leaves the rest shipped", () => {
    const policy = resolveRepairAutonomyPolicy({ "ref-stale": "apply", "dep-missing": "propose" });
    expect(policy["ref-stale"]).toBe("apply");
    expect(policy["dep-missing"]).toBe("propose");
    expect(policy.oversized).toBe(DEFAULT_REPAIR_AUTONOMY_POLICY.oversized);
  });

  it("drops what it cannot read rather than failing a run that is settling a block", () => {
    const policy = resolveRepairAutonomyPolicy({
      "ref-stale": "APPLY",
      "not-a-class": "apply",
      "dep-missing": 3,
    });
    expect(policy).toEqual(DEFAULT_REPAIR_AUTONOMY_POLICY);
  });

  it("never hands back a partial policy", () => {
    expect(Object.keys(resolveRepairAutonomyPolicy({ "ref-stale": "apply" })).sort()).toEqual(
      [...REPAIR_CLASSES].sort(),
    );
  });
});
