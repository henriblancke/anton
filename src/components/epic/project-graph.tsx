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

import type { EpicGraphEdge, EpicGraphNode } from "@/lib/epic-graph";
import type { Stage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  buildProjectGraph,
  EPIC_H,
  EPIC_W,
  type ProjectGraphNodeData,
} from "@/components/epic/project-graph-model";

const STAGE_VAR: Record<Stage, string> = {
  backlog: "var(--stage-backlog)",
  implementing: "var(--stage-implementing)",
  "in-review": "var(--stage-in-review)",
  done: "var(--stage-done)",
};

type EpicNode = Node<ProjectGraphNodeData, "epic">;

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

const nodeTypes = { epic: EpicNodeView };

interface GraphPayload {
  epics: EpicGraphNode[];
  edges: EpicGraphEdge[];
}

function toFlow(slug: string, payload: GraphPayload): { nodes: Node[]; edges: Edge[] } {
  const { nodes, edges } = buildProjectGraph(slug, payload.epics, payload.edges);

  const flowNodes: Node[] = nodes.map((n) => ({
    id: n.id,
    type: "epic",
    position: n.position,
    data: n.data,
  }));

  const flowEdges: Edge[] = edges.map((e) => {
    // Blocks style + direction from dependency-graph.tsx:115 (red, arrow at the blocker).
    // Cycle edges render distinctly: dashed amber, animated, "cycle" label.
    const stroke = e.inCycle ? "var(--color-stage-implementing)" : "var(--color-destructive)";
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: "smoothstep",
      animated: e.inCycle,
      label: e.inCycle ? "cycle" : "blocks",
      style: {
        stroke,
        strokeWidth: 1.5,
        strokeDasharray: e.inCycle ? "6 4" : undefined,
        opacity: 0.85,
      },
      labelStyle: { fill: "var(--color-muted-foreground)", fontSize: 10 },
      labelBgStyle: { fill: "var(--color-card)", fillOpacity: 0.9 },
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 },
    };
  });

  return { nodes: flowNodes, edges: flowEdges };
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
  const [payload, setPayload] = useState<GraphPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/projects/${slug}/graph`);
        if (!res.ok) throw new Error(`Failed to load dependencies (${res.status})`);
        const data = (await res.json()) as GraphPayload;
        if (!cancelled) {
          setPayload(data);
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

  const { nodes, edges } = useMemo(
    () => (payload ? toFlow(slug, payload) : { nodes: [], edges: [] }),
    [slug, payload],
  );

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

  if (!payload) {
    return <div className="anton-shimmer m-6 flex-1 rounded-xl" aria-busy="true" />;
  }

  if (payload.epics.length === 0) {
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
        aria-label="Project epic dependency graph"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--color-border)" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}
