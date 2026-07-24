"use client";

import { useDroppable } from "@dnd-kit/core";

import type { Epic, Stage, StandaloneItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { STAGE_ACCENT_DOT, STAGE_LABELS } from "@/components/board/board-utils";
import { DraggableEpicCard } from "@/components/board/draggable-epic-card";
import { StandaloneGroup } from "@/components/board/standalone-group";

export function BoardColumn({
  stage,
  epics,
  standalone,
  slug,
  budgetAware = false,
  onEpicDeleted,
  onOpenTicket,
}: {
  stage: Stage;
  epics: Epic[];
  standalone: StandaloneItem[];
  slug: string;
  /** Project budget-aware flag (anton-y2ue): forwarded to cards to gate the Approve/Queue split. */
  budgetAware?: boolean;
  onEpicDeleted?: (epicId: string) => void;
  /** Open a standalone ticket's detail dialog (hoisted to the board so one dialog serves all). */
  onOpenTicket?: (ticketId: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  const isEmpty = epics.length === 0 && standalone.length === 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-3">
      <div className="flex shrink-0 items-center gap-2 px-0.5">
        <span
          className={cn(
            "size-2.5 rounded-full",
            STAGE_ACCENT_DOT[stage],
            stage === "implementing" && "anton-pulse",
          )}
          aria-hidden="true"
        />
        <h2 className="text-[13px] font-semibold text-foreground">{STAGE_LABELS[stage]}</h2>
        <span className="ml-auto rounded-full bg-card px-2 py-0.5 font-mono text-[11px] text-subtle">
          {epics.length}
        </span>
      </div>

      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-40 flex-1 flex-col gap-3 overflow-y-auto rounded-xl border border-transparent p-0.5 transition-colors",
          isOver && "border-primary/40 bg-primary/5",
        )}
      >
        {isEmpty ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-3 py-10 text-center">
            <span className="flex size-11 items-center justify-center rounded-xl border border-dashed border-border" aria-hidden="true">
              <span className={cn("size-2 rounded-full", STAGE_ACCENT_DOT[stage])} />
            </span>
            <p className="text-xs text-subtle">No {STAGE_LABELS[stage].toLowerCase()} epics</p>
          </div>
        ) : (
          <>
            {epics.map((epic) => (
              <DraggableEpicCard
                key={epic.id}
                slug={slug}
                epic={epic}
                budgetAware={budgetAware}
                onDeleted={onEpicDeleted}
              />
            ))}
            <StandaloneGroup
              slug={slug}
              items={standalone}
              budgetAware={budgetAware}
              onOpenTicket={onOpenTicket}
            />
          </>
        )}
      </div>
    </div>
  );
}
