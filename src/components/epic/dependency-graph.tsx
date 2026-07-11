"use client";

import { useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { DepEdge, DepType, Epic, Ticket } from "@/lib/types";
import { badgeVariant, ticketBadges } from "@/components/board/board-utils";
import { Badge } from "@/components/ui/badge";
import { layoutGraphNodes, type GraphLayoutNode } from "@/components/epic/graph-layout";

const EPIC_NODE_WIDTH = 260;
const EPIC_NODE_HEIGHT = 96;
const TICKET_NODE_WIDTH = 232;
const TICKET_NODE_HEIGHT = 118;

const REACT_FLOW_CHROME_CLASS = [
  "[&_.react-flow__attribution]:hidden",
  "[&_.react-flow__controls]:overflow-hidden",
  "[&_.react-flow__controls]:rounded-lg",
  "[&_.react-flow__controls]:border",
  "[&_.react-flow__controls]:border-border",
  "[&_.react-flow__controls]:bg-card",
  "[&_.react-flow__controls]:shadow-none",
  "[&_.react-flow__controls-button]:border-b",
  "[&_.react-flow__controls-button]:border-border",
  "[&_.react-flow__controls-button]:bg-card",
  "[&_.react-flow__controls-button]:fill-foreground",
  "[&_.react-flow__controls-button:hover]:bg-muted",
  "[&_.react-flow__controls-button:last-child]:border-b-0",
].join(" ");

interface EpicNodeData extends Record<string, unknown> {
  title: string;
  goal?: string;
}

interface TicketNodeData extends Record<string, unknown> {
  ticket: Ticket;
}

type EpicFlowNode = Node<EpicNodeData, "epic">;
type TicketFlowNode = Node<TicketNodeData, "ticket">;
type GraphFlowNode = EpicFlowNode | TicketFlowNode;

function EpicGraphNode({ data }: NodeProps<EpicFlowNode>) {
  return (
    <div
      className="flex flex-col gap-1 rounded-xl border border-primary/40 bg-card px-3 py-2.5 text-card-foreground shadow-xs ring-1 ring-primary/10"
      style={{ width: EPIC_NODE_WIDTH, height: EPIC_NODE_HEIGHT }}
    >
      <Handle type="target" position={Position.Top} className="!size-2 !border-none !bg-border" />
      <span className="text-[0.65rem] font-medium tracking-wide text-primary uppercase">Epic</span>
      <h3 className="truncate text-sm font-medium leading-snug" title={data.title}>
        {data.title}
      </h3>
      {data.goal && (
        <p className="line-clamp-2 text-xs text-muted-foreground" title={data.goal}>
          {data.goal}
        </p>
      )}
      <Handle type="source" position={Position.Bottom} className="!size-2 !border-none !bg-border" />
    </div>
  );
}

function TicketGraphNode({ data }: NodeProps<TicketFlowNode>) {
  const { ticket } = data;
  const badges = ticketBadges(ticket);

  return (
    <div
      className="flex flex-col gap-1.5 rounded-xl border border-border/70 bg-card px-3 py-2.5 text-card-foreground shadow-xs"
      style={{ width: TICKET_NODE_WIDTH, height: TICKET_NODE_HEIGHT }}
    >
      <Handle type="target" position={Position.Top} className="!size-2 !border-none !bg-border" />
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground" title={ticket.id}>
          {ticket.id}
        </span>
        <span className="shrink-0 text-[0.65rem] text-muted-foreground">{ticket.stage}</span>
      </div>
      <h4 className="truncate text-sm font-medium leading-snug" title={ticket.title}>
        {ticket.title}
      </h4>
      {badges.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {badges.map((badge) => (
            <Badge key={badge.key} variant={badgeVariant(badge)} className="h-4 px-1.5 text-[0.65rem]">
              {badge.label}
            </Badge>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!size-2 !border-none !bg-border" />
    </div>
  );
}

const nodeTypes = { epic: EpicGraphNode, ticket: TicketGraphNode };

const DEP_EDGE_STYLE: Record<DepType, { label: string; stroke: string; dashed?: boolean; opacity: number }> = {
  "parent-child": { label: "part of", stroke: "var(--color-muted-foreground)", opacity: 0.6 },
  blocks: { label: "blocks", stroke: "var(--color-destructive)", opacity: 0.85 },
  related: { label: "related", stroke: "var(--color-muted-foreground)", dashed: true, opacity: 0.5 },
  "discovered-from": { label: "discovered from", stroke: "var(--color-muted-foreground)", dashed: true, opacity: 0.35 },
};

function buildGraph(
  epic: Epic,
  tickets: Ticket[],
  edges: DepEdge[],
): { nodes: GraphFlowNode[]; flowEdges: Edge[] } {
  const layoutInputs: GraphLayoutNode[] = [
    { id: epic.id, width: EPIC_NODE_WIDTH, height: EPIC_NODE_HEIGHT },
    ...tickets.map((ticket) => ({ id: ticket.id, width: TICKET_NODE_WIDTH, height: TICKET_NODE_HEIGHT })),
  ];
  const positions = layoutGraphNodes(
    layoutInputs,
    edges.map((edge) => ({ source: edge.from, target: edge.to })),
  );

  const nodes: GraphFlowNode[] = [
    {
      id: epic.id,
      type: "epic",
      position: positions.get(epic.id) ?? { x: 0, y: 0 },
      data: { title: epic.title, goal: epic.goal },
    },
    ...tickets.map(
      (ticket): TicketFlowNode => ({
        id: ticket.id,
        type: "ticket",
        position: positions.get(ticket.id) ?? { x: 0, y: 0 },
        data: { ticket },
      }),
    ),
  ];

  const flowEdges: Edge[] = edges.map((edge) => {
    const style = DEP_EDGE_STYLE[edge.type];
    return {
      id: `${edge.from}-${edge.to}-${edge.type}`,
      source: edge.from,
      target: edge.to,
      type: "smoothstep",
      label: style.label,
      style: {
        stroke: style.stroke,
        strokeWidth: 1.5,
        strokeDasharray: style.dashed ? "6 4" : undefined,
        opacity: style.opacity,
      },
      labelStyle: { fill: "var(--color-muted-foreground)", fontSize: 10 },
      labelBgStyle: { fill: "var(--color-card)", fillOpacity: 0.9 },
      markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke, width: 14, height: 14 },
    };
  });

  return { nodes, flowEdges };
}

export function DependencyGraph({
  epic,
  tickets,
  edges,
}: {
  epic: Epic;
  tickets: Ticket[];
  edges: DepEdge[];
}) {
  const { nodes, flowEdges } = useMemo(() => buildGraph(epic, tickets, edges), [epic, tickets, edges]);

  if (tickets.length === 0) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border/70 text-center">
        <p className="text-sm text-muted-foreground">No linked tickets yet</p>
      </div>
    );
  }

  return (
    <div
      className={`h-[520px] w-full overflow-hidden rounded-xl border border-border/70 bg-card ${REACT_FLOW_CHROME_CLASS}`}
    >
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        minZoom={0.3}
        maxZoom={1.5}
        aria-label={`Dependency graph for ${epic.title}`}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          className="opacity-40"
          color="var(--color-muted-foreground)"
        />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}
