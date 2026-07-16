/**
 * Unit tests for computeEpicGraph as a pure function over synthetic Bead[] (no bd spawn).
 * Covers the seven acceptance scenarios: direct edge, inferred ticket→epic rollup,
 * dedupe + self-edge drop, non-blocks types ignored, open vs closed blocker readiness, and
 * cycle degradation. Direction: an edge {from, to} means `from` is blocked by `to`.
 */
import { describe, expect, it } from "vitest";
import type { Bead, BeadDep } from "./beads/bd";
import { computeEpicGraph, epicStandaloneBlockers, standaloneBlockers } from "./epic-graph";

/** A parentless task/bug run target (epic-of-one) — no parent, so it never rolls up to an epic. */
function standalone(id: string, extra: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "task", ...extra };
}

function epic(id: string, extra: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "epic", ...extra };
}
function ticket(id: string, parent: string, extra: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "task", parent, ...extra };
}
/** A blocks edge — attach the returned dep to any bead's `dependencies`. `from` is blocked by `to`. */
function blocks(from: string, to: string, type = "blocks"): BeadDep {
  return { issue_id: from, depends_on_id: to, type };
}
function dep(from: string, to: string, type: string): BeadDep {
  return { issue_id: from, depends_on_id: to, type };
}

function graphOf(beads: Bead[]) {
  return computeEpicGraph(beads);
}
function node(g: ReturnType<typeof graphOf>, id: string) {
  const n = g.epics.find((e) => e.id === id);
  if (!n) throw new Error(`no epic node ${id}`);
  return n;
}

describe("computeEpicGraph", () => {
  it("derives a DIRECT epic→epic blocks edge with blockedBy/ready/rank", () => {
    const g = graphOf([epic("E1", { dependencies: [blocks("E1", "E2")] }), epic("E2")]);

    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ from: "E1", to: "E2", direct: true, inferred: false });
    expect(node(g, "E1").blockedBy).toEqual(["E2"]);
    expect(node(g, "E1").ready).toBe(false);
    expect(node(g, "E2").ready).toBe(true);
    // A blocker ranks before what it blocks.
    expect(node(g, "E2").rank).toBe(0);
    expect(node(g, "E1").rank).toBe(1);
    expect(g.hasCycle).toBe(false);
  });

  it("INFERS an epic→epic edge by rolling a ticket-level cross-epic block up to its epic", () => {
    const g = graphOf([
      epic("E1"),
      epic("E2"),
      ticket("T1", "E1", { dependencies: [blocks("T1", "T2")] }),
      ticket("T2", "E2"),
    ]);

    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ from: "E1", to: "E2", direct: false, inferred: true });
    expect(node(g, "E1").blockedBy).toEqual(["E2"]);
    expect(node(g, "E1").ready).toBe(false);
  });

  it("drops self-edges (both tickets under the same epic) and dedupes parallel rollups", () => {
    // Self-edge: T1 and T2 both live under E1 → epicOf collapses to E1 → dropped.
    const self = graphOf([
      epic("E1"),
      ticket("T1", "E1", { dependencies: [blocks("T1", "T2")] }),
      ticket("T2", "E1"),
    ]);
    expect(self.edges).toEqual([]);
    expect(node(self, "E1").ready).toBe(true);

    // Dedupe: two distinct ticket-level blocks both roll up to E1→E2 → one edge.
    const deduped = graphOf([
      epic("E1"),
      epic("E2"),
      ticket("A1", "E1", { dependencies: [blocks("A1", "B1")] }),
      ticket("A2", "E1", { dependencies: [blocks("A2", "B2")] }),
      ticket("B1", "E2"),
      ticket("B2", "E2"),
    ]);
    expect(deduped.edges).toHaveLength(1);
    expect(deduped.edges[0]).toMatchObject({ from: "E1", to: "E2" });
    expect(node(deduped, "E1").blockedBy).toEqual(["E2"]);
  });

  it("ignores related, discovered-from, and parent-child — only blocks orders epics", () => {
    const g = graphOf([
      epic("E1", {
        dependencies: [
          dep("E1", "E2", "related"),
          dep("E1", "E2", "discovered-from"),
        ],
      }),
      epic("E2"),
      ticket("T1", "E1", { dependencies: [dep("T1", "E1", "parent-child")] }),
    ]);

    expect(g.edges).toEqual([]);
    expect(node(g, "E1").ready).toBe(true);
    expect(node(g, "E2").ready).toBe(true);
  });

  it("counts a blocker as open only while its epic is not done", () => {
    const open = graphOf([epic("E1", { dependencies: [blocks("E1", "E2")] }), epic("E2")]);
    expect(node(open, "E1").blockedBy).toEqual(["E2"]);
    expect(node(open, "E1").ready).toBe(false);

    // A closed epic derives stage "done" → it no longer counts as an open blocker.
    const closed = graphOf([
      epic("E1", { dependencies: [blocks("E1", "E2")] }),
      epic("E2", { status: "closed" }),
    ]);
    expect(node(closed, "E1").blockedBy).toEqual([]);
    expect(node(closed, "E1").ready).toBe(true);
    // The structural edge still exists; only readiness stops counting it.
    expect(closed.edges).toHaveLength(1);
  });

  it("detects a cycle without throwing, flags the offending edges, and degrades rank", () => {
    const g = graphOf([
      epic("E1", { priority: 2, dependencies: [blocks("E1", "E2")] }),
      epic("E2", { priority: 0, dependencies: [blocks("E2", "E1")] }),
    ]);

    expect(g.hasCycle).toBe(true);
    expect(g.edges).toHaveLength(2);
    expect(g.edges.every((e) => e.inCycle)).toBe(true);
    // Rank degrades to a priority-then-created ordering (E2 is P0, so it ranks first).
    expect(node(g, "E2").rank).toBe(0);
    expect(node(g, "E1").rank).toBe(1);
  });

  it("ranks a linear chain topologically (blockers first)", () => {
    const g = graphOf([
      epic("E1", { dependencies: [blocks("E1", "E2")] }),
      epic("E2", { dependencies: [blocks("E2", "E3")] }),
      epic("E3"),
    ]);
    expect(g.hasCycle).toBe(false);
    expect(node(g, "E3").rank).toBe(0);
    expect(node(g, "E2").rank).toBe(1);
    expect(node(g, "E1").rank).toBe(2);
    expect(node(g, "E3").ready).toBe(true);
    expect(node(g, "E2").ready).toBe(false);
  });
});

describe("standaloneBlockers", () => {
  it("returns a standalone target's OPEN blockers from its own blocks edges", () => {
    // S is a parentless task blocked by another parentless task B — B never appears in the epic
    // graph, so its readiness must be derived here directly from the blocks edge.
    const beads = [standalone("S", { dependencies: [blocks("S", "B")] }), standalone("B")];
    expect(standaloneBlockers(beads, "S")).toEqual(["B"]);
    // The blocker itself has no blockers.
    expect(standaloneBlockers(beads, "B")).toEqual([]);
  });

  it("counts a blocker only while it is not done (closed → ready)", () => {
    const beads = [
      standalone("S", { dependencies: [blocks("S", "B")] }),
      standalone("B", { status: "closed" }),
    ];
    expect(standaloneBlockers(beads, "S")).toEqual([]);
  });

  it("ignores related / discovered-from edges — only blocks gates a standalone", () => {
    const beads = [
      standalone("S", {
        dependencies: [dep("S", "X", "related"), dep("S", "Y", "discovered-from")],
      }),
      standalone("X"),
      standalone("Y"),
    ];
    expect(standaloneBlockers(beads, "S")).toEqual([]);
  });

  it("treats an unknown blocker (absent from the list) as still open — fail safe", () => {
    const beads = [standalone("S", { dependencies: [blocks("S", "GONE")] })];
    expect(standaloneBlockers(beads, "S")).toEqual(["GONE"]);
  });

  it("dedupes multiple edges to the same open blocker", () => {
    const beads = [
      standalone("S", { dependencies: [blocks("S", "B"), blocks("S", "B")] }),
      standalone("B"),
    ];
    expect(standaloneBlockers(beads, "S")).toEqual(["B"]);
  });
});

describe("epicStandaloneBlockers", () => {
  it("gates an epic on an open standalone blocker the epic-graph rollup drops", () => {
    // E blocks-depends on a parentless task B. epicOf(B) is undefined, so computeEpicGraph drops
    // the edge and E reads ready — epicStandaloneBlockers recovers it.
    const beads = [epic("E", { dependencies: [blocks("E", "B")] }), standalone("B")];
    expect(node(graphOf(beads), "E").ready).toBe(true); // rollup can't see the standalone blocker
    expect(epicStandaloneBlockers(beads, "E")).toEqual(["B"]);
  });

  it("gates an epic on a standalone blocker of one of its CHILDREN", () => {
    const beads = [
      epic("E"),
      ticket("T", "E", { dependencies: [blocks("T", "B")] }),
      standalone("B"),
    ];
    expect(epicStandaloneBlockers(beads, "E")).toEqual(["B"]);
  });

  it("counts a standalone blocker only while it is not done (closed → ready)", () => {
    const beads = [
      epic("E", { dependencies: [blocks("E", "B")] }),
      standalone("B", { status: "closed" }),
    ];
    expect(epicStandaloneBlockers(beads, "E")).toEqual([]);
  });

  it("ignores epic→epic and cross-epic child blockers (already in the rollup)", () => {
    const beads = [
      epic("E", { dependencies: [blocks("E", "E2")] }),
      epic("E2"),
      epic("E3"),
      ticket("T", "E", { dependencies: [blocks("T", "T3")] }),
      ticket("T3", "E3"),
    ];
    expect(epicStandaloneBlockers(beads, "E")).toEqual([]);
  });

  it("treats an unknown blocker (absent from the list) as still open — fail safe", () => {
    const beads = [epic("E", { dependencies: [blocks("E", "GONE")] })];
    expect(epicStandaloneBlockers(beads, "E")).toEqual(["GONE"]);
  });

  it("returns [] for a non-epic / unknown target", () => {
    const beads = [standalone("S", { dependencies: [blocks("S", "B")] }), standalone("B")];
    expect(epicStandaloneBlockers(beads, "S")).toEqual([]);
    expect(epicStandaloneBlockers(beads, "MISSING")).toEqual([]);
  });
});
