import { describe, expect, it } from "vitest";
import { buildProjectGraph } from "@/components/epic/project-graph-model";
import type { EpicGraphEdge, EpicGraphNode } from "@/lib/epic-graph";

function epic(id: string, over: Partial<EpicGraphNode> = {}): EpicGraphNode {
  return {
    id,
    title: `Epic ${id}`,
    status: "open",
    stage: "backlog",
    priority: 2,
    createdAt: "2026-07-16T00:00:00Z",
    blockedBy: [],
    ready: true,
    rank: 0,
    ...over,
  };
}

function edge(from: string, to: string, over: Partial<EpicGraphEdge> = {}): EpicGraphEdge {
  return { from, to, direct: true, inferred: false, inCycle: false, ...over };
}

describe("buildProjectGraph", () => {
  it("renders one node per epic and the blocks edge, with no ticket nodes", () => {
    const epics = [epic("a", { rank: 0, ready: true }), epic("b", { rank: 1, blockedBy: ["a"], ready: false })];
    const edges = [edge("b", "a")];

    const graph = buildProjectGraph("proj", epics, edges);

    expect(graph.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(graph.nodes).toHaveLength(2);
    // Payload carries no tickets, so nothing but epic nodes can appear.
    for (const node of graph.nodes) {
      expect(node.data.slug).toBe("proj");
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }

    expect(graph.edges).toHaveLength(1);
    const [built] = graph.edges;
    // Direction mirrors dependency-graph.tsx: source = blocked (from), target = blocker (to).
    expect(built.source).toBe("b");
    expect(built.target).toBe("a");
    expect(built.inCycle).toBe(false);
  });

  it("lays epics left-to-right along the blocks direction (dagre LR)", () => {
    const epics = [epic("blocked"), epic("blocker")];
    const graph = buildProjectGraph("proj", epics, [edge("blocked", "blocker")]);

    const blocked = graph.nodes.find((n) => n.id === "blocked")!;
    const blocker = graph.nodes.find((n) => n.id === "blocker")!;
    expect(blocked.position.x).toBeLessThan(blocker.position.x);
  });

  it("preserves the inCycle flag so cycle edges can render distinctly", () => {
    const epics = [epic("a"), epic("b")];
    const graph = buildProjectGraph("proj", epics, [
      edge("a", "b", { inCycle: true }),
      edge("b", "a", { inCycle: true }),
    ]);

    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.every((e) => e.inCycle)).toBe(true);
    // A cycle must not drop any epic node from the layout.
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
  });

  it("returns no edges when the payload has none", () => {
    const graph = buildProjectGraph("proj", [epic("solo")], []);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
  });
});
