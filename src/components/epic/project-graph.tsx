"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
import { Share2Icon, TriangleAlertIcon } from "lucide-react";

import type { Board, Epic, Stage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { layoutGraphNodes, type GraphLayoutNode } from "@/components/epic/graph-layout";

const EPIC_W = 220;
const EPIC_H = 60;
const TICKET_W = 190;
const TICKET_H = 52;

const STAGE_VAR: Record<Stage, string> = {
  backlog: "var(--stage-backlog)",
  implementing: "var(--stage-implementing)",
  "in-review": "var(--stage-in-review)",
  done: "var(--stage-done)",
};

interface EpicData extends Record<string, unknown> {
  title: string;
  stage: Stage;
  slug: string;
  id: string;
}
interface TicketData extends Record<string, unknown> {
  title: string;
  id: string;
  stage: Stage;
}
type EpicNode = Node<EpicData, "epic">;
type TicketNode = Node<TicketData, "ticket">;

function EpicNodeView({ data }: NodeProps<EpicNode>) {
  return (
    <Link
      href={`/projects/${data.slug}/epics/${data.id}`}
      className="flex flex-col justify-center gap-0.5 rounded-xl border border-primary/50 bg-card px-3 py-2 ring-1 ring-primary/10"
      style={{ width: EPIC_W, height: EPIC_H, borderLeft: `3px solid ${STAGE_VAR[data.stage]}` }}
    >
      <Handle type="target" position={Position.Left} className="!size-2 !border-none !bg-border" />
      <span className="font-mono text-[9px] tracking-wide text-primary uppercase">epic · {data.id}</span>
      <span className="truncate text-[12px] font-semibold" title={data.title}>
        {data.title}
      </span>
      <Handle type="source" position={Position.Right} className="!size-2 !border-none !bg-border" />
    </Link>
  );
}

function TicketNodeView({ data }: NodeProps<TicketNode>) {
  return (
    <div
      className="flex flex-col justify-center gap-0.5 rounded-lg border border-border bg-card px-3 py-2"
      style={{ width: TICKET_W, height: TICKET_H, borderLeft: `3px solid ${STAGE_VAR[data.stage]}` }}
    >
      <Handle type="target" position={Position.Left} className="!size-2 !border-none !bg-border" />
      <span className="font-mono text-[9px] text-subtle">{data.id}</span>
      <span className="truncate text-[11.5px] font-medium" title={data.title}>
        {data.title}
      </span>
      <Handle type="source" position={Position.Right} className="!size-2 !border-none !bg-border" />
    </div>
  );
}

const nodeTypes = { epic: EpicNodeView, ticket: TicketNodeView };

function buildGraph(slug: string, epics: Epic[]): { nodes: Node[]; edges: Edge[] } {
  const layoutNodes: GraphLayoutNode[] = [];
  const layoutEdges: { source: string; target: string }[] = [];
  const meta: Node[] = [];

  for (const epic of epics) {
    layoutNodes.push({ id: epic.id, width: EPIC_W, height: EPIC_H });
    meta.push({
      id: epic.id,
      type: "epic",
      position: { x: 0, y: 0 },
      data: { title: epic.title, stage: epic.stage, slug, id: epic.id },
    } satisfies EpicNode);
    for (const ticket of epic.tickets) {
      // A ticket that IS the epic (orphan wrapped as single-ticket epic) needn't duplicate.
      if (ticket.id === epic.id) continue;
      layoutNodes.push({ id: ticket.id, width: TICKET_W, height: TICKET_H });
      layoutEdges.push({ source: epic.id, target: ticket.id });
      meta.push({
        id: ticket.id,
        type: "ticket",
        position: { x: 0, y: 0 },
        data: { title: ticket.title, id: ticket.id, stage: ticket.stage },
      } satisfies TicketNode);
    }
  }

  const positions = layoutGraphNodes(layoutNodes, layoutEdges, {
    direction: "LR",
    nodeSep: 24,
    rankSep: 90,
  });
  const nodes = meta.map((n) => ({ ...n, position: positions.get(n.id) ?? { x: 0, y: 0 } }));

  const edges: Edge[] = layoutEdges.map((e) => ({
    id: `${e.source}-${e.target}`,
    source: e.source,
    target: e.target,
    type: "smoothstep",
    style: { stroke: "var(--color-border)", strokeWidth: 1.5, opacity: 0.7 },
    markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-border)", width: 12, height: 12 },
  }));

  return { nodes, edges };
}

const CHROME = [
  "[&_.react-flow__attribution]:hidden",
  "[&_.react-flow__controls]:overflow-hidden",
  "[&_.react-flow__controls]:rounded-lg",
  "[&_.react-flow__controls]:border",
  "[&_.react-flow__controls]:border-border",
  "[&_.react-flow__controls-button]:border-b",
  "[&_.react-flow__controls-button]:border-border",
  "[&_.react-flow__controls-button]:bg-card",
  "[&_.react-flow__controls-button]:fill-foreground",
  "[&_.react-flow__controls-button:hover]:bg-muted",
].join(" ");

export function ProjectGraph({ slug }: { slug: string }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/projects/${slug}/board`);
        if (!res.ok) throw new Error(`Failed to load dependencies (${res.status})`);
        const data = (await res.json()) as { board: Board };
        if (!cancelled) {
          setBoard(data.board);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load dependencies");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, attempt]);

  const epics = useMemo(
    () => (board ? Object.values(board.columns).flat() : []),
    [board],
  );
  const { nodes, edges } = useMemo(() => buildGraph(slug, epics), [slug, epics]);

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <span className="flex size-11 items-center justify-center rounded-xl border border-risk-high/30 bg-risk-high/10">
          <TriangleAlertIcon className="size-5 text-risk-high" aria-hidden="true" />
        </span>
        <p className="text-sm text-risk-high">{error}</p>
        <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </div>
    );
  }

  if (!board) {
    return <div className="anton-shimmer m-6 flex-1 rounded-xl" aria-busy="true" />;
  }

  if (epics.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <span className="flex size-11 items-center justify-center rounded-xl border border-dashed border-border">
          <Share2Icon className="size-5 text-subtle" aria-hidden="true" />
        </span>
        <p className="text-sm text-subtle">No epics to graph yet</p>
      </div>
    );
  }

  return (
    <div className={cn("min-h-0 flex-1", CHROME)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        minZoom={0.2}
        maxZoom={1.5}
        aria-label="Project dependency graph"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--color-border)" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}
