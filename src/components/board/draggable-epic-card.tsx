"use client";

import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon } from "lucide-react";

import type { Epic, Stage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { EpicCard } from "@/components/board/epic-card";

export function DraggableEpicCard({
  slug,
  epic,
  budgetAware = false,
  onDeleted,
}: {
  slug: string;
  epic: Epic;
  /** Project budget-aware flag (anton-y2ue): forwarded to the card for the Approve/Queue split. */
  budgetAware?: boolean;
  onDeleted?: (epicId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } =
    useDraggable({
      id: epic.id,
      data: { stage: epic.stage satisfies Stage },
    });

  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined;

  return (
    <div ref={setNodeRef} style={style} className={cn("group relative", isDragging && "opacity-40")}>
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder "${epic.title}"`}
        style={{ touchAction: "none" }}
        className="absolute top-2 right-2 z-10 flex size-6 cursor-grab items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 active:cursor-grabbing group-hover:opacity-100"
      >
        <GripVerticalIcon className="size-3.5" aria-hidden="true" />
      </button>
      <EpicCard slug={slug} epic={epic} budgetAware={budgetAware} onDeleted={onDeleted} />
    </div>
  );
}
