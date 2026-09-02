/**
 * Every bar a start claim clears, asked directly (anton-mspj) — the one claim whose approval SPENDS
 * a run, so a bar that stopped working would set a run loose on a target the board itself refuses.
 *
 * The eligibility bar is the picker's own predicate, delegated whole: what is asserted here is that
 * it is ASKED and that its answer reaches the founder verbatim, not a second copy of its policy.
 */
import { describe, expect, it } from "vitest";
import { LABELS, type Bead } from "../beads/bd";
import { indexBoard } from "../gardener/board-index";
import { bead, NOW } from "./board.fixture";
import type { PmClaimStart } from "./report";
import { startRefusal, START_GUARDS } from "./start-guards";

const RUBRIC = "- [ ] it ships";

const BOARD = [
  /** A parentless task with a rubric: a run target the picker would offer, missing only the gate. */
  bead("anton-ready", { acceptance_criteria: RUBRIC }),
  bead("anton-granted", { acceptance_criteria: RUBRIC, labels: [LABELS.approved] }),
  bead("anton-taken", { acceptance_criteria: RUBRIC, assignee: "runner-7" }),
  bead("anton-card", { issue_type: "feature", acceptance_criteria: RUBRIC }),
  bead("anton-ticket", { parent: "anton-card", acceptance_criteria: RUBRIC }),
  // Both bars describe this one: it carries the gate AND nothing would dispatch it.
  bead("anton-granted-ticket", {
    parent: "anton-card",
    acceptance_criteria: RUBRIC,
    labels: [LABELS.approved],
  }),
];

const index = indexBoard(BOARD);

const start = (bead: string): PmClaimStart => ({
  kind: "start",
  bead,
  summary: "this is the work to run next",
  evidence: ["it unblocks the two beads behind it"],
});

const refusalFor = (claim: PmClaimStart): string | undefined =>
  startRefusal(claim, index.byId.get(claim.bead) as Bead, index, NOW);

interface StartCase {
  guard: string;
  label: string;
  bad: PmClaimStart;
  reason: string;
}

const CASES: StartCase[] = [
  {
    guard: "alreadyApproved",
    label: "a bead that already carries the gate",
    bad: start("anton-granted"),
    reason:
      "anton-granted is already approved — nothing is withholding the gate, so the move would write nothing",
  },
  {
    guard: "notStartable",
    label: "a bead somebody already holds",
    bad: start("anton-taken"),
    reason:
      "anton-taken is not work anton may start — held by runner-7 (claimed) — so approving it would set a run loose on a target the board itself refuses",
  },
  {
    guard: "notStartable",
    label: "a bead no run can dispatch",
    bad: start("anton-ticket"),
    reason:
      "anton-ticket is not work anton may start — it now sits under anton-card and runs as one of that target's tickets, not on its own (not-a-run-target) — so approving it would set a run loose on a target the board itself refuses",
  },
];

describe("startRefusal", () => {
  it("hands on a target the board would offer, withholding only the gate", () => {
    expect(refusalFor(start("anton-ready"))).toBeUndefined();
  });

  it.each(CASES)("refuses $label, and says why", ({ bad, reason }) => {
    expect(refusalFor(bad)).toBe(reason);
  });

  it("asserts the exact refusal of every start guard", () => {
    expect(new Set(CASES.map((c) => c.guard))).toEqual(new Set(START_GUARDS.map((g) => g.name)));
  });

  // The cheap fact about the label first: a bead that already carries the gate says so rather than
  // being reported as whatever the eligibility walk happens to find wrong with it.
  it("reports the granted gate before whatever else the eligibility walk would find", () => {
    expect(refusalFor(start("anton-granted-ticket"))).toBe(
      "anton-granted-ticket is already approved — nothing is withholding the gate, so the move would write nothing",
    );
  });

  it("runs the start guards in the order the refusals depend on", () => {
    expect(START_GUARDS.map((g) => g.name)).toEqual(["alreadyApproved", "notStartable"]);
  });
});
