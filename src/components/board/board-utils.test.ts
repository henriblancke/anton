import { describe, expect, it } from "vitest";
import {
  STAGE_ACCENT_DOT,
  STAGE_LABELS,
  compareBacklogEpics,
  moveEpicBetweenColumns,
  sortEpics,
} from "@/components/board/board-utils";
import { STAGES, type Epic, type Stage } from "@/lib/types";

/** A ready, rank-0 backlog epic; override the dependency/sort fields per test. */
function makeEpic(id: string, over: Partial<Epic> = {}): Epic {
  return {
    id,
    title: id,
    approved: false,
    stage: "backlog",
    assignee: null,
    createdAt: "",
    createdBy: null,
    blockedBy: [],
    ready: true,
    rank: 0,
    priority: 4,
    tickets: [],
    ...over,
  };
}

describe("STAGE_LABELS", () => {
  it("has a human label for every stage", () => {
    for (const stage of STAGES) {
      expect(STAGE_LABELS[stage]).toBeTruthy();
    }
  });
});

describe("STAGE_ACCENT_DOT", () => {
  it("has an accent class for every stage", () => {
    for (const stage of STAGES) {
      expect(STAGE_ACCENT_DOT[stage]).toBeTruthy();
    }
  });
});

describe("compareBacklogEpics", () => {
  it("orders ready-first, then rank, then priority, then createdAt", () => {
    const ready = makeEpic("ready", { ready: true, rank: 5 });
    const blocked = makeEpic("blocked", { ready: false, blockedBy: ["x"], rank: 0 });
    // Ready beats a lower-rank blocked epic.
    expect([blocked, ready].sort(compareBacklogEpics).map((e) => e.id)).toEqual(["ready", "blocked"]);

    // Among ready epics, a blocker (lower rank) precedes what it blocks (higher rank).
    const blocker = makeEpic("blocker", { rank: 0 });
    const dependent = makeEpic("dependent", { rank: 1 });
    expect([dependent, blocker].sort(compareBacklogEpics).map((e) => e.id)).toEqual([
      "blocker",
      "dependent",
    ]);

    // Same rank → priority (0=critical wins) → createdAt tiebreak.
    const p0 = makeEpic("p0", { priority: 0, createdAt: "2026-01-02" });
    const p2 = makeEpic("p2", { priority: 2, createdAt: "2026-01-01" });
    expect([p2, p0].sort(compareBacklogEpics).map((e) => e.id)).toEqual(["p0", "p2"]);
  });
});

describe("sortEpics", () => {
  it("leaves order untouched for the default sort", () => {
    const epics = [makeEpic("b"), makeEpic("a"), makeEpic("c")];
    expect(sortEpics(epics, "default")).toBe(epics);
  });

  it("orders by risk high→low, unknown/absent last", () => {
    const high = makeEpic("high", { risk: "high" });
    const med = makeEpic("med", { risk: "med" });
    const low = makeEpic("low", { risk: "low" });
    const none = makeEpic("none");
    expect(sortEpics([low, none, high, med], "risk").map((e) => e.id)).toEqual([
      "high",
      "med",
      "low",
      "none",
    ]);
  });

  it("orders by size large→small", () => {
    const l = makeEpic("l", { size: "L" });
    const m = makeEpic("m", { size: "M" });
    const s = makeEpic("s", { size: "S" });
    expect(sortEpics([s, l, m], "size").map((e) => e.id)).toEqual(["l", "m", "s"]);
  });

  it("always sinks blocked epics to the bottom regardless of criteria", () => {
    // A blocked high-risk epic must still fall below every ready epic.
    const blockedHigh = makeEpic("blocked-high", { risk: "high", ready: false, blockedBy: ["x"] });
    const readyLow = makeEpic("ready-low", { risk: "low", ready: true });
    const readyMed = makeEpic("ready-med", { risk: "med", ready: true });
    expect(sortEpics([blockedHigh, readyLow, readyMed], "risk").map((e) => e.id)).toEqual([
      "ready-med",
      "ready-low",
      "blocked-high",
    ]);
  });

  it("does not mutate the input array", () => {
    const epics = [makeEpic("s", { size: "S" }), makeEpic("l", { size: "L" })];
    const before = epics.map((e) => e.id);
    sortEpics(epics, "size");
    expect(epics.map((e) => e.id)).toEqual(before);
  });
});

describe("moveEpicBetweenColumns", () => {
  function makeColumns(): Record<Stage, Epic[]> {
    return {
      backlog: [makeEpic("e1", { title: "Epic 1" })],
      implementing: [],
      "in-review": [],
      done: [],
    };
  }

  it("moves the epic to the target stage and updates its stage field", () => {
    const next = moveEpicBetweenColumns(makeColumns(), "e1", "implementing");
    expect(next.backlog).toEqual([]);
    expect(next.implementing).toHaveLength(1);
    expect(next.implementing[0]).toMatchObject({ id: "e1", stage: "implementing" });
  });

  it("is a no-op when the epic id doesn't exist", () => {
    const columns = makeColumns();
    const next = moveEpicBetweenColumns(columns, "missing", "done");
    expect(next).toEqual(columns);
  });

  it("prepends the moved epic in the destination column", () => {
    const columns = makeColumns();
    columns.done.push(makeEpic("e2", { title: "Epic 2", approved: true, stage: "done" }));
    const next = moveEpicBetweenColumns(columns, "e1", "done");
    expect(next.done.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("re-sorts a move that lands in the backlog into dependency-aware order", () => {
    // A blocked epic dragged back to the backlog must settle below the ready epics already there,
    // not jump to the top — the optimistic prepend is reconciled with compareBacklogEpics.
    const columns: Record<Stage, Epic[]> = {
      backlog: [makeEpic("ready-a", { rank: 0 }), makeEpic("ready-b", { rank: 1 })],
      implementing: [makeEpic("blocked", { ready: false, blockedBy: ["ready-a"], rank: 2 })],
      "in-review": [],
      done: [],
    };
    const next = moveEpicBetweenColumns(columns, "blocked", "backlog");
    expect(next.backlog.map((e) => e.id)).toEqual(["ready-a", "ready-b", "blocked"]);
    expect(next.implementing).toEqual([]);
  });
});
