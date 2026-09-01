/**
 * The provenance join (anton-cqxd): who touched a bead, read off the two records that already exist
 * — the picker's recorded plan and the product master's own proposal beads.
 *
 * What is pinned here is what a badge is allowed to CLAIM. A mark that named the wrong writer, or
 * stood for an ask the operator already declined, is worse than no mark: the whole point is that an
 * operator never has to guess which subsystem acted.
 */
import { describe, expect, it } from "vitest";

import { boardProvenance, provenanceVersion } from "@/lib/board-provenance";
import type { BoardPickerPlan } from "@/lib/board-picker-plan";
import type { Bead } from "@/lib/beads/types";
import {
  GARDENER_PLAN_KEY,
  makeDetection,
  planOf,
  type DetectionInput,
} from "@/lib/gardener/detections";
import { LABELS } from "@/lib/beads/bd";
import type { Policy } from "@/lib/policy/types";

/** A dated, contract-shaped bead — nothing for the picker's own eligibility gate to fault. */
function bead(over: Partial<Bead> & { id: string }): Bead {
  return {
    title: over.title ?? `bead ${over.id}`,
    status: "open",
    issue_type: "task",
    priority: 2,
    created_at: "2026-08-01T00:00:00.000Z",
    description: "## Goal\n\nShip it.\n",
    acceptance_criteria: "- [ ] it ships",
    ...over,
  };
}

/** A proposal exactly as the emitter files one: the plan in metadata, its fingerprint as a label. */
function proposal(id: string, input: DetectionInput, over: Partial<Bead> = {}): Bead {
  const detection = makeDetection(input);
  return bead({
    id,
    title: detection.summary,
    labels: [detection.fingerprint, ...(over.labels ?? [])],
    metadata: { [GARDENER_PLAN_KEY]: planOf(detection) },
    ...over,
  });
}

const MISPRIORITY: DetectionInput = {
  kind: "mispriority",
  move: "reprioritize",
  subjects: ["anton-1"],
  detail: "P0",
  summary: "anton-1 is doing P0 work at P2",
  evidence: ["three run targets block on it"],
};

const plan = (over: Partial<BoardPickerPlan> = {}): BoardPickerPlan => ({
  projectId: "p1",
  generatedAt: 1_770_000_000,
  stamp: { observedAtMs: 1_770_000_000_000, digest: "d1", beadCount: 3 },
  entries: [{ beadId: "anton-1", rank: 1, rule: "the work policy armed on this machine" }],
  exclusions: [],
  ...over,
});

describe("the picker's mark", () => {
  it("names the criterion that admitted the target, so the badge opens a control", () => {
    const target = bead({ id: "anton-1", issue_type: "bug", labels: ["severity:critical"] });
    const policy: Policy = { types: ["bug"], labels: [{ namespace: "severity", values: ["critical"] }] };

    const marks = boardProvenance({ board: [target], plan: plan(), policy }).get("anton-1");

    expect(marks).toEqual([
      // The discovered namespace is the narrowest lever, so it is the one `admittingCriterion` picks.
      { kind: "policy", ref: "labels:severity", detail: "the work policy armed on this machine" },
    ]);
  });

  it("still marks the target on an unarmed project — with the rule, and no control to open", () => {
    const target = bead({ id: "anton-1" });
    const entries = [{ beadId: "anton-1", rank: 1, rule: "any claimable run target" }];

    const marks = boardProvenance({ board: [target], plan: plan({ entries }) }).get("anton-1");

    expect(marks).toEqual([{ kind: "policy", detail: "any claimable run target" }]);
  });

  it("marks nothing when the picker has never run here", () => {
    expect(boardProvenance({ board: [bead({ id: "anton-1" })] }).size).toBe(0);
  });

  /**
   * The badge is history and survives the board moving past the plan — but `[Release]` is derived
   * from this same mark, and that button claims the pick is LIVE. The caller's freshness verdict
   * rides along so the two can be told apart.
   */
  it("flags a mark whose plan the board has moved past, rather than dropping it", () => {
    const target = bead({ id: "anton-1" });
    const entries = [{ beadId: "anton-1", rank: 1, rule: "any claimable run target" }];

    const marks = boardProvenance({
      board: [target],
      plan: plan({ entries }),
      planIsStale: true,
    }).get("anton-1");

    expect(marks).toEqual([
      { kind: "policy", detail: "any claimable run target", stale: true },
    ]);
  });

  /**
   * The criterion is re-derived from the CURRENT policy and board, and stale says those are not the
   * ones the pass decided from. A target still admitted — under a rule the operator saved after the
   * pick — would otherwise get a badge linking history to a rule that never made it.
   */
  it("drops the criterion link on a stale plan, keeping the rule it was picked under", () => {
    const target = bead({ id: "anton-1", issue_type: "bug", labels: ["severity:critical"] });
    const policy: Policy = { types: ["bug"], labels: [{ namespace: "severity", values: ["critical"] }] };

    const marks = boardProvenance({
      board: [target],
      plan: plan(),
      policy,
      planIsStale: true,
    }).get("anton-1");

    expect(marks).toEqual([
      { kind: "policy", detail: "the work policy armed on this machine", stale: true },
    ]);
  });
});

describe("the product master's mark", () => {
  it("marks every bead the proposal concerns, and points at the proposal itself", () => {
    const board = [
      bead({ id: "anton-1" }),
      proposal("anton-9", MISPRIORITY),
    ];

    expect(boardProvenance({ board }).get("anton-1")).toEqual([
      { kind: "pm", ref: "anton-9", detail: "mispriority" },
    ]);
  });

  it("marks the move's target as well as its subjects — both beads were judged", () => {
    const board = [
      bead({ id: "anton-1" }),
      bead({ id: "anton-2" }),
      proposal("anton-9", {
        kind: "misfiled",
        move: "reparent",
        subjects: ["anton-1"],
        target: "anton-2",
        summary: "anton-1 belongs under anton-2",
        evidence: ["both are about the picker"],
      }),
    ];

    const marks = boardProvenance({ board });
    expect(marks.get("anton-1")?.[0]).toMatchObject({ kind: "pm", ref: "anton-9" });
    expect(marks.get("anton-2")?.[0]).toMatchObject({ kind: "pm", ref: "anton-9" });
  });

  it("says nothing about a proposal the operator DECLINED — nothing touched the bead", () => {
    const board = [
      bead({ id: "anton-1" }),
      proposal("anton-9", MISPRIORITY, { status: "closed", labels: [LABELS.abandoned] }),
    ];

    expect(boardProvenance({ board }).has("anton-1")).toBe(false);
  });

  it("keeps marking a proposal that was APPLIED — that is exactly when 'who moved this?' is asked", () => {
    const board = [
      bead({ id: "anton-1", priority: 0 }),
      proposal("anton-9", MISPRIORITY, { status: "closed" }),
    ];

    expect(boardProvenance({ board }).get("anton-1")).toEqual([
      { kind: "pm", ref: "anton-9", detail: "mispriority" },
    ]);
  });

  it("badges only the pm namespace — the gardener detects board shape, not product judgment", () => {
    const board = [
      bead({ id: "anton-1" }),
      bead({ id: "anton-2" }),
      proposal("anton-9", {
        kind: "implied-order",
        move: "link",
        subjects: ["anton-1", "anton-2"],
        summary: "anton-1 has to land before anton-2",
        evidence: ["the description says so"],
      }),
    ];

    expect(boardProvenance({ board }).size).toBe(0);
  });

  it("carries the newest claim when a bead has been proposed about twice", () => {
    const board = [
      bead({ id: "anton-1" }),
      proposal("anton-8", MISPRIORITY, { created_at: "2026-08-01T00:00:00.000Z" }),
      proposal("anton-9", { ...MISPRIORITY, detail: "P1" }, { created_at: "2026-08-09T00:00:00.000Z" }),
    ];

    expect(boardProvenance({ board }).get("anton-1")).toEqual([
      { kind: "pm", ref: "anton-9", detail: "mispriority" },
    ]);
  });
});

describe("a bead two writers touched", () => {
  it("carries both marks, policy first, so a card's badges never reorder between renders", () => {
    const board = [bead({ id: "anton-1" }), proposal("anton-9", MISPRIORITY)];

    expect(boardProvenance({ board, plan: plan() }).get("anton-1")).toEqual([
      { kind: "policy", detail: "the work policy armed on this machine" },
      { kind: "pm", ref: "anton-9", detail: "mispriority" },
    ]);
  });
});

describe("the freshness token", () => {
  it("moves when the picker records a new plan, so a poll cannot 304 past new badges", () => {
    const first = provenanceVersion(plan());
    expect(provenanceVersion(plan({ stamp: { ...plan().stamp, digest: "d2" } }))).not.toBe(first);
    expect(provenanceVersion(plan({ generatedAt: 1_770_000_600 }))).not.toBe(first);
    expect(provenanceVersion(plan())).toBe(first);
  });

  it("is a stable answer on a project whose picker has never run", () => {
    expect(provenanceVersion()).toBe(provenanceVersion());
    expect(provenanceVersion()).toContain("none");
  });

  // A settings save moves no bead, no plan row and no schedule — but it turns every live pick into
  // history (it is half the plan's freshness fence), so a token blind to it would 304 the operator
  // back onto a lane anton has already withdrawn.
  it("moves when the operator saves a different policy", () => {
    const armed = provenanceVersion(plan(), { types: ["feature"] });

    expect(provenanceVersion(plan(), { types: ["bug"] })).not.toBe(armed);
    expect(provenanceVersion(plan())).not.toBe(armed);
    expect(provenanceVersion(plan(), { types: ["feature"] })).toBe(armed);
  });
});
