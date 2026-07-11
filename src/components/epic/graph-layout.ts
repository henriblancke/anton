/**
 * Pure dagre layout mapping for the epic dependency graph. Kept free of React/XYFlow types so
 * it's trivially unit-testable (see graph-layout.test.ts) and reusable by dependency-graph.tsx.
 */
import dagre from "@dagrejs/dagre";

export interface GraphLayoutNode {
  id: string;
  width: number;
  height: number;
}

export interface GraphLayoutEdge {
  source: string;
  target: string;
}

export interface GraphLayoutPosition {
  x: number;
  y: number;
}

export interface GraphLayoutOptions {
  direction?: "TB" | "LR";
  nodeSep?: number;
  rankSep?: number;
}

/**
 * Computes a top-left `position` (as XYFlow expects) for every input node via dagre's layered
 * layout. Edges referencing an unknown node id are ignored rather than throwing. Isolated nodes
 * (no edges at all) still receive a position so the graph never drops a node. Pure — no DOM,
 * no side effects, safe to call from a test or from a client component's render.
 */
export function layoutGraphNodes(
  nodes: GraphLayoutNode[],
  edges: GraphLayoutEdge[],
  options: GraphLayoutOptions = {},
): Map<string, GraphLayoutPosition> {
  const { direction = "TB", nodeSep = 48, rankSep = 72 } = options;

  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: direction, nodesep: nodeSep, ranksep: rankSep });

  for (const node of nodes) {
    graph.setNode(node.id, { width: node.width, height: node.height });
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    graph.setEdge(edge.source, edge.target);
  }

  dagre.layout(graph);

  const positions = new Map<string, GraphLayoutPosition>();
  for (const node of nodes) {
    const laidOut = graph.node(node.id);
    positions.set(node.id, {
      x: laidOut.x - node.width / 2,
      y: laidOut.y - node.height / 2,
    });
  }
  return positions;
}
