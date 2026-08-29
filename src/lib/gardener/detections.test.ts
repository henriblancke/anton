/**
 * The move table and the identity it binds (anton-02oc), asked of the newest verb: `approve`
 * (anton-1ivg).
 *
 * It matters more than the kinds already here because it is the only move that STARTS work rather
 * than tidying the board — so the three properties this file asserts are the three that keep a
 * proposal honest: the kind resolves to exactly one move in one namespace, its fingerprint is a
 * function of what the ask is ABOUT and nothing else, and a plan whose fields were edited after
 * emission no longer reads back.
 */
import { describe, expect, it } from "vitest";

import {
  GARDENER_DETECTION_KINDS,
  KINDS,
  isManualProposal,
  kindOfFingerprint,
  makeDetection,
  namespaceOf,
  parseGardenerPlan,
  planOf,
  proposalFingerprint,
  detectionSubjectKey,
} from "./detections";

/** The ask as the product master's report supplies it: one bead, worth starting now. */
function withheld(subjects = ["anton-a"]) {
  return makeDetection({
    kind: "withheld-approval",
    move: "approve",
    subjects,
    summary: "anton-a is the board's next target and carries no approval",
    evidence: ["anton-a ranks first among the run targets", "nothing on the board approves it"],
  });
}

describe("the approve move (anton-1ivg)", () => {
  it("is a pm-namespace kind whose move is approve", () => {
    expect(KINDS["withheld-approval"]).toEqual({ namespace: "pm", move: "approve" });
    expect(namespaceOf("withheld-approval")).toBe("pm");
    expect(GARDENER_DETECTION_KINDS).toContain("withheld-approval");
  });

  it("is a move anton can run, so the manual floor does not pin it at propose", () => {
    // Unlike a split or a targetless re-parent, "grant the gate" has one mechanical answer.
    expect(isManualProposal({ move: "approve" })).toBe(false);
  });

  it("refuses a detection that claims a move the table does not pair with the kind", () => {
    // The table is what apply reads the plan back against, so a detector drifting from it would
    // file proposals that can only ever refuse.
    expect(() =>
      makeDetection({
        kind: "withheld-approval",
        move: "unapprove",
        subjects: ["anton-a"],
        summary: "s",
        evidence: ["e"],
      }),
    ).toThrow(/withheld-approval is a approve detection/);
  });

  it("takes no detail — only a reprioritize carries a parameter", () => {
    expect(() =>
      makeDetection({
        kind: "withheld-approval",
        move: "approve",
        subjects: ["anton-a"],
        detail: "P0",
        summary: "s",
        evidence: ["e"],
      }),
    ).toThrow(/takes no detail/);
  });
});

describe("its fingerprint", () => {
  it("is the pm-namespaced label every other proposal carries, and is stable", () => {
    // Pinned rather than recomputed: the label is what a re-run recognises its own ask by, so a
    // change to the key format would silently re-file every declined proposal of this kind.
    expect(withheld().fingerprint).toBe("pm:withheld-approval:9364ce27c078");
    expect(withheld().subjectKey).toBe("withheld-approval:anton-a");
    expect(kindOfFingerprint(withheld().fingerprint)).toBe("withheld-approval");
  });

  it("depends on what the ask is ABOUT and not on the order it was found in", () => {
    expect(withheld(["anton-b", "anton-a"]).fingerprint).toBe(withheld(["anton-a", "anton-b"]).fingerprint);
    expect(withheld(["anton-a"]).fingerprint).not.toBe(withheld(["anton-b"]).fingerprint);
    expect(withheld().fingerprint).toBe(
      proposalFingerprint("withheld-approval", detectionSubjectKey("withheld-approval", ["anton-a"])),
    );
  });

  it("reads back off the bead's metadata, and stops reading once a field is edited", () => {
    const plan = planOf(withheld());
    expect(parseGardenerPlan(plan)).toEqual(plan);
    // A hand-edited subject no longer hashes to the label it kept — the ask is invalidated rather
    // than silently redirected at a bead nobody judged.
    expect(parseGardenerPlan({ ...plan, subjects: ["anton-z"] })).toBeUndefined();
    // Nor can the move be swapped for another the kind does not mean.
    expect(parseGardenerPlan({ ...plan, move: "unapprove" })).toBeUndefined();
  });
});
