"use client";

import { useDroppable } from "@dnd-kit/core";
import { InboxIcon } from "lucide-react";

import type { Epic, Stage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { STAGE_ACCENT_DOT, STAGE_LABELS } from "@/components/board/board-utils";
import { DraggableEpicCard } from "@/components/board/draggable-epic-card";

export function BoardColumn({
  stage,
  epics,
  slug,
}: {
  stage: Stage;
  epics: Epic[];
  slug: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex min-h-40 flex-col gap-3 rounded-xl border border-transparent bg-muted/30 p-3 transition-colors",
        isOver && "border-primary/40 bg-primary/5",
      )}
    >
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <span className={cn("size-1.5 rounded-full", STAGE_ACCENT_DOT[stage])} aria-hidden="true" />
          <h2 className="text-sm font-medium">{STAGE_LABELS[stage]}</h2>
        </div>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
          {epics.length}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-2">
        {epics.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border/70 px-3 py-8 text-center">
            <InboxIcon className="size-4 text-muted-foreground/60" aria-hidden="true" />
            <p className="text-xs text-muted-foreground">No epics</p>
          </div>
        ) : (
          epics.map((epic) => <DraggableEpicCard key={epic.id} slug={slug} epic={epic} />)
        )}
      </div>
    </div>
  );
}
