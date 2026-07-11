"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { TriangleAlertIcon } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  defaultKeyboardCoordinateGetter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToWindowEdges } from "@dnd-kit/modifiers";

import { STAGES, type Board, type MoveRequest, type Stage } from "@/lib/types";
import { EpicCard } from "@/components/board/epic-card";
import { BoardColumn } from "@/components/board/board-column";
import { BoardSkeleton } from "@/components/board/board-skeleton";
import { STAGE_LABELS, moveEpicBetweenColumns } from "@/components/board/board-utils";
import { Button } from "@/components/ui/button";

export function EpicBoard({ slug }: { slug: string }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/projects/${slug}/board`);
        if (!res.ok) throw new Error(`Failed to load board (${res.status})`);
        const data = (await res.json()) as { board: Board };
        if (!cancelled) {
          setBoard(data.board);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load board");
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, attempt]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: defaultKeyboardCoordinateGetter }),
  );

  const activeEpic = useMemo(() => {
    if (!board || !activeId) return null;
    for (const stage of STAGES) {
      const found = board.columns[stage]?.find((epic) => epic.id === activeId);
      if (found) return found;
    }
    return null;
  }, [board, activeId]);

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!board || !over) return;

    const epicId = String(active.id);
    const toStage = over.id as Stage;
    const fromStage = active.data.current?.stage as Stage | undefined;
    if (!fromStage || fromStage === toStage) return;

    const epic = board.columns[fromStage]?.find((e) => e.id === epicId);
    if (!epic) return;

    const previous = board;
    setBoard({ ...board, columns: moveEpicBetweenColumns(board.columns, epicId, toStage) });

    try {
      const res = await fetch(`/api/projects/${slug}/cards/${epicId}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toStage } satisfies MoveRequest),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Move failed (${res.status})`);
      }
      toast.success(`Moved "${epic.title}" to ${STAGE_LABELS[toStage]}`);
    } catch (err) {
      setBoard(previous);
      toast.error(err instanceof Error ? err.message : "Failed to move card");
    }
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-destructive/30 p-8 text-center">
        <TriangleAlertIcon className="size-6 text-destructive" aria-hidden="true" />
        <p className="text-sm text-destructive">{error}</p>
        <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </div>
    );
  }

  if (!board) {
    return <BoardSkeleton />;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      modifiers={[restrictToWindowEdges]}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="grid flex-1 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {STAGES.map((stage) => (
          <BoardColumn key={stage} stage={stage} epics={board.columns[stage] ?? []} slug={slug} />
        ))}
      </div>
      <DragOverlay>{activeEpic ? <EpicCard slug={slug} epic={activeEpic} overlay /> : null}</DragOverlay>
    </DndContext>
  );
}
