/**
 * The timeline's event model and fold (anton-uxgze), tested where it can lie: every source maps to
 * the right kind, an unrecognized status fails loud rather than vanishing, the merge sorts by time
 * without reshuffling a tie, and a ticket resolves to the feature riding above it.
 */
import { describe, expect, it } from "vitest";

import { foldTimeline, type TimelineSourceRow } from "./timeline";
import type { Bead } from "./beads/bd";

const bead = (b: Partial<Bead>): Bead =>
  ({
    id: "x",
    title: "x",
    status: "open",
    issue_type: "task",
    labels: [],
    created_at: "2026-08-01T00:00:00.000Z",
    ...b,
  }) as Bead;

describe("foldTimeline — one row per source", () => {
  it("maps a run row to a started event, and a PR-opened event only when it has one", () => {
    const withoutPr: TimelineSourceRow = {
      source: "run",
      id: "run-1",
      projectId: "p1",
      ticketBeadId: null,
      startedAt: 100,
      prOpenedAt: null,
    };
    expect(foldTimeline([withoutPr], [])).toEqual([
      { at: 100, projectId: "p1", featureId: null, kind: "run.started", data: {}, sourceRefs: ["run-1"] },
    ]);

    const withPr: TimelineSourceRow = { ...withoutPr, id: "run-2", prOpenedAt: 150 };
    expect(foldTimeline([withPr], [])).toEqual([
      { at: 100, projectId: "p1", featureId: null, kind: "run.started", data: {}, sourceRefs: ["run-2"] },
      {
        at: 150,
        projectId: "p1",
        featureId: null,
        kind: "run.pr_opened",
        data: {},
        sourceRefs: ["run-2"],
      },
    ]);
  });

  it("maps every run_attempt outcome to its kind, and reports nothing for a still-running attempt", () => {
    const base: TimelineSourceRow = {
      source: "run_attempt",
      id: "att-1",
      projectId: "p1",
      ticketBeadId: null,
      outcome: null,
      endedAt: null,
    };
    expect(foldTimeline([base], [])).toEqual([]);

    const cases: Array<[string, string]> = [
      ["parked", "run.parked"],
      ["done", "run.finished"],
      ["failed", "run.failed"],
    ];
    for (const [outcome, kind] of cases) {
      const row: TimelineSourceRow = { ...base, outcome, endedAt: 200 };
      expect(foldTimeline([row], [])).toEqual([
        { at: 200, projectId: "p1", featureId: null, kind, data: { outcome }, sourceRefs: ["att-1"] },
      ]);
    }
  });

  it("maps an escalation to raised, and to raised+resolved once it settles", () => {
    const open: TimelineSourceRow = {
      source: "escalation",
      id: "esc-1",
      projectId: "p1",
      ticketBeadId: null,
      raisedAt: 10,
      resolvedAt: null,
    };
    expect(foldTimeline([open], [])).toEqual([
      {
        at: 10,
        projectId: "p1",
        featureId: null,
        kind: "escalation.raised",
        data: {},
        sourceRefs: ["esc-1"],
      },
    ]);

    const settled: TimelineSourceRow = { ...open, resolvedAt: 20 };
    expect(foldTimeline([settled], [])).toEqual([
      {
        at: 10,
        projectId: "p1",
        featureId: null,
        kind: "escalation.raised",
        data: {},
        sourceRefs: ["esc-1"],
      },
      {
        at: 20,
        projectId: "p1",
        featureId: null,
        kind: "escalation.resolved",
        data: {},
        sourceRefs: ["esc-1"],
      },
    ]);
  });

  it("maps a picker start and a picker verdict, carrying the verdict word in data", () => {
    const start: TimelineSourceRow = {
      source: "picker_start",
      id: "ps-1",
      projectId: "p1",
      beadId: null,
      startedAt: 5,
    };
    expect(foldTimeline([start], [])).toEqual([
      { at: 5, projectId: "p1", featureId: null, kind: "picker.started", data: {}, sourceRefs: ["ps-1"] },
    ]);

    const verdict: TimelineSourceRow = {
      source: "picker_verdict",
      id: "pv-1",
      projectId: "p1",
      beadId: null,
      verdict: "accepted",
      decidedAt: 6,
    };
    expect(foldTimeline([verdict], [])).toEqual([
      {
        at: 6,
        projectId: "p1",
        featureId: null,
        kind: "picker.verdict",
        data: { verdict: "accepted" },
        sourceRefs: ["pv-1"],
      },
    ]);
  });

  it("maps an autopilot disarm with no feature — the autopilot is project-wide", () => {
    const row: TimelineSourceRow = {
      source: "autopilot_disarm",
      id: "ad-1",
      projectId: "p1",
      disarmedAt: 7,
    };
    expect(foldTimeline([row], [])).toEqual([
      {
        at: 7,
        projectId: "p1",
        featureId: null,
        kind: "autopilot.disarmed",
        data: {},
        sourceRefs: ["ad-1"],
      },
    ]);
  });

  it("maps every proposal outcome to its kind", () => {
    const cases: Array<[string, string]> = [
      ["filed", "proposal.filed"],
      ["applied", "proposal.applied"],
      ["refused", "proposal.refused"],
    ];
    for (const [outcome, kind] of cases) {
      const row: TimelineSourceRow = {
        source: "proposal",
        id: "prop-1",
        projectId: "p1",
        ticketBeadId: null,
        outcome,
        at: 8,
      };
      expect(foldTimeline([row], [])).toEqual([
        { at: 8, projectId: "p1", featureId: null, kind, data: {}, sourceRefs: ["prop-1"] },
      ]);
    }
  });

  it("maps a scan summary with no feature — it is about the whole project", () => {
    const row: TimelineSourceRow = {
      source: "scan_summary",
      id: "scan-1",
      projectId: "p1",
      generatedAt: 9,
    };
    expect(foldTimeline([row], [])).toEqual([
      { at: 9, projectId: "p1", featureId: null, kind: "scan.summary", data: {}, sourceRefs: ["scan-1"] },
    ]);
  });

  it("maps a bead closed and a PR merged row, straight off the caller's bd snapshot", () => {
    const closed: TimelineSourceRow = {
      source: "bead_closed",
      id: "t1",
      projectId: "p1",
      ticketBeadId: null,
      closedAt: 11,
    };
    expect(foldTimeline([closed], [])).toEqual([
      { at: 11, projectId: "p1", featureId: null, kind: "bead.closed", data: {}, sourceRefs: ["t1"] },
    ]);

    const merged: TimelineSourceRow = {
      source: "pr_merged",
      id: "t1",
      projectId: "p1",
      ticketBeadId: null,
      mergedAt: 12,
    };
    expect(foldTimeline([merged], [])).toEqual([
      { at: 12, projectId: "p1", featureId: null, kind: "pr.merged", data: {}, sourceRefs: ["t1"] },
    ]);
  });
});

describe("foldTimeline — an unmapped source row fails loud", () => {
  it("throws on a run_attempt outcome outside the known vocabulary", () => {
    const row: TimelineSourceRow = {
      source: "run_attempt",
      id: "att-x",
      projectId: "p1",
      ticketBeadId: null,
      // A value a drifted DB text column could hold but this module has never declared a kind for.
      outcome: "cancelled",
      endedAt: 1,
    };
    expect(() => foldTimeline([row], [])).toThrow(/unmapped run_attempt outcome "cancelled"/);
  });

  it("throws on a proposal outcome outside the known vocabulary", () => {
    const row: TimelineSourceRow = {
      source: "proposal",
      id: "prop-x",
      projectId: "p1",
      ticketBeadId: null,
      outcome: "superseded",
      at: 1,
    };
    expect(() => foldTimeline([row], [])).toThrow(/unmapped proposal outcome "superseded"/);
  });

  it("throws on a row whose source tag matches nothing this module knows", () => {
    const row = { source: "unknown_source", id: "u-1", projectId: "p1" } as unknown as TimelineSourceRow;
    expect(() => foldTimeline([row], [])).toThrow(/unmapped source row/);
  });
});

describe("foldTimeline — ordering", () => {
  it("sorts the merged events by time", () => {
    const rows: TimelineSourceRow[] = [
      { source: "scan_summary", id: "s1", projectId: "p1", generatedAt: 30 },
      { source: "scan_summary", id: "s2", projectId: "p1", generatedAt: 10 },
      { source: "scan_summary", id: "s3", projectId: "p1", generatedAt: 20 },
    ];
    expect(foldTimeline(rows, []).map((e) => e.sourceRefs[0])).toEqual(["s2", "s3", "s1"]);
  });

  it("is stable on a tie: equal timestamps keep the relative order they arrived in", () => {
    const a: TimelineSourceRow = { source: "scan_summary", id: "a", projectId: "p1", generatedAt: 5 };
    const b: TimelineSourceRow = { source: "autopilot_disarm", id: "b", projectId: "p1", disarmedAt: 5 };

    expect(foldTimeline([a, b], []).map((e) => e.sourceRefs[0])).toEqual(["a", "b"]);
    // Same two events, fed in the opposite order — a correct stable sort never reshuffles the tie
    // back to some other "canonical" order; it just leaves the merge's own input order alone.
    expect(foldTimeline([b, a], []).map((e) => e.sourceRefs[0])).toEqual(["b", "a"]);
  });
});

describe("foldTimeline — resolves ticket to feature", () => {
  it("resolves a ticket's event to the feature it rides on", () => {
    const board = [
      bead({ id: "f1", title: "Ship billing", issue_type: "feature", labels: ["approved"] }),
      bead({ id: "f1.1", issue_type: "task", parent: "f1" }),
    ];
    const row: TimelineSourceRow = {
      source: "bead_closed",
      id: "f1.1",
      projectId: "p1",
      ticketBeadId: "f1.1",
      closedAt: 1,
    };
    const [onlyEvent] = foldTimeline([row], board);
    expect(onlyEvent.featureId).toBe("f1");
  });

  it("resolves a GRANDCHILD ticket to the feature too, same as boardCards.cardOf", () => {
    const board = [
      bead({ id: "f1", title: "Ship billing", issue_type: "feature", labels: ["approved"] }),
      bead({ id: "f1.1", issue_type: "task", parent: "f1" }),
      bead({ id: "f1.1.1", issue_type: "task", parent: "f1.1" }),
    ];
    const row: TimelineSourceRow = {
      source: "run_attempt",
      id: "att-1",
      projectId: "p1",
      ticketBeadId: "f1.1.1",
      outcome: "done",
      endedAt: 1,
    };
    const [onlyEvent] = foldTimeline([row], board);
    expect(onlyEvent.featureId).toBe("f1");
  });

  it("resolves to null when the ticket rides on no card, or the id is unknown to the snapshot", () => {
    // c1 is a CONTAINER epic (it has a feature child), so it is not itself a card — a task
    // parented directly on it rides on no run at all (ticket-view.ts's boardCards.cardOf).
    const board = [
      bead({ id: "c1", issue_type: "epic", labels: [] }),
      bead({ id: "f1", issue_type: "feature", parent: "c1", labels: ["approved"] }),
      bead({ id: "c1.1", issue_type: "task", parent: "c1" }),
    ];
    const underContainerEpic: TimelineSourceRow = {
      source: "escalation",
      id: "esc-1",
      projectId: "p1",
      ticketBeadId: "c1.1",
      raisedAt: 1,
      resolvedAt: null,
    };
    expect(foldTimeline([underContainerEpic], board)[0].featureId).toBeNull();

    const unknownTicket: TimelineSourceRow = {
      source: "escalation",
      id: "esc-2",
      projectId: "p1",
      ticketBeadId: "ghost",
      raisedAt: 1,
      resolvedAt: null,
    };
    expect(foldTimeline([unknownTicket], board)[0].featureId).toBeNull();
  });

  it("resolves to null when the row carries no ticket at all", () => {
    const row: TimelineSourceRow = {
      source: "pr_merged",
      id: "t1",
      projectId: "p1",
      ticketBeadId: null,
      mergedAt: 1,
    };
    expect(foldTimeline([row], [])[0].featureId).toBeNull();
  });
});
