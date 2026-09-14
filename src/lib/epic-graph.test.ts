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
/** A feature — the run target under the tier split, so the rollup stops here, not at the epic. */
function feature(id: string, parent?: string, extra: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "feature", parent, ...extra };
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

  it("rolls a task-level block up to its FEATURE in a three-level tree, not to the epic", () => {
    // epic → feature → task. Both tasks share one epic, so a single-hop rollup collapsed them to a
    // self-edge and dropped the dependency entirely; the feature is the run target, so the edge
    // belongs between the two features.
    const g = graphOf([
      epic("E"),
      feature("F1", "E"),
      feature("F2", "E"),
      ticket("T1", "F1", { dependencies: [blocks("T1", "T2")] }),
      ticket("T2", "F2"),
    ]);

    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ from: "F1", to: "F2", direct: false, inferred: true });
    expect(node(g, "F1").blockedBy).toEqual(["F2"]);
    expect(node(g, "F1").ready).toBe(false);
    expect(node(g, "F2").ready).toBe(true);
    expect(node(g, "F2").rank).toBe(0);
    expect(node(g, "F1").rank).toBe(1);
    // The epic above them ships nothing itself, so it inherits neither the edge nor the block.
    expect(node(g, "E").blockedBy).toEqual([]);
    expect(node(g, "E").ready).toBe(true);
  });

  it("rolls a task under a feature under DIFFERENT epics up to the features", () => {
    const g = graphOf([
      epic("E1"),
      epic("E2"),
      feature("F1", "E1"),
      feature("F2", "E2"),
      ticket("T1", "F1", { dependencies: [blocks("T1", "T2")] }),
      ticket("T2", "F2"),
    ]);

    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ from: "F1", to: "F2" });
    expect(node(g, "E1").ready).toBe(true);
  });

  it("keeps a direct feature→feature block direct, and an epic→epic block on container epics", () => {
    const g = graphOf([
      epic("E1"),
      epic("E2", { dependencies: [blocks("E2", "E1")] }),
      feature("F1", "E1"),
      feature("F2", "E2", { dependencies: [blocks("F2", "F1")] }),
    ]);

    expect(g.edges).toHaveLength(2);
    expect(g.edges).toContainEqual(
      expect.objectContaining({ from: "F2", to: "F1", direct: true, inferred: false }),
    );
    // A container epic isn't runnable, but its own sequencing still stands — dropping it would
    // under-report blockers, which is exactly what the rollup exists to prevent.
    expect(g.edges).toContainEqual(
      expect.objectContaining({ from: "E2", to: "E1", direct: true, inferred: false }),
    );
    expect(node(g, "F2").blockedBy).toEqual(["F1"]);
    expect(node(g, "E2").blockedBy).toEqual(["E1"]);
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

  it("keeps edge pairs distinct when ids would collide under naive concatenation", () => {
    // ("E1 X", "E2") and ("E1", "X E2") concatenate to the same string under any plain
    // delimiter the ids themselves may contain — the dedupe key must survive that.
    const g = graphOf([
      epic("E1 X", { dependencies: [blocks("E1 X", "E2")] }),
      epic("E2"),
      epic("E1", { dependencies: [blocks("E1", "X E2")] }),
      epic("X E2"),
    ]);

    expect(g.edges).toHaveLength(2);
    expect(g.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "E1 X", to: "E2" }),
        expect.objectContaining({ from: "E1", to: "X E2" }),
      ]),
    );
    expect(node(g, "E1 X").blockedBy).toEqual(["E2"]);
    expect(node(g, "E1").blockedBy).toEqual(["X E2"]);
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

/**
 * anton-nywj: per-run-target child readiness. `blockedBy` answers "does anything block this target",
 * which conflates one cross-run-gated tail child with a target that can't run at all — the readiness
 * sets are what let the executor and the board ship the ready children instead of stalling (#58).
 */
describe("per-run-target child readiness", () => {
  it("reports PARTIALLY-BLOCKED when only the tail child is gated by another run target", () => {
    const g = graphOf([
      feature("FA"),
      feature("FB"),
      ticket("a1", "FA"),
      ticket("a2", "FA"),
      ticket("a3", "FA", { dependencies: [blocks("a3", "b1")] }),
      ticket("b1", "FB"),
    ]);

    expect(node(g, "FA").childReadiness).toBe("partially-blocked");
    expect(node(g, "FA").readyChildren).toEqual(["a1", "a2"]);
    expect(node(g, "FA").blockedChildren).toEqual(["a3"]);
    // The target-level rollup is unchanged: the DAG page still sees FA blocked by FB.
    expect(node(g, "FA").blockedBy).toEqual(["FB"]);
    expect(node(g, "FA").ready).toBe(false);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ from: "FA", to: "FB", inferred: true });
    // Nothing gates FB's own children.
    expect(node(g, "FB").childReadiness).toBe("ready");
    expect(node(g, "FB").readyChildren).toEqual(["b1"]);
  });

  it("reports BLOCKED when every child is gated from outside the run", () => {
    const g = graphOf([
      feature("FA"),
      feature("FB"),
      ticket("a1", "FA", { dependencies: [blocks("a1", "b1")] }),
      ticket("a2", "FA", { dependencies: [blocks("a2", "b1")] }),
      ticket("b1", "FB"),
    ]);

    expect(node(g, "FA").childReadiness).toBe("blocked");
    expect(node(g, "FA").readyChildren).toEqual([]);
    expect(node(g, "FA").blockedChildren).toEqual(["a1", "a2"]);
  });

  it("reports READY when no child is gated", () => {
    const g = graphOf([
      feature("FA"),
      feature("FB"),
      ticket("a1", "FA"),
      ticket("a2", "FA"),
      ticket("b1", "FB"),
    ]);

    expect(node(g, "FA").childReadiness).toBe("ready");
    expect(node(g, "FA").readyChildren).toEqual(["a1", "a2"]);
    expect(node(g, "FA").blockedChildren).toEqual([]);
  });

  it("treats a SIBLING blocker as ordering, not a gate — the run's own loop produces it", () => {
    const g = graphOf([
      feature("FA"),
      ticket("a1", "FA"),
      ticket("a2", "FA", { dependencies: [blocks("a2", "a1")] }),
    ]);

    expect(node(g, "FA").childReadiness).toBe("ready");
    expect(node(g, "FA").readyChildren).toEqual(["a1", "a2"]);
  });

  it("holds a child queued BEHIND a gated sibling — never reported runnable", () => {
    const g = graphOf([
      feature("FA"),
      feature("FB"),
      ticket("a1", "FA"),
      ticket("a2", "FA", { dependencies: [blocks("a2", "b1")] }),
      ticket("a3", "FA", { dependencies: [blocks("a3", "a2")] }),
      ticket("b1", "FB"),
    ]);

    expect(node(g, "FA").childReadiness).toBe("partially-blocked");
    expect(node(g, "FA").readyChildren).toEqual(["a1"]);
    expect(node(g, "FA").blockedChildren).toEqual(["a2", "a3"]);
  });

  it("releases a child once the run target shipping its blocker is done", () => {
    const beadsOf = (fb: Partial<Bead>) => [
      feature("FA"),
      feature("FB", undefined, fb),
      ticket("a1", "FA", { dependencies: [blocks("a1", "b1")] }),
      ticket("b1", "FB", { status: "closed" }),
    ];

    // b1 is closed but FB's PR hasn't merged — the code hasn't landed, so a1 stays held.
    const inReview = graphOf(beadsOf({ labels: ["stage:in-review"] }));
    expect(node(inReview, "FA").childReadiness).toBe("blocked");
    expect(node(inReview, "FA").blockedChildren).toEqual(["a1"]);

    const shipped = graphOf(beadsOf({ status: "closed" }));
    expect(node(shipped, "FA").childReadiness).toBe("ready");
    expect(node(shipped, "FA").readyChildren).toEqual(["a1"]);
  });

  it("gates every child on the run target's OWN open blocker — nothing may start ahead of it", () => {
    const g = graphOf([
      feature("FA", undefined, { dependencies: [blocks("FA", "FB")] }),
      feature("FB"),
      ticket("a1", "FA"),
      ticket("a2", "FA"),
      ticket("b1", "FB"),
    ]);

    expect(node(g, "FA").childReadiness).toBe("blocked");
    expect(node(g, "FA").blockedChildren).toEqual(["a1", "a2"]);
  });

  it("counts only the children a run would dispatch — closed ones are in neither set", () => {
    const g = graphOf([
      feature("FA"),
      ticket("a1", "FA", { status: "closed" }),
      ticket("a2", "FA"),
    ]);

    expect(node(g, "FA").readyChildren).toEqual(["a2"]);
    expect(node(g, "FA").blockedChildren).toEqual([]);
    expect(node(g, "FA").childReadiness).toBe("ready");
  });

  it("reports a LEAF feature (no tickets shaped under it) as its own single ticket", () => {
    const ready = graphOf([feature("F")]);
    expect(node(ready, "F").readyChildren).toEqual(["F"]);
    expect(node(ready, "F").childReadiness).toBe("ready");

    const gated = graphOf([
      feature("F", undefined, { dependencies: [blocks("F", "G")] }),
      feature("G"),
    ]);
    expect(node(gated, "F").blockedChildren).toEqual(["F"]);
    expect(node(gated, "F").childReadiness).toBe("blocked");
  });

  it("reads an UNKNOWN blocker as still open — fail safe, same as the blocker helpers", () => {
    const g = graphOf([feature("FA"), ticket("a1", "FA", { dependencies: [blocks("a1", "GONE")] })]);
    expect(node(g, "FA").childReadiness).toBe("blocked");
    expect(node(g, "FA").blockedChildren).toEqual(["a1"]);
  });

  it("ignores the target's own gh:pr merge gate — a target is not blocked by itself", () => {
    const gate: Bead = {
      id: "G",
      title: "Gate: gh:pr",
      status: "open",
      issue_type: "gate",
      await_type: "gh:pr",
    } as Bead;
    const g = graphOf([
      feature("FA", undefined, { dependencies: [blocks("FA", "G")] }),
      ticket("a1", "FA"),
      gate,
    ]);

    expect(node(g, "FA").childReadiness).toBe("ready");
    expect(node(g, "FA").readyChildren).toEqual(["a1"]);
  });

  it("releases a child whose only blocker is a RESOLVED gate — the gate bead must be in the read", () => {
    // A `human` gate is a real wait, so it holds while open; `bd gate resolve` closes the bead and
    // the hold ends. Both verdicts need the gate BEAD (loadAllIssues reads it via `--type gate`) —
    // over a gate-stripped list the missing-blocker fail-safe would read it as open forever, and the
    // run target would sit permanently blocked with nothing on the board to explain why.
    const gate = (status: string): Bead =>
      ({ id: "G", title: "Gate: human", status, issue_type: "gate", await_type: "human" }) as Bead;
    const beadsOf = (g: Bead) => [
      feature("FA"),
      ticket("a1", "FA", { dependencies: [blocks("a1", "G")] }),
      g,
    ];

    const open = graphOf(beadsOf(gate("open")));
    expect(node(open, "FA").childReadiness).toBe("blocked");
    expect(node(open, "FA").blockedChildren).toEqual(["a1"]);

    const resolved = graphOf(beadsOf(gate("closed")));
    expect(node(resolved, "FA").childReadiness).toBe("ready");
    expect(node(resolved, "FA").readyChildren).toEqual(["a1"]);
    // The gate is plumbing, not work: it carries no node and draws no edge either way.
    expect(resolved.epics.map((n) => n.id)).toEqual(["FA"]);
    expect(resolved.edges).toEqual([]);
  });

  it("rolls a task under a feature up to the FEATURE, so the epic above reports no held work", () => {
    const g = graphOf([
      epic("E"),
      feature("F1", "E"),
      feature("F2", "E"),
      ticket("t1", "F1", { dependencies: [blocks("t1", "t2")] }),
      ticket("t2", "F2"),
    ]);

    expect(node(g, "F1").childReadiness).toBe("blocked");
    expect(node(g, "F1").blockedChildren).toEqual(["t1"]);
    // A container epic ships nothing itself — its features each run on their own.
    expect(node(g, "E").readyChildren).toEqual([]);
    expect(node(g, "E").childReadiness).toBe("ready");
  });

  it("keeps a childless epic with its own open blocker BLOCKED, never an empty ready set", () => {
    const g = graphOf([epic("E1", { dependencies: [blocks("E1", "E2")] }), epic("E2")]);
    expect(node(g, "E1").readyChildren).toEqual([]);
    expect(node(g, "E1").childReadiness).toBe("blocked");
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

  it("rolls an epic-child blocker up to its parent epic and gates on the epic", () => {
    // S blocks-depends on C, a child of epic E. C closes the moment its code commits, but that code
    // only lands when E's PR merges (E reaches done). While E is in-review the child is done yet the
    // prerequisite hasn't landed — so S must stay blocked on E, matching computeEpicGraph's rollup.
    const beads = [
      standalone("S", { dependencies: [blocks("S", "C")] }),
      epic("E", { labels: ["stage:in-review"] }),
      ticket("C", "E", { status: "closed" }),
    ];
    expect(standaloneBlockers(beads, "S")).toEqual(["E"]);
  });

  it("clears the epic-child blocker only once the parent epic itself is done", () => {
    const beads = [
      standalone("S", { dependencies: [blocks("S", "C")] }),
      epic("E", { status: "closed" }),
      ticket("C", "E", { status: "closed" }),
    ];
    expect(standaloneBlockers(beads, "S")).toEqual([]);
  });

  it("gates on the FEATURE that ships a blocker, not the epic above it", () => {
    // C closes at commit, but its code lands only when F's PR merges — F is the run target, so the
    // gate is F. A single-hop rollup found no epic parent and gated on C itself, releasing S early.
    const beads = [
      standalone("S", { dependencies: [blocks("S", "C")] }),
      epic("E"),
      feature("F", "E", { labels: ["stage:in-review"] }),
      ticket("C", "F", { status: "closed" }),
    ];
    expect(standaloneBlockers(beads, "S")).toEqual(["F"]);

    const shipped = [
      standalone("S", { dependencies: [blocks("S", "C")] }),
      epic("E"),
      feature("F", "E", { status: "closed" }),
      ticket("C", "F", { status: "closed" }),
    ];
    expect(standaloneBlockers(shipped, "S")).toEqual([]);
  });

  it("dedupes two epic-child blockers of the same epic to one epic id", () => {
    const beads = [
      standalone("S", { dependencies: [blocks("S", "C1"), blocks("S", "C2")] }),
      epic("E", { labels: ["stage:in-review"] }),
      ticket("C1", "E", { status: "closed" }),
      ticket("C2", "E", { status: "closed" }),
    ];
    expect(standaloneBlockers(beads, "S")).toEqual(["E"]);
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

  it("recovers a FEATURE's dropped standalone blocker, including one from its own subtree", () => {
    const beads = [
      epic("E"),
      feature("F", "E"),
      ticket("T", "F", { dependencies: [blocks("T", "B")] }),
      standalone("B"),
    ];
    expect(epicStandaloneBlockers(beads, "F")).toEqual(["B"]);
    // The blocker belongs to the feature that ships T, so the epic above must not double-count it.
    expect(epicStandaloneBlockers(beads, "E")).toEqual([]);
  });

  it("ignores a feature blocker — the rollup already carries it (no double-count)", () => {
    const beads = [epic("E", { dependencies: [blocks("E", "F")] }), feature("F")];
    expect(node(graphOf(beads), "E").blockedBy).toEqual(["F"]);
    expect(epicStandaloneBlockers(beads, "E")).toEqual([]);
  });

  it("returns [] for a non-epic / unknown target", () => {
    const beads = [standalone("S", { dependencies: [blocks("S", "B")] }), standalone("B")];
    expect(epicStandaloneBlockers(beads, "S")).toEqual([]);
    expect(epicStandaloneBlockers(beads, "MISSING")).toEqual([]);
  });
});

/**
 * anton-k0kj: a `gh:pr` gate awaits the blocked bead's OWN pull request, so it is a merge wait, not a
 * prerequisite. Counting it would make an in-review target read as blocked by itself — and bd never
 * resolves a gh:pr gate whose PR was closed without merging, so that state would be permanent and
 * the recovery run unreachable.
 */
describe("a target's own merge gate is not a blocker", () => {
  const mergeGate = (id: string, o: Partial<Bead> = {}): Bead =>
    ({ id, title: `Gate: gh:pr`, status: "open", issue_type: "gate", await_type: "gh:pr", ...o }) as Bead;

  it("does not block the epic it gates", () => {
    const beads = [epic("E", { dependencies: [blocks("E", "G")] }), mergeGate("G")];
    expect(epicStandaloneBlockers(beads, "E")).toEqual([]);
  });

  it("does not block a standalone (epic-of-one) target either", () => {
    const beads = [standalone("S", { dependencies: [blocks("S", "G")] }), mergeGate("G")];
    expect(standaloneBlockers(beads, "S")).toEqual([]);
  });

  it("still blocks on human and timer gates — those ARE prerequisites someone put in the way", () => {
    const human = mergeGate("H", { await_type: "human" } as Partial<Bead>);
    const timer = mergeGate("T", { await_type: "timer" } as Partial<Bead>);
    const beads = [
      epic("E", { dependencies: [blocks("E", "H")] }),
      standalone("S", { dependencies: [blocks("S", "T")] }),
      human,
      timer,
    ];
    expect(epicStandaloneBlockers(beads, "E")).toEqual(["H"]);
    expect(standaloneBlockers(beads, "S")).toEqual(["T"]);
  });

  it("keeps the fail-safe for a gate the board read could not carry", () => {
    // No gate bead present ⇒ unclassifiable ⇒ still an open blocker. Which is exactly why the run
    // path reads the board through loadAllIssues (it fetches gate beads) rather than a bare bd list.
    const beads = [epic("E", { dependencies: [blocks("E", "G")] })];
    expect(epicStandaloneBlockers(beads, "E")).toEqual(["G"]);
  });
});
