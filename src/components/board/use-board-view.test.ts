// @vitest-environment jsdom
/**
 * The derivation behind both board arrangements — and specifically what the grouping decides about
 * the Up Next lane (anton-wds3).
 *
 * The rule is deliberate and it is unchanged: the lane is a COLUMN POSITION between Backlog and
 * Implementing, so it exists in the stage view and nowhere else. What these tests pin is that the
 * grouping is honoured from the first derivation — no lane is ever computed for an epic-grouped
 * board — while the picks keep everything the lane would have carried: their marks, and the
 * generation a verdict has to name.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

import { STAGES, type Board, type Epic, type StandaloneItem } from "@/lib/types";
import { makeEpicRow } from "@/components/board/epic.fixture";
import { useBoardView } from "@/components/board/use-board-view";
import { emptyStageMap } from "@/components/board/board-utils";

// Narrowing lives in the URL and is orthogonal to the grouping; this suite runs unfiltered.
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

const PLAN_ID = "plan-gen-7";

function chip(id: string): StandaloneItem {
  return {
    id,
    title: id,
    type: "bug",
    status: "open",
    stage: "backlog",
    approved: false,
    assignee: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    createdBy: null,
    blockedBy: [],
    ready: true,
    unread: false,
    deferred: false,
    abandoned: false,
    provenance: [{ kind: "policy" }],
  };
}

/** Two picks — a run target and a loose chip — drawn from a recorded plan, plus an unpicked card. */
function picked(): Board {
  const columns = emptyStageMap<Epic>();
  columns.backlog = [
    makeEpicRow("anton-1", { provenance: [{ kind: "policy" }] }),
    makeEpicRow("anton-2"),
  ];
  const standalone = emptyStageMap<StandaloneItem>();
  standalone.backlog = [chip("anton-t3x")];

  return {
    projectSlug: "tmp",
    version: "1:sync",
    columns,
    standalone,
    operatorQueue: [],
    upNext: [
      { beadId: "anton-1", rank: 1, priority: 2, type: "feature", unblocks: 0, createdAt: "2026-08-01T00:00:00.000Z" },
      { beadId: "anton-t3x", rank: 2, priority: 2, type: "bug", unblocks: 0, createdAt: "2026-08-01T00:00:00.000Z" },
    ],
    upNextPlanId: PLAN_ID,
    sync: {
      state: "synced",
      lastSyncedAt: 1,
      lastPushedAt: 1,
      unpushedCount: 0,
      lastError: null,
      stalledForMs: null,
    },
  };
}

function view(board: Board | null, grouping: "stage" | "epic") {
  return renderHook(() => useBoardView(board, "default", grouping)).result.current;
}

/**
 * Every id the chosen arrangement puts on screen, so "exactly once" can be asserted rather than
 * assumed. The canvas draws the swimlanes OR the stage grid, never both, so this reads whichever
 * side the grouping selected — plus the lane, which only the stage grid has.
 */
function rendered(v: ReturnType<typeof view>): string[] {
  const ids = v.lanes
    ? v.lanes.flatMap((lane) =>
        STAGES.flatMap((stage) => [
          ...lane.columns[stage].map((e) => e.id),
          ...lane.standalone[stage].map((i) => i.id),
        ]),
      )
    : STAGES.flatMap((stage) => [
        ...v.columns[stage].map((e) => e.id),
        ...v.standalone[stage].map((i) => i.id),
      ]);
  return [...ids, ...v.upNext.map((c) => c.entry.beadId)].sort();
}

afterEach(cleanup);

describe("useBoardView grouping (anton-wds3)", () => {
  it("draws the lane in the stage view, out of the Backlog it took the picks from", () => {
    const v = view(picked(), "stage");

    expect(v.upNext.map((c) => c.entry.beadId)).toEqual(["anton-1", "anton-t3x"]);
    expect(v.columns.backlog.map((e) => e.id)).toEqual(["anton-2"]);
    expect(v.standalone.backlog).toEqual([]);
    expect(v.lanes).toBeNull();
    // Every bead once, whichever arrangement is on (R3.3).
    expect(rendered(v)).toEqual(["anton-1", "anton-2", "anton-t3x"]);
  });

  it("computes NO lane in epic grouping — not for a frame — and leaves the picks in Backlog", () => {
    const v = view(picked(), "epic");

    expect(v.upNext).toEqual([]);
    expect(v.upNextPlan).toEqual([]);
    expect(v.lanes).not.toBeNull();
    expect(rendered(v)).toEqual(["anton-1", "anton-2", "anton-t3x"]);
  });

  it("keeps the picks' marks and their generation in either grouping", () => {
    const marks = (v: ReturnType<typeof view>) =>
      (v.lanes ?? []).flatMap((lane) => lane.columns.backlog).concat(v.columns.backlog);

    for (const grouping of ["stage", "epic"] as const) {
      const v = view(picked(), grouping);
      // The generation rides the board, not the lane: without it a Release posted from the swimlanes
      // would name no plan at all.
      expect(v.planId).toBe(PLAN_ID);
      const picks = [...marks(v), ...v.upNext.map((c) => (c.kind === "epic" ? c.epic : c.item))];
      expect(picks.find((p) => p.id === "anton-1")?.provenance).toEqual([{ kind: "policy" }]);
    }
  });

  it("places the lane's budget line on the UNFILTERED plan, hidden picks included", () => {
    expect(view(picked(), "stage").upNextPlan).toEqual(["anton-1", "anton-t3x"]);
  });

  it("survives a board that has not loaded yet", () => {
    const v = view(null, "epic");

    expect(v.upNext).toEqual([]);
    expect(v.planId).toBeUndefined();
    expect(v.lanes).toEqual([]);
  });
});
