"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { SyncStatusBadge } from "@/components/board/sync-status-badge";
import { Button } from "@/components/ui/button";

/** Board freshness cadence — matches the sync engine's heartbeat so remote changes surface
 * within one beat + one poll (anton-live-sync R8). */
const BOARD_POLL_MS = 30_000;

export function EpicBoard({ slug, initialBoard }: { slug: string; initialBoard: Board | null }) {
  const [board, setBoard] = useState<Board | null>(initialBoard);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Poll guard: a poll result landing mid-drag would clobber the drag interaction; the ref
  // mirrors activeId so the polling closure sees the live value.
  const draggingRef = useRef(false);
  const versionRef = useRef(initialBoard?.version);
  const loadingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load(force = false) {
      if (loadingRef.current) return;
      loadingRef.current = true;
      try {
        const version = versionRef.current;
        const suffix = !force && version !== undefined ? `?version=${encodeURIComponent(version)}` : "";
        const res = await fetch(`/api/projects/${slug}/board${suffix}`);
        if (res.status === 304) return;
        if (!res.ok) throw new Error(`Failed to load board (${res.status})`);
        const data = (await res.json()) as { board: Board };
        if (!cancelled && !draggingRef.current) {
          versionRef.current = data.board.version;
          setBoard(data.board);
          setError(null);
        }
      } catch (err) {
        // Only the initial load surfaces an error UI; a failed poll keeps the last good board.
        if (!cancelled) {
          setBoard((prev) => {
            if (prev === null) {
              setError(err instanceof Error ? err.message : "Failed to load board");
            }
            return prev;
          });
        }
      } finally {
        loadingRef.current = false;
      }
    }

    async function poll() {
      // Skip work while the tab is hidden or a card is being dragged; keep the loop alive.
      if (document.visibilityState === "visible" && !draggingRef.current) await load();
      if (!cancelled) timer = setTimeout(() => void poll(), BOARD_POLL_MS);
    }

    if (initialBoard === null || attempt > 0) void load(true);
    else timer = setTimeout(() => void poll(), BOARD_POLL_MS);
    const onVisible = () => {
      // Coming back to the tab refreshes immediately instead of waiting out the interval.
      if (document.visibilityState === "visible" && !cancelled) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [slug, attempt, initialBoard]);

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
    draggingRef.current = true;
    setActiveId(String(event.active.id));
  }

  function handleEpicDeleted(epicId: string) {
    setBoard((prev) => {
      if (!prev) return prev;
      const columns = { ...prev.columns };
      for (const stage of STAGES) {
        columns[stage] = (columns[stage] ?? []).filter((e) => e.id !== epicId);
      }
      return { ...prev, columns };
    });
  }

  async function handleDragEnd(event: DragEndEvent) {
    draggingRef.current = false;
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
      onDragCancel={() => {
        draggingRef.current = false;
        setActiveId(null);
      }}
    >
      <div className="flex justify-end pb-2">
        <SyncStatusBadge sync={board.sync} />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        {STAGES.map((stage) => (
          <BoardColumn
            key={stage}
            stage={stage}
            epics={board.columns[stage] ?? []}
            slug={slug}
            onEpicDeleted={handleEpicDeleted}
          />
        ))}
      </div>
      <DragOverlay>{activeEpic ? <EpicCard slug={slug} epic={activeEpic} overlay /> : null}</DragOverlay>
    </DndContext>
  );
}
