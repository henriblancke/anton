"use client";

import { useEffect, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { DepEdge, DepType, Epic, Stage, Ticket } from "@/lib/types";
import { cn } from "@/lib/utils";
import { layoutGraphNodes, type GraphLayoutNode } from "@/components/epic/graph-layout";
import { orientEdge } from "@/components/epic/dependency-graph-model";

const STAGE_VAR: Record<Stage, string> = {
  backlog: "var(--stage-backlog)",
  implementing: "var(--stage-implementing)",
  "in-review": "var(--stage-in-review)",
  done: "var(--stage-done)",
};

const EPIC_NODE_WIDTH = 168;
const EPIC_NODE_HEIGHT = 52;
const TICKET_NODE_WIDTH = 150;
const TICKET_NODE_HEIGHT = 52;

const REACT_FLOW_CHROME_CLASS = [
  "[&_.react-flow__attribution]:hidden",
  "[&_.react-flow__controls]:overflow-hidden",
  "[&_.react-flow__controls]:rounded-lg",
  "[&_.react-flow__controls]:border",
  "[&_.react-flow__controls]:border-border",
  "[&_.react-flow__controls]:bg-card",
  "[&_.react-flow__controls]:shadow-none",
  // Theme the Controls through ReactFlow's own CSS variables. ReactFlow only applies its dark
  // palette under `.react-flow.dark` (a class we never set — the app toggles dark on an ancestor),
  // so its light defaults (white button, grey border) otherwise leak into dark mode. Driving the
  // vars here follows the app theme in both modes; the button glyph is an <svg fill="currentColor">,
  // so the button *color* var (not `fill`) is what makes the icon visible.
  "[--xy-controls-button-background-color:var(--color-card)]",
  "[--xy-controls-button-background-color-hover:var(--color-muted)]",
  "[--xy-controls-button-color:var(--color-foreground)]",
  "[--xy-controls-button-color-hover:var(--color-foreground)]",
  "[--xy-controls-button-border-color:var(--color-border)]",
].join(" ");

interface EpicNodeData extends Record<string, unknown> {
  title: string;
  goal?: string;
}

interface TicketNodeData extends Record<string, unknown> {
  ticket: Ticket;
  /** Opens the ticket popup; absent when the graph is read-only. */
  onSelect?: () => void;
}

type EpicFlowNode = Node<EpicNodeData, "epic">;
type TicketFlowNode = Node<TicketNodeData, "ticket">;
type GraphFlowNode = EpicFlowNode | TicketFlowNode;

function EpicGraphNode({ data }: NodeProps<EpicFlowNode>) {
  return (
    <div
      className="flex flex-col justify-center gap-0.5 rounded-[9px] border border-primary/50 bg-card px-3 py-2 text-card-foreground ring-1 ring-primary/10"
      style={{ width: EPIC_NODE_WIDTH, height: EPIC_NODE_HEIGHT }}
    >
      <Handle type="target" position={Position.Left} className="!size-2 !border-none !bg-border" />
      <span className="font-mono text-[9px] tracking-wide text-primary uppercase">epic</span>
      <span className="truncate text-[12px] font-semibold leading-snug" title={data.title}>
        {data.title}
      </span>
      <Handle type="source" position={Position.Right} className="!size-2 !border-none !bg-border" />
    </div>
  );
}

function TicketGraphNode({ data }: NodeProps<TicketFlowNode>) {
  const { ticket, onSelect } = data;
  // An abandoned ticket is closed, so its stage reads `done` — greyed and relabelled here so the
  // graph never shows dropped work in the shipped tint.
  const tint = ticket.abandoned ? "var(--color-subtle)" : STAGE_VAR[ticket.stage];
  return (
    <div
      className="relative"
      style={{
        width: TICKET_NODE_WIDTH,
        height: TICKET_NODE_HEIGHT,
      }}
    >
      <Handle type="target" position={Position.Left} className="!size-2 !border-none !bg-border" />
      <button
        type="button"
        onClick={onSelect}
        disabled={!onSelect}
        title={ticket.title}
        className={cn(
          "flex size-full flex-col justify-center gap-0.5 rounded-[9px] border border-border bg-card px-3 py-2 text-left text-card-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          onSelect && "cursor-pointer hover:border-primary/40",
        )}
        style={{ borderLeft: `3px solid ${tint}` }}
      >
        <span className="truncate font-mono text-[9px]" style={{ color: tint }}>
          {ticket.id} · {ticket.abandoned ? "abandoned" : ticket.stage}
        </span>
        <span className="truncate text-[11.5px] font-medium leading-snug">{ticket.title}</span>
      </button>
      <Handle type="source" position={Position.Right} className="!size-2 !border-none !bg-border" />
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
  onSelectTicket?: (ticketId: string) => void,
): { nodes: GraphFlowNode[]; flowEdges: Edge[] } {
  const layoutInputs: GraphLayoutNode[] = [
    { id: epic.id, width: EPIC_NODE_WIDTH, height: EPIC_NODE_HEIGHT },
    ...tickets.map((ticket) => ({ id: ticket.id, width: TICKET_NODE_WIDTH, height: TICKET_NODE_HEIGHT })),
  ];
  const positions = layoutGraphNodes(
    layoutInputs,
    edges.map(orientEdge),
    { direction: "LR", nodeSep: 24, rankSep: 90 },
  );

  const nodes: GraphFlowNode[] = [
    {
      id: epic.id,
      type: "epic",
      position: positions.get(epic.id) ?? { x: 0, y: 0 },
      // The epic is the graph's anchor — keep it fixed while its tickets are draggable.
      draggable: false,
      data: { title: epic.title, goal: epic.goal },
    },
    ...tickets.map(
      (ticket): TicketFlowNode => ({
        id: ticket.id,
        type: "ticket",
        position: positions.get(ticket.id) ?? { x: 0, y: 0 },
        // Tickets can be dragged to rearrange the layout (positions are view-only, not persisted).
        draggable: true,
        data: {
          ticket,
          onSelect: onSelectTicket ? () => onSelectTicket(ticket.id) : undefined,
        },
      }),
    ),
  ];

  const flowEdges: Edge[] = edges.map((edge) => {
    const style = DEP_EDGE_STYLE[edge.type];
    const { source, target } = orientEdge(edge);
    return {
      id: `${edge.from}-${edge.to}-${edge.type}`,
      source,
      target,
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
  fill = false,
  onSelectTicket,
}: {
  epic: Epic;
  tickets: Ticket[];
  edges: DepEdge[];
  /** Fill the parent container (used inside the epic-detail split panel) instead of a fixed,
   * bordered card. */
  fill?: boolean;
  /** Called with a ticket id when its node is activated; enables the clickable ticket popup. */
  onSelectTicket?: (ticketId: string) => void;
}) {
  const { nodes: initialNodes, flowEdges } = useMemo(
    () => buildGraph(epic, tickets, edges, onSelectTicket),
    [epic, tickets, edges, onSelectTicket],
  );

  // Local node state makes ticket drags stick; a fresh layout (epic/tickets/edges change) resets it.
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  useEffect(() => setNodes(initialNodes), [initialNodes, setNodes]);

  if (tickets.length === 0) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-1 text-center",
          fill ? "h-full" : "h-40 rounded-xl border border-dashed border-border",
        )}
      >
        <p className="text-sm text-subtle">No linked tickets yet</p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        fill
          ? "h-full w-full"
          : "h-[520px] w-full overflow-hidden rounded-xl border border-border bg-card",
        REACT_FLOW_CHROME_CLASS,
      )}
    >
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        nodesFocusable={false}
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
