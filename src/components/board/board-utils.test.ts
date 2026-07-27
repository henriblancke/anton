import { describe, expect, it } from "vitest";
import {
  STAGE_ACCENT_DOT,
  STAGE_LABELS,
  boardAreaOptions,
  boardEpicFilterHref,
  boardEpicOptions,
  boardFiltersFromSearchParams,
  boardFiltersQueryString,
  compareBacklogEpics,
  filterBoard,
  groupBoardByEpic,
  moveEpicBetweenColumns,
  sortEpics,
  ticketProgress,
} from "@/components/board/board-utils";
import { STAGES, type Epic, type Stage, type StandaloneItem, type Ticket } from "@/lib/types";

function makeTicket(id: string, over: Partial<Ticket> = {}): Ticket {
  return {
    id,
    title: id,
    status: "open",
    stage: "backlog",
    assignee: null,
    createdAt: "",
    createdBy: null,
    deferred: false,
    abandoned: false,
    ...over,
  };
}

/** A ready, rank-0 backlog epic; override the dependency/sort fields per test. */
function makeEpic(id: string, over: Partial<Epic> = {}): Epic {
  return {
    id,
    title: id,
    type: "feature",
    approved: false,
    stage: "backlog",
    assignee: null,
    createdAt: "",
    createdBy: null,
    blockedBy: [],
    ready: true,
    rank: 0,
    priority: 4,
    abandoned: false,
    tickets: [],
    ...over,
  };
}

describe("ticketProgress", () => {
  it("counts done tickets against the total", () => {
    const tickets = [makeTicket("a", { stage: "done" }), makeTicket("b")];
    expect(ticketProgress({ tickets })).toEqual({ done: 1, total: 2, pct: 50 });
  });

  it("drops abandoned tickets from both sides — won't-do work is out of scope, not shipped", () => {
    const tickets = [
      makeTicket("a", { stage: "done" }),
      makeTicket("b", { stage: "done", status: "closed", abandoned: true }),
    ];
    // The abandoned ticket neither inflates `done` nor holds the epic below 100%.
    expect(ticketProgress({ tickets })).toEqual({ done: 1, total: 1, pct: 100 });
  });
});

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

  it("sinks a lone unknown tier last even when its id sorts first", () => {
    // Exactly one side is unknown → the delta is ±Infinity, not NaN. The unknown epic must
    // still sink last despite a lexically smaller id winning every compareBacklogEpics tiebreak.
    const labelled = makeEpic("zeta", { risk: "high" });
    const unlabelled = makeEpic("aaa");
    expect(sortEpics([unlabelled, labelled], "risk").map((e) => e.id)).toEqual([
      "zeta",
      "aaa",
    ]);
  });

  it("falls back to dependency-aware order when both epics have unknown risk/size", () => {
    // Both lack a risk label → tierRank returns Infinity on each side and the delta is NaN;
    // the comparator must fall through to compareBacklogEpics (rank order here), not freeze
    // the input order.
    const blocker = makeEpic("blocker", { rank: 0 });
    const dependent = makeEpic("dependent", { rank: 1 });
    expect(sortEpics([dependent, blocker], "risk").map((e) => e.id)).toEqual([
      "blocker",
      "dependent",
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

describe("groupBoardByEpic", () => {
  const ONTOLOGY = { id: "anton-b", title: "Ontology editing" };
  const RETRIEVAL = { id: "anton-a", title: "Trustworthy retrieval" };

  function makeColumns(over: Partial<Record<Stage, Epic[]>> = {}): Record<Stage, Epic[]> {
    return { backlog: [], implementing: [], "in-review": [], done: [], ...over };
  }

  it("sorts epic lanes by title and always sinks the No epic lane last", () => {
    const lanes = groupBoardByEpic(
      makeColumns({
        backlog: [
          makeEpic("loose", {}),
          makeEpic("o1", { epic: ONTOLOGY }),
          makeEpic("r1", { epic: RETRIEVAL }),
        ],
      }),
    );
    // Alphabetical by title (not id, and not board order) so a lane keeps its place as cards move.
    expect(lanes.map((l) => l.epic?.id ?? "none")).toEqual([ONTOLOGY.id, RETRIEVAL.id, "none"]);
  });

  it("keeps each card in its own stage column and preserves the order it was given", () => {
    const lanes = groupBoardByEpic(
      makeColumns({
        backlog: [makeEpic("first", { epic: ONTOLOGY }), makeEpic("second", { epic: ONTOLOGY })],
        done: [makeEpic("shipped", { epic: ONTOLOGY, stage: "done" })],
      }),
    );
    expect(lanes[0].columns.backlog.map((e) => e.id)).toEqual(["first", "second"]);
    expect(lanes[0].columns.done.map((e) => e.id)).toEqual(["shipped"]);
    expect(lanes[0].columns.implementing).toEqual([]);
  });

  it("rolls a lane up as shipped-of-total, with abandoned cards out of both sides", () => {
    const lanes = groupBoardByEpic(
      makeColumns({
        backlog: [makeEpic("open", { epic: ONTOLOGY })],
        done: [
          makeEpic("shipped", { epic: ONTOLOGY, stage: "done" }),
          makeEpic("wontdo", { epic: ONTOLOGY, stage: "done", abandoned: true }),
        ],
      }),
    );
    // The won't-do card neither inflates `shipped` nor pins the lane below 100% forever.
    expect(lanes[0]).toMatchObject({ features: 2, shipped: 1 });
    // It still renders — the lane shows the work, the rollup counts the deliveries.
    expect(lanes[0].columns.done.map((e) => e.id)).toEqual(["shipped", "wontdo"]);
  });

  it("collects standalone chips in the No epic lane — they are parentless by definition", () => {
    const chip = {
      id: "anton-t3x",
      title: "chip",
      type: "bug" as const,
      status: "open",
      stage: "backlog" as Stage,
      approved: false,
      assignee: null,
      createdAt: "",
      createdBy: null,
      blockedBy: [],
      ready: true,
      unread: false,
      deferred: false,
      abandoned: false,
    };
    const lanes = groupBoardByEpic(
      makeColumns({ backlog: [makeEpic("o1", { epic: ONTOLOGY })] }),
      { backlog: [chip], implementing: [], "in-review": [], done: [] },
    );
    const noEpic = lanes[lanes.length - 1];
    expect(noEpic.epic).toBeUndefined();
    expect(noEpic.standalone.backlog.map((i) => i.id)).toEqual(["anton-t3x"]);
    expect(noEpic.loose).toBe(1);
  });

  it("returns no lanes for an empty board rather than an empty No epic lane", () => {
    expect(groupBoardByEpic(makeColumns())).toEqual([]);
  });
});

describe("board filters (anton-9pkk.3)", () => {
  const ONTOLOGY = { id: "anton-b", title: "Ontology editing", area: "ontology" };
  const RETRIEVAL = { id: "anton-a", title: "Trustworthy retrieval", area: "knowledge" };
  /** A designated-nothing epic — today's board, before anyone tags an `area:`. */
  const UNDESIGNATED = { id: "anton-c", title: "Prune the board" };

  function makeColumns(over: Partial<Record<Stage, Epic[]>> = {}): Record<Stage, Epic[]> {
    return { backlog: [], implementing: [], "in-review": [], done: [], ...over };
  }

  function makeChip(id: string): StandaloneItem {
    return {
      id,
      title: id,
      type: "bug",
      status: "open",
      stage: "backlog",
      approved: false,
      assignee: null,
      createdAt: "",
      createdBy: null,
      blockedBy: [],
      ready: true,
      unread: false,
      deferred: false,
      abandoned: false,
    };
  }

  const columns = makeColumns({
    backlog: [
      makeEpic("o1", { epic: ONTOLOGY }),
      makeEpic("r1", { epic: RETRIEVAL }),
      makeEpic("loose"),
    ],
    done: [makeEpic("o2", { epic: ONTOLOGY, stage: "done" })],
  });

  it("narrows the board to one product epic, across every stage column", () => {
    const { columns: narrowed } = filterBoard(columns, undefined, { epic: ONTOLOGY.id });
    expect(narrowed.backlog.map((e) => e.id)).toEqual(["o1"]);
    expect(narrowed.done.map((e) => e.id)).toEqual(["o2"]);
  });

  it("narrows to a legacy epic by the card's own id — its roadmap row must not open an empty board", () => {
    // A legacy epic (no feature children) IS the board card, so it carries no parent epic crumb.
    // The roadmap links every row as `?epic=<row.id>`; keying only on the crumb would hide the card.
    const legacy = makeEpic(UNDESIGNATED.id, { title: UNDESIGNATED.title });
    const board = makeColumns({ backlog: [...columns.backlog, legacy] });
    const { columns: narrowed } = filterBoard(board, undefined, { epic: UNDESIGNATED.id });
    expect(narrowed.backlog.map((e) => e.id)).toEqual([UNDESIGNATED.id]);
  });

  it("narrows by area — one filter, every epic on that product surface", () => {
    const { columns: narrowed } = filterBoard(columns, undefined, { area: "knowledge" });
    expect(narrowed.backlog.map((e) => e.id)).toEqual(["r1"]);
    expect(narrowed.done).toEqual([]);
  });

  it("drops standalone chips while any filter is active — they carry no epic to match", () => {
    const chips = { backlog: [makeChip("anton-t3x")], implementing: [], "in-review": [], done: [] };
    expect(filterBoard(columns, chips, {}).standalone.backlog.map((i) => i.id)).toEqual([
      "anton-t3x",
    ]);
    expect(filterBoard(columns, chips, { epic: ONTOLOGY.id }).standalone.backlog).toEqual([]);
  });

  it("returns the board untouched when nothing is filtered", () => {
    const { columns: narrowed } = filterBoard(columns, undefined, {});
    expect(narrowed.backlog.map((e) => e.id)).toEqual(["o1", "r1", "loose"]);
  });

  it("offers every epic and area on the board as options, sorted for scanning", () => {
    const withUndesignated = makeColumns({
      backlog: [...columns.backlog, makeEpic("u1", { epic: UNDESIGNATED })],
      done: columns.done,
    });
    // Sorted by title, deduped across stages — "Ontology editing" appears on two cards.
    expect(boardEpicOptions(withUndesignated).map((e) => e.title)).toEqual([
      "Ontology editing",
      "Prune the board",
      "Trustworthy retrieval",
    ]);
    // An epic with no `area:` contributes no facet value rather than an empty one.
    expect(boardAreaOptions(withUndesignated)).toEqual(["knowledge", "ontology"]);
  });

  it("round-trips through the URL, preserving params the filter bar does not own", () => {
    expect(boardFiltersQueryString({ epic: ONTOLOGY.id, area: "ontology" })).toBe(
      `?epic=${ONTOLOGY.id}&area=ontology`,
    );
    // Clearing a facet removes the key instead of blanking it, and leaves `sort` alone.
    expect(boardFiltersQueryString({ area: "ontology" }, "sort=risk&epic=anton-b")).toBe(
      "?sort=risk&area=ontology",
    );
    expect(boardFiltersQueryString({}, "epic=anton-b")).toBe("");
    expect(
      boardFiltersFromSearchParams(new URLSearchParams("epic=anton-b&area=ontology&sort=risk")),
    ).toEqual({ epic: "anton-b", area: "ontology" });
  });

  it("points every epic badge at the same filtered-board URL the facets write", () => {
    const href = boardEpicFilterHref("tmp", ONTOLOGY.id);
    expect(href).toBe(`/projects/tmp?epic=${ONTOLOGY.id}`);
    expect(boardFiltersFromSearchParams(new URLSearchParams(href.split("?")[1]))).toEqual({
      epic: ONTOLOGY.id,
    });
  });
});
