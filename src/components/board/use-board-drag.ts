"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  KeyboardSensor,
  PointerSensor,
  defaultKeyboardCoordinateGetter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";

import { STAGES, type Board, type Epic, type MoveRequest, type Stage } from "@/lib/types";
import { STAGE_LABELS, moveEpicBetweenColumns } from "@/components/board/board-utils";
import type { BoardPoll } from "@/components/board/use-board-poll";
import type { UpNextReorder } from "@/components/board/use-up-next-reorder";

/** Everything `DndContext` and its overlay need from the board's drag layer. */
export interface BoardDrag {
  /** Spread straight onto `DndContext`. */
  dnd: {
    sensors: ReturnType<typeof useSensors>;
    onDragStart: (event: DragStartEvent) => void;
    onDragEnd: (event: DragEndEvent) => void;
    onDragCancel: () => void;
  };
  /** The card under the cursor — the drag overlay's subject, `null` when nothing is being dragged. */
  activeEpic: Epic | null;
}

/**
 * Drag-to-move: the optimistic column change, the POST that commits it, and the rollback when that
 * fails. Kept beside the board's state rather than inside its markup — a drop is a write, and the
 * only thing the view needs back from it is which card to draw in the overlay.
 *
 * A drop with both ends inside the Up Next lane is a REORDER, not a move — the lane is a ranking, so
 * it changes the target's priority rather than its stage — and is handed to `reorder`.
 */
export function useBoardDrag(slug: string, state: BoardPoll, reorder: UpNextReorder): BoardDrag {
  const { board, setBoard, draggingRef, versionRef, startWrite, endWrite } = state;
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: defaultKeyboardCoordinateGetter }),
  );

  const activeEpic = useMemo(() => findEpic(board, activeId), [board, activeId]);

  function settle() {
    draggingRef.current = false;
    setActiveId(null);
  }

  async function onDragEnd(event: DragEndEvent) {
    settle();
    if (!board) return;
    const { active, over } = event;
    if (over && active.data.current?.upNext && over.data.current?.upNext) {
      await reorder.reorder(String(active.id), String(over.id));
      return;
    }
    const target = dropTarget(board, event);
    if (!target) return;

    const { epic, toStage } = target;
    const previous = board;
    startWrite();
    setBoard({ ...board, columns: moveEpicBetweenColumns(board.columns, epic.id, toStage) });

    try {
      const settled = await postMove(slug, epic.id, toStage);
      // Adopt the authoritative post-move board so versionRef advances past this write. Without it
      // the next poll sends the stale version, the non-blocking poll path serves the retained
      // pre-move snapshot stamped with the new version, and the just-moved card reverts (anton-4g35).
      // Guard on draggingRef exactly like the poll: if another drag started while this POST was in
      // flight, keep that live optimistic board and let its own move settle the version.
      if (settled && !draggingRef.current) {
        versionRef.current = settled.version;
        setBoard(settled);
      }
      toast.success(`Moved "${epic.title}" to ${STAGE_LABELS[toStage]}`);
    } catch (err) {
      setBoard(previous);
      toast.error(err instanceof Error ? err.message : "Failed to move card");
    } finally {
      // A poll fetched against the pre-move version must not be believed now the move has settled.
      endWrite();
    }
  }

  return {
    activeEpic,
    dnd: {
      sensors,
      onDragStart: (event) => {
        draggingRef.current = true;
        setActiveId(String(event.active.id));
      },
      onDragEnd: (event) => void onDragEnd(event),
      onDragCancel: settle,
    },
  };
}

/** A card by id, across every stage column. */
export function findEpic(board: Board | null, epicId: string | null): Epic | null {
  if (!board || !epicId) return null;
  for (const stage of STAGES) {
    const found = board.columns[stage]?.find((epic) => epic.id === epicId);
    if (found) return found;
  }
  return null;
}

/**
 * The move a drop describes, or `null` when it changes nothing: no droppable under the cursor, a
 * drop back into the column it came from, or a card that has since left the board.
 */
export function dropTarget(board: Board, event: DragEndEvent): { epic: Epic; toStage: Stage } | null {
  const { active, over } = event;
  if (!over) return null;
  const toStage = over.id as Stage;
  // The lane's cards are droppables too, so `over` is only a column when it says it is — a card
  // dropped on a lane card from outside must not be read as a move to a stage named after a bead.
  if (!STAGES.includes(toStage)) return null;
  const fromStage = active.data.current?.stage as Stage | undefined;
  if (!fromStage || fromStage === toStage) return null;
  const epic = board.columns[fromStage]?.find((candidate) => candidate.id === String(active.id));
  return epic ? { epic, toStage } : null;
}

/**
 * Commit a move and answer with the authoritative post-move board the route returns. Throws with the
 * route's own reason so the caller can roll back and say why.
 */
async function postMove(slug: string, epicId: string, toStage: Stage): Promise<Board | undefined> {
  const res = await fetch(`/api/projects/${slug}/cards/${epicId}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toStage } satisfies MoveRequest),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Move failed (${res.status})`);
  }
  const data = (await res.json().catch(() => null)) as { board?: Board } | null;
  return data?.board;
}
