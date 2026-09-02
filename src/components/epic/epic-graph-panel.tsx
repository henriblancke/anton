"use client";

import type { DepEdge, Epic, Ticket } from "@/lib/types";
import { DependencyGraph } from "@/components/epic/dependency-graph";
import { LegendItem } from "@/components/epic/epic-detail-parts";

/** The detail page's right column: the run's dependency graph, with its own stage legend. */
export function EpicGraphPanel({
  epic,
  tickets,
  edges,
  onSelectTicket,
}: {
  epic: Epic;
  tickets: Ticket[];
  edges: DepEdge[];
  onSelectTicket: (ticketId: string) => void;
}) {
  return (
    <div className="flex min-h-[440px] flex-col">
      <div className="flex items-center gap-2.5 border-b border-border px-5 py-3.5 sm:px-6">
        <span className="text-[13px] font-semibold">Dependency graph</span>
        <span className="font-mono text-[11px] text-subtle">dagre · left → right</span>
        <div className="ml-auto hidden gap-3 sm:flex">
          <LegendItem className="bg-stage-done" label="done" small />
          <LegendItem className="bg-stage-implementing" label="active" small />
          <LegendItem className="bg-stage-backlog" label="todo" small />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <DependencyGraph
          epic={epic}
          tickets={tickets}
          edges={edges}
          fill
          onSelectTicket={onSelectTicket}
        />
      </div>
    </div>
  );
}
