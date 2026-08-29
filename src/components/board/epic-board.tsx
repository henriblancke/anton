"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
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

import {
  STAGES,
  type Board,
  type Epic,
  type EscalationView,
  type MoveRequest,
  type Stage,
} from "@/lib/types";
import type { AutopilotBreaker } from "@/lib/autopilot-breaker";
import { EpicCard } from "@/components/board/epic-card";
import { BoardColumn } from "@/components/board/board-column";
import { BoardSkeleton } from "@/components/board/board-skeleton";
import {
  BOARD_SORT_LABELS,
  STAGE_LABELS,
  boardFiltersFromSearchParams,
  filterBoard,
  groupBoardByEpic,
  moveEpicBetweenColumns,
  sortEpics,
  type BoardSort,
} from "@/components/board/board-utils";
import { BoardFilters } from "@/components/board/board-filters";
import { BoardGroupingToggle } from "@/components/board/board-grouping-toggle";
import { EpicLaneView, LaneStageStrip } from "@/components/board/epic-lane";
import { useBoardGrouping } from "@/lib/use-board-grouping";
import { SyncStatusBadge } from "@/components/board/sync-status-badge";
import { EscalationStrip } from "@/components/board/escalation-strip";
import { AutopilotBreakerBand } from "@/components/board/autopilot-breaker-header";
import { HealthPill } from "@/components/board/health-pill";
import { Button } from "@/components/ui/button";
import { TicketDialog } from "@/components/ticket/ticket-dialog";

const BOARD_SORTS: BoardSort[] = ["default", "risk", "size"];

const sortSelectClassName =
  "h-8 rounded-lg border border-border bg-card px-2 text-xs text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Board freshness cadence — matches the sync engine's heartbeat so remote changes surface
 * within one beat + one poll (anton-live-sync R8). */
const BOARD_POLL_MS = 30_000;

export function EpicBoard({
  slug,
  initialBoard,
  escalations = [],
  breaker,
  budgetAware = false,
}: {
  slug: string;
  initialBoard: Board | null;
  /**
   * Open escalations, server-rendered by the page (anton-ue90.1). They are the only signal that
   * still gets a band above the board — hygiene, review trend, and housekeeping moved to the Health
   * page (anton-ue90.3) — and they're answered by an action that reloads the page, so they don't
   * need the board's poll.
   */
  escalations?: EscalationView[];
  /**
   * Why the autopilot has stopped filling the queue, if it has (anton-5c8h). Server-rendered by the
   * page like the escalations beside it: a disarm is cleared by an action that reloads, and a hold
   * changes only when a PR moves — neither is worth a place on the board's 30s poll.
   *
   * A PROMISE, not a value: deciding the hold reads GitHub, and the cards must not wait on that.
   * It streams into its own Suspense boundary below.
   */
  breaker?: Promise<AutopilotBreaker | undefined>;
  /** Project budget-aware flag (anton-y2ue): when on, cards offer Approve (immediate) vs Queue (paced). */
  budgetAware?: boolean;
}) {
  // Epic/Area narrowing lives in the URL, so an epic badge is a plain link and a narrowed board is
  // shareable. Keyed on the serialized query so the derived board only recomputes on a real change.
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const filters = useMemo(() => boardFiltersFromSearchParams(new URLSearchParams(query)), [query]);

  const [board, setBoard] = useState<Board | null>(initialBoard);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sort, setSort] = useState<BoardSort>("default");
  // Stage columns or epic swimlanes — the same cards either way, remembered per project.
  const [grouping, setGrouping] = useBoardGrouping(slug);
  // The standalone task/bug whose detail dialog is open. Epics still deep-link to their own page;
  // standalone chips (an epic-of-one) reuse the shared TicketDialog inline.
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
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

    // Kick an immediate load when there's no board yet or a refresh was requested (retry, or a
    // ticket saved/deleted in the dialog); otherwise the first fetch rides the poll cadence. Poll
    // is always (re)scheduled so a manual refresh never silently ends live sync.
    if (initialBoard === null || attempt > 0) void load(true);
    timer = setTimeout(() => void poll(), BOARD_POLL_MS);
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

  // The board narrowed to the URL's Epic/Area facets — where every epic badge points. Derived, so
  // drag/drop and polling keep operating on the unfiltered source in `board`.
  const narrowed = useMemo(
    () => (board ? filterBoard(board.columns, board.standalone, filters) : null),
    [board, filters],
  );

  // Derived, sorted view over the narrowed columns — each column is reordered for display per the
  // chosen sort, on top of whatever the filters left.
  const sortedColumns = useMemo(() => {
    if (!narrowed) return null;
    return Object.fromEntries(
      STAGES.map((stage) => [stage, sortEpics(narrowed.columns[stage] ?? [], sort)]),
    ) as Record<Stage, Epic[]>;
  }, [narrowed, sort]);

  // The swimlanes are a regrouping of the very cards above — the sorted columns feed both views, so
  // a lane's cards carry the chosen sort and there is no second board to keep in step.
  const lanes = useMemo(
    () =>
      grouping === "epic" && sortedColumns && narrowed
        ? groupBoardByEpic(sortedColumns, narrowed.standalone)
        : null,
    [grouping, sortedColumns, narrowed],
  );

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
      // The move bumped the snapshot version; adopt the authoritative post-move board the route
      // returns so versionRef advances past the write. Without this the next poll sends the stale
      // version and the non-blocking poll path serves the retained pre-move snapshot stamped with the
      // new version — reverting the just-moved card (anton-4g35). Guard on draggingRef exactly like
      // the poll: if another drag started while this POST was in flight, keep that live optimistic
      // board and let its own move settle the version rather than clobber it here.
      const data = (await res.json().catch(() => null)) as { board?: Board } | null;
      if (data?.board && !draggingRef.current) {
        versionRef.current = data.board.version;
        setBoard(data.board);
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
      // Stable id → deterministic aria-describedby. dnd-kit's useUniqueId falls back to a
      // module-level counter that drifts between SSR and hydration (DndDescribedBy-0 vs -N);
      // passing an explicit id short-circuits it and kills the hydration mismatch. Scope by
      // slug so multiple boards on a page still get distinct, deterministic ids.
      id={`epic-board-${slug}`}
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
      <div className="flex flex-wrap items-center justify-end gap-2 pb-2">
        <BoardGroupingToggle value={grouping} onChange={setGrouping} />
        <BoardFilters columns={board.columns} filters={filters} query={query} />
        <span className="flex-1" />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="text-subtle">Sort</span>
          <select
            aria-label="Sort epics"
            value={sort}
            onChange={(e) => setSort(e.target.value as BoardSort)}
            className={sortSelectClassName}
          >
            {BOARD_SORTS.map((option) => (
              <option key={option} value={option}>
                {BOARD_SORT_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        {/* Hygiene, the review trend, and the scan trend all live on the Health page now
            (anton-ue90.3) — this pill is their one doorway from the toolbar, sized and positioned
            like the sync badge it sits beside rather than opening a popover of its own. It rides
            the board payload so its count refreshes on the same 304-friendly poll as the cards. */}
        <HealthPill
          slug={slug}
          hygiene={board.hygiene}
          trajectory={board.reviewTrajectory}
          scanHealth={board.scanHealth}
        />
        <SyncStatusBadge sync={board.sync} />
      </div>
      {/* The one band that still needs a DECISION about a card below it, not just a look. Escalations
          come from the page's server render — they are answered by an action that reloads, not by a
          poll — so they don't ride the board payload the way hygiene/trend/scan health used to. */}
      {/* Above the escalations, because it outranks them: an escalation is one stalled card, a
          breaker is every card that would have started. */}
      {/* Its own boundary, and a null fallback: the band is late context, not a placeholder the
          operator should watch a skeleton for. */}
      <Suspense fallback={null}>
        <AutopilotBreakerBand slug={slug} breaker={breaker} />
      </Suspense>
      <EscalationStrip slug={slug} escalations={escalations} />
      {lanes ? (
        // The lanes share one horizontal scroller so every lane's stage columns line up under the
        // single stage strip, at any width.
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <LaneStageStrip />
          {lanes.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-3 py-10 text-center text-xs text-subtle">
              No cards to group yet
            </p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {lanes.map((lane) => (
                <EpicLaneView
                  key={lane.epic?.id ?? "no-epic"}
                  slug={slug}
                  lane={lane}
                  budgetAware={budgetAware}
                  onEpicDeleted={handleEpicDeleted}
                  onOpenTicket={setOpenTicketId}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
          {STAGES.map((stage) => (
            <BoardColumn
              key={stage}
              stage={stage}
              epics={sortedColumns?.[stage] ?? []}
              standalone={narrowed?.standalone[stage] ?? []}
              slug={slug}
              budgetAware={budgetAware}
              onEpicDeleted={handleEpicDeleted}
              onOpenTicket={setOpenTicketId}
            />
          ))}
        </div>
      )}
      <DragOverlay>{activeEpic ? <EpicCard slug={slug} epic={activeEpic} overlay /> : null}</DragOverlay>
      <TicketDialog
        slug={slug}
        ticketId={openTicketId}
        open={openTicketId !== null}
        onClose={() => setOpenTicketId(null)}
        // A saved/deleted standalone ticket may change title, stage, or drop off the board — force a
        // fresh load so the chips reflect it.
        onSaved={() => setAttempt((n) => n + 1)}
        onDeleted={() => setAttempt((n) => n + 1)}
      />
    </DndContext>
  );
}
