/**
 * The severity model behind the board's attention strip (anton-ue90.1). It lives in lib and is
 * tested here rather than through the component, because the ORDER is the product decision: three
 * unrelated producers agreeing on one ranking is what lets the strip replace three panels.
 */
import { describe, expect, it } from "vitest";

import { rankAttention, hasAppliedActions, REWORK_SCORE_CEILING } from "@/lib/attention";
import type {
  EscalationView,
  HygieneFinding,
  HygieneFindingKind,
  HygieneReport,
  ReviewTrajectory,
  ScoredTarget,
} from "@/lib/types";

function escalation(o: Partial<EscalationView> = {}): EscalationView {
  return {
    id: "esc-1",
    findingKey: "parked-run:r-1",
    kind: "parked-run",
    reason: "parked: agent exited 1",
    beadId: "anton-t9",
    epicBeadId: "anton-e1",
    runId: "r-1",
    ageMs: 4 * 3_600_000,
    status: "open",
    noted: true,
    raisedAt: 1_700_000_000,
    ...o,
  };
}

function finding(kind: HygieneFindingKind, id: string): HygieneFinding {
  return { kind, key: `${kind}:${id}`, detail: `${kind} on ${id}`, beadId: id };
}

function report(findings: HygieneFinding[], o: Partial<HygieneReport> = {}): HygieneReport {
  const counts = {
    lint: 0,
    "stale-open": 0,
    "stale-in-progress": 0,
    orphan: 0,
    "dep-cycle": 0,
    duplicate: 0,
  };
  for (const f of findings) counts[f.kind] += 1;
  return {
    id: "h-1",
    projectId: "p1",
    generatedAt: 1_700_000_000,
    actions: { closedEpics: [], rowsRecomputed: 0 },
    findings,
    counts,
    ...o,
  };
}

function trajectory(worstScore: number): ReviewTrajectory {
  const worst: ScoredTarget = { id: "anton-bad", title: "bad one", score: worstScore };
  return { recent: [worst], average: worstScore, worst, scored: 1 };
}

describe("rankAttention", () => {
  it("puts what STOPPED above everything else", () => {
    // A dependency cycle is real, but nobody is blocked on the operator to fix it this minute; a
    // parked run is waiting on a decision only they can make.
    const { items } = rankAttention({
      escalations: [escalation()],
      hygiene: report([finding("dep-cycle", "anton-a")]),
    });

    expect(items.map((i) => i.source)).toEqual(["escalation", "hygiene"]);
    expect(items[0].severity).toBe("stopped");
    expect(items[1].severity).toBe("attention");
  });

  it("promotes only the findings that make the board misreport itself", () => {
    // bd ready can't order a ring, and an in_progress bead with no lease reads as in-flight to every
    // other machine. The rest cost nothing until someone gets to them.
    const { items, housekeeping } = rankAttention({
      hygiene: report([
        finding("lint", "anton-a"),
        finding("dep-cycle", "anton-b"),
        finding("stale-open", "anton-c"),
        finding("stale-in-progress", "anton-d"),
        finding("orphan", "anton-e"),
        finding("duplicate", "anton-f"),
      ]),
    });

    expect(items).toHaveLength(2);
    expect(items.every((i) => i.source === "hygiene" && i.severity === "attention")).toBe(true);
    expect(housekeeping).toHaveLength(4);
    expect(housekeeping.every((i) => i.severity === "housekeeping")).toBe(true);
  });

  it("promotes the worst review score only when it landed in the rework band", () => {
    expect(rankAttention({ trajectory: trajectory(REWORK_SCORE_CEILING - 1) }).items).toHaveLength(1);
    // At the ceiling the contract calls it acceptable-with-gaps: it belongs in the trend, not here.
    expect(rankAttention({ trajectory: trajectory(REWORK_SCORE_CEILING) }).items).toHaveLength(0);
    expect(rankAttention({ trajectory: trajectory(9) }).items).toHaveLength(0);
  });

  it("orders review above hygiene inside the same band, deterministically", () => {
    const { items } = rankAttention({
      hygiene: report([finding("dep-cycle", "anton-a")]),
      trajectory: trajectory(2),
    });
    expect(items.map((i) => i.source)).toEqual(["review", "hygiene"]);
  });

  it("preserves each producer's own order inside a band", () => {
    // openEscalations sorts by age and sortFindings by kind-then-key; re-sorting here would make two
    // renders of an unchanged board differ.
    const { housekeeping } = rankAttention({
      hygiene: report([
        finding("lint", "anton-c"),
        finding("lint", "anton-a"),
        finding("orphan", "anton-b"),
      ]),
    });
    expect(housekeeping.map((i) => i.key)).toEqual([
      "hygiene:lint:anton-c",
      "hygiene:lint:anton-a",
      "hygiene:orphan:anton-b",
    ]);
  });

  it("counts every band, including the folded one", () => {
    const { counts } = rankAttention({
      escalations: [escalation(), escalation({ id: "esc-2" })],
      hygiene: report([finding("dep-cycle", "anton-a"), finding("lint", "anton-b")]),
    });
    expect(counts).toEqual({ stopped: 2, attention: 1, housekeeping: 1 });
  });

  describe("clean vs never checked", () => {
    it("reports nothing at all when no producer has ever run", () => {
      const summary = rankAttention({});
      expect(summary.reported).toBe(false);
      expect(summary.clean).toBe(false);
    });

    it("calls a patrolled board with no findings clean", () => {
      const summary = rankAttention({ hygiene: report([]) });
      expect(summary.reported).toBe(true);
      expect(summary.clean).toBe(true);
    });

    it("counts a scored project as checked even with no patrol", () => {
      expect(rankAttention({ trajectory: trajectory(9) }).clean).toBe(true);
    });

    it("never calls a board with an open escalation clean", () => {
      // An escalation only exists when something IS wrong, so it can't stand in for a check.
      const summary = rankAttention({ escalations: [escalation()] });
      expect(summary.reported).toBe(true);
      expect(summary.clean).toBe(false);
    });
  });
});

describe("hasAppliedActions", () => {
  it("is true only when the patrol actually wrote something", () => {
    expect(hasAppliedActions(undefined)).toBe(false);
    expect(hasAppliedActions(report([]))).toBe(false);
    expect(
      hasAppliedActions(report([], { actions: { closedEpics: ["anton-e1"], rowsRecomputed: 0 } })),
    ).toBe(true);
    expect(
      hasAppliedActions(report([], { actions: { closedEpics: [], rowsRecomputed: 4 } })),
    ).toBe(true);
  });
});
