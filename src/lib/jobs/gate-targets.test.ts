/**
 * The DECIDE phase of the gate-check pass (anton-m2e8): `planResumes` answers all three dispatch
 * questions off ONE board read, and this suite is about how those three answers relate — that they
 * are computed from the same snapshot, and that a target lands in exactly the one path that owns it.
 * The individual halves keep their own cases in gate-check.unit.test.ts (which reads them off
 * gate-check's public face); nothing here re-litigates them.
 */
import { describe, expect, it } from "vitest";
import { LABELS, type Bead, type Gate, type GatedMolecule } from "../beads/bd";
import { planResumes } from "./gate-targets";

const NOW = 1_700_000_000_000;

function bead(id: string, o: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "task", ...o };
}

/** A closed gate blocking `blocked`, of the flavour a RESUME comes from (never `gh:pr`). */
function closedHumanGate(id: string): Gate {
  return {
    id,
    title: `Gate: ${id}`,
    status: "closed",
    issue_type: "gate",
    await_type: "human",
    created_at: new Date(NOW).toISOString(),
  };
}

/** A closed merge wait on PR #7 — the flavour that means "merged", so finalization, not resume. */
function closedMergeGate(id: string): Gate {
  return { ...closedHumanGate(id), await_type: "gh:pr", await_id: "7" };
}

const blockedBy = (id: string, gateId: string) => ({
  issue_id: id,
  depends_on_id: gateId,
  type: "blocks" as const,
});

describe("planResumes", () => {
  /**
   * One board carrying all three shapes at once — the pass's real input:
   *   • e-1: an epic whose gated STEP bd reports (the `bd ready --gated` half)
   *   • t-2: a parentless task whose ad-hoc gate closed (the half bd cannot report)
   *   • e-3: an in-review target whose merge wait closed (finalization)
   */
  const board: Bead[] = [
    bead("s-1", { parent: "e-1" }),
    bead("e-1", { issue_type: "epic", labels: [LABELS.approved] }),
    bead("t-2", { labels: [LABELS.approved], dependencies: [blockedBy("t-2", "g-2")] }),
    closedHumanGate("g-2"),
    bead("e-3", {
      issue_type: "epic",
      labels: [LABELS.approved, LABELS.stage("in-review")],
      metadata: { pr: "gh-7" },
      dependencies: [blockedBy("e-3", "g-3")],
    }),
    closedMergeGate("g-3"),
  ];
  const gated: GatedMolecule[] = [{ molecule_id: "e-1", ready_step: bead("s-1") }];

  it("answers all three dispatch paths off one board, each target in exactly one", () => {
    const plan = planResumes(board, gated, NOW);

    expect(plan.targets.map((t) => t.id)).toEqual(["e-1"]);
    expect(plan.released.map((r) => [r.gate.id, r.target.id])).toEqual([["g-2", "t-2"]]);
    expect(plan.merged.map((b) => b.id)).toEqual(["e-3"]);
  });

  it("carries the gated entries through verbatim, so the pass can report what it matched nothing to", () => {
    const plan = planResumes(board, gated, NOW);
    expect(plan.gated).toBe(gated);
  });

  it("is empty for a board with nothing to move — the idle pass", () => {
    expect(planResumes([bead("e-1", { issue_type: "epic" })], [], NOW)).toEqual({
      gated: [],
      targets: [],
      released: [],
      merged: [],
    });
  });

  it("applies the operator scope to every path at once — a shared board must not double-dispatch", () => {
    // The board is shared and the schedule is machine-local, so all three paths see the same closed
    // gates. The filter has to hold across the plan, not on one path.
    const theirs = board.map((b) =>
      b.issue_type === "gate" ? b : { ...b, assignee: b.parent ? undefined : "bob" },
    );
    const plan = planResumes(theirs, gated, NOW, "alice");

    expect(plan.targets).toEqual([]);
    expect(plan.released).toEqual([]);
    expect(plan.merged).toEqual([]);
  });
});
