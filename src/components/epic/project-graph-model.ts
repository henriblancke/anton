/**
 * Pure model for the Dependencies-page epic→epic DAG. Kept free of React/XYFlow so it's
 * node-testable (see project-graph-model.test.ts) alongside the dagre layout in graph-layout.ts.
 *
 * Consumes the /api/projects/[slug]/graph payload (epics + rolled-up blocks edges from
 * computeEpicGraph). One node per epic; one edge per epic→epic `blocks` pair. Ticket containment
 * lives on the epic-detail page, so no ticket nodes and no parent-child edges are produced here.
 * Direction mirrors dependency-graph.tsx: source = edge.from (blocked/dependent), target = edge.to
 * (blocker); dagre LR then lays the sequence out left-to-right.
 */
import type { EpicGraphEdge, EpicGraphNode } from "@/lib/epic-graph";
import type { Stage } from "@/lib/types";
import { layoutGraphNodes, type GraphLayoutNode } from "@/components/epic/graph-layout";

export const EPIC_W = 220;
export const EPIC_H = 60;

export interface ProjectGraphNodeData extends Record<string, unknown> {
  id: string;
  slug: string;
  title: string;
  stage: Stage;
}

export interface ProjectGraphNode {
  id: string;
  position: { x: number; y: number };
  data: ProjectGraphNodeData;
}

export interface ProjectGraphEdge {
  id: string;
  source: string;
  target: string;
  /** Part of a detected dependency cycle — rendered distinctly by the component. */
  inCycle: boolean;
}

export function buildProjectGraph(
  slug: string,
  epics: EpicGraphNode[],
  edges: EpicGraphEdge[],
): { nodes: ProjectGraphNode[]; edges: ProjectGraphEdge[] } {
  const layoutNodes: GraphLayoutNode[] = epics.map((epic) => ({
    id: epic.id,
    width: EPIC_W,
    height: EPIC_H,
  }));
  const layoutEdges = edges.map((edge) => ({ source: edge.from, target: edge.to }));

  const positions = layoutGraphNodes(layoutNodes, layoutEdges, {
    direction: "LR",
    nodeSep: 24,
    rankSep: 90,
  });

  const nodes: ProjectGraphNode[] = epics.map((epic) => ({
    id: epic.id,
    position: positions.get(epic.id) ?? { x: 0, y: 0 },
    data: { id: epic.id, slug, title: epic.title, stage: epic.stage },
  }));

  const flowEdges: ProjectGraphEdge[] = edges.map((edge) => ({
    id: `${edge.from}-${edge.to}`,
    source: edge.from,
    target: edge.to,
    inCycle: edge.inCycle,
  }));

  return { nodes, edges: flowEdges };
}
