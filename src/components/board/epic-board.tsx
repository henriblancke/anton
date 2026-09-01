"use client";

import { Fragment, Suspense, useEffect, useMemo, useRef, useState } from "react";
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
  reorderPriority,
  reorderUpNextEntries,
  sortEpics,
  takeUpNext,
  type BoardSort,
} from "@/components/board/board-utils";
import { BoardFilters } from "@/components/board/board-filters";
import { BoardGroupingToggle } from "@/components/board/board-grouping-toggle";
import { EpicLaneView, LaneStageStrip } from "@/components/board/epic-lane";
import { UpNextLane } from "@/components/board/up-next-lane";
import { useBoardGrouping } from "@/lib/use-board-grouping";
import { SyncStatusBadge } from "@/components/board/sync-status-badge";
import { EscalationStrip } from "@/components/board/escalation-strip";
import {
  AutopilotBreakerBand,
  AutopilotBreakerHeader,
} from "@/components/board/autopilot-breaker-header";
import { HealthPill } from "@/components/board/health-pill";
import { Button } from "@/components/ui/button";
import { TicketDialog } from "@/components/ticket/ticket-dialog";
import { PRIORITY_LABELS } from "@/components/ticket/ticket-dialog-utils";
import { cn } from "@/lib/utils";

const BOARD_SORTS: BoardSort[] = ["default", "risk", "size"];

/** Stand-in stage map for the render before a board has landed — nothing here mutates it. */
const NO_COLUMNS: Record<Stage, Epic[]> = Object.freeze({
  backlog: [],
  implementing: [],
  "in-review": [],
  done: [],
}) as Record<Stage, Epic[]>;

const sortSelectClassName =
  "h-8 rounded-lg border border-border bg-card px-2 text-xs text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Board freshness cadence — matches the sync engine's heartbeat so remote changes surface
 * within one beat + one poll (anton-live-sync R8). */
const BOARD_POLL_MS = 30_000;

/**
 * Breaker freshness cadence (anton-5c8h). Slower than the cards on purpose: the read behind the band
 * costs a board read plus a `gh pr view` per PR waiting in review, and it only ever changes when a
 * PR merges or closes — an event no keystroke on this board produces. Half the card cadence keeps a
 * released hold on screen for at most a minute while leaving the common case (nothing held, no PR
 * reads at all) cheap.
 */
const BREAKER_POLL_MS = 60_000;

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
   * Why the autopilot has stopped filling the queue, if it has (anton-5c8h). The FIRST paint only:
   * the board re-reads it on its own slower cadence (BREAKER_POLL_MS) because a hold is released by
   * a PR merging or closing, which nothing on an open board would otherwise notice.
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
  // The polled breaker, once one has landed — `null` until then, so the server's streamed read is
  // what the first paint uses. Wrapped rather than stored bare because `undefined` is a real answer
  // ("the autopilot is running, show no band") and must not read as "not polled yet".
  const [polledBreaker, setPolledBreaker] = useState<{ value?: AutopilotBreaker } | null>(null);
  // Poll guard: a poll result landing mid-drag would clobber the drag interaction; the ref
  // mirrors activeId so the polling closure sees the live value.
  const draggingRef = useRef(false);
  const versionRef = useRef(initialBoard?.version);
  const loadingRef = useRef(false);
  // Bumped as each board write settles. A poll fetched against the PRE-write version is answered on
  // the route's non-blocking path with the retained pre-write board stamped with the version the
  // write already advanced to — believing that after the write restores both the stale board and a
  // token the next poll 304s on, silently undoing the drag. Comparing the sequence a poll left with
  // against the current one discards exactly those.
  const writeSeqRef = useRef(0);
  // Board writes currently in flight. The sequence above only catches polls that land AFTER a write
  // settles; one that lands DURING it is just as stale — the drag is optimistic-only until the PATCH
  // returns, and the reorder path has no authoritative board to re-adopt afterwards, so accepting
  // that poll reverts the lane on screen until the next beat. Suppress for the whole write instead.
  const writesInFlightRef = useRef(0);
  // One lane reorder at a time (PR #212 review). Suppressing polls is not enough: a second drop
  // applied optimistically while the first PATCH is out is erased by the first's rollback, and its
  // own success reconciles nothing — the lane would show an order neither write asked for. The ref
  // refuses the second drop synchronously; the state disables the lane's handles so it can't start.
  const reorderingRef = useRef(false);
  const [reordering, setReordering] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load(force = false) {
      if (loadingRef.current) return;
      loadingRef.current = true;
      try {
        const version = versionRef.current;
        const writeSeq = writeSeqRef.current;
        const suffix = !force && version !== undefined ? `?version=${encodeURIComponent(version)}` : "";
        const res = await fetch(`/api/projects/${slug}/board${suffix}`);
        if (res.status === 304) return;
        if (!res.ok) throw new Error(`Failed to load board (${res.status})`);
        const data = (await res.json()) as { board: Board };
        if (
          !cancelled &&
          !draggingRef.current &&
          writesInFlightRef.current === 0 &&
          writeSeq === writeSeqRef.current
        ) {
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
      // Skip work while the tab is hidden, a card is being dragged, or a write is settling; keep
      // the loop alive.
      if (document.visibilityState === "visible" && !draggingRef.current && writesInFlightRef.current === 0) {
        await load();
      }
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

  /**
   * Adopt a REFRESHED server board. `board` is seeded from `initialBoard` once and client-owned
   * after that, so a `router.refresh()` — how `[Release]` answers a lost claim race, and how the
   * ticket dialog answers a save — re-renders the page for nothing: the stale card keeps offering a
   * pick that already 409s until the next beat. The refreshed prop IS the authoritative read, so
   * take it directly rather than spending a second fetch on the same answer.
   *
   * The mount value is skipped (it already seeded state), and an interaction in flight wins: its own
   * settle has the last word on the board it is optimistically showing.
   */
  const seededBoardRef = useRef(initialBoard);
  useEffect(() => {
    if (initialBoard === null || initialBoard === seededBoardRef.current) return;
    seededBoardRef.current = initialBoard;
    if (draggingRef.current || writesInFlightRef.current > 0) return;
    versionRef.current = initialBoard.version;
    setBoard(initialBoard);
  }, [initialBoard]);

  // A re-arm ends in router.refresh(), which re-renders the page and hands down a FRESH read. Drop
  // the polled answer whenever that happens, so the band clears on the click that cleared the latch
  // rather than a poll later.
  useEffect(() => {
    setPolledBreaker(null);
  }, [breaker]);

  // Keep the breaker honest while the board stays open (anton-5c8h). A hold promises it releases
  // itself when a PR merges or closes — a thing that happens on GitHub, with nothing on this board
  // to notice it — so the band it draws would otherwise outlive its own release until a reload.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function read() {
      try {
        const res = await fetch(`/api/projects/${slug}/autopilot/breaker`);
        if (!res.ok) return;
        const data = (await res.json()) as { breaker: AutopilotBreaker | null };
        if (!cancelled) setPolledBreaker({ value: data.breaker ?? undefined });
      } catch {
        // A failed read keeps the band that is up. Clearing it on a network blip would tell the
        // operator anton is running when it is frozen — the one error this band must not make.
      }
    }

    async function poll() {
      if (document.visibilityState === "visible") await read();
      if (!cancelled) timer = setTimeout(() => void poll(), BREAKER_POLL_MS);
    }

    timer = setTimeout(() => void poll(), BREAKER_POLL_MS);
    // Coming back to the tab re-reads immediately: an operator returning from merging the PR that
    // released the hold is exactly who is looking at the band.
    const onVisible = () => {
      if (document.visibilityState === "visible" && !cancelled) void read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [slug]);

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

  // The Up Next lane and the Backlog it was taken out of (anton-t9m4). Computed on the SORTED,
  // narrowed board so the lane obeys the same filters as everything else, and subtracted rather than
  // overlaid so no bead renders twice (R3.3). Only in the stage view: the lane is a column position
  // between Backlog and Implementing, and the epic swimlanes group by product rather than by stage —
  // so there the cards stay in Backlog, where they still appear exactly once.
  const upNext = useMemo(
    () =>
      takeUpNext(
        sortedColumns ?? NO_COLUMNS,
        narrowed?.standalone,
        grouping === "stage" ? board?.upNext : undefined,
      ),
    [sortedColumns, narrowed, grouping, board?.upNext],
  );
  // An empty lane is worse than none: with no plan recorded — or a picker the operator disarmed —
  // "Up Next" with nothing under it reads as "anton has nothing to start" rather than "no pass is
  // running here" (R3.4).
  const hasUpNext = upNext.cards.length > 0;

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

  /**
   * A target the operator just set aside (anton-jqvy / R3.9). Stamped locally so the card reads as
   * deferred on the click that deferred it — the hold is server state, and the board's own poll is
   * up to 30s away, which is long enough for an operator to click `not now` twice.
   *
   * It also leaves Up Next on that click. The lane is driven by the recorded plan, which the next
   * picker pass rewrites up to ten minutes from now — so without this the declined target would keep
   * its place in the ranking it was just refused a place in.
   */
  function handleVetoed(beadId: string, untilMs: number) {
    // A veto is a board write like any other: the deferral it records moves the board version, so a
    // poll that LEFT before it settled answers on the pre-veto board and would put the declined
    // target back in the lane with its controls live — long enough (up to a beat) for the operator
    // to decline the same pick twice. Bumping the sequence here discards exactly those.
    writeSeqRef.current += 1;
    setBoard((prev) => {
      if (!prev) return prev;
      const columns = { ...prev.columns };
      const standalone = { ...prev.standalone };
      for (const stage of STAGES) {
        columns[stage] = (columns[stage] ?? []).map((e) =>
          e.id === beadId ? { ...e, notNowUntil: untilMs } : e,
        );
        standalone[stage] = (standalone[stage] ?? []).map((i) =>
          i.id === beadId ? { ...i, notNowUntil: untilMs } : i,
        );
      }
      // The lane is ABSENT, never empty (types.ts): vetoing its last card drops it rather than
      // leaving an "Up Next" heading over nothing, which reads as "anton has nothing to start".
      const { upNext: ranked, ...rest } = prev;
      const upNext = ranked?.filter((entry) => entry.beadId !== beadId);
      return { ...rest, columns, standalone, ...(upNext?.length ? { upNext } : {}) };
    });
  }

  /**
   * Reorder inside the Up Next lane (R3.8). The drop is persisted as the target's bead `priority` —
   * the same channel product-master writes on — so there is no override state to reconcile and the
   * correction reaches the next picker pass as ordinary board state.
   *
   * A drop the priority channel cannot express — a reorder inside one band, or a slot the picker's
   * own tiebreak would take back — writes nothing and says so. Silently accepting it would teach the
   * operator the lane holds an order it does not.
   */
  async function reorderUpNext(beadId: string, overBeadId: string) {
    if (!board) return;
    // Serialized, not interleaved: this rollback restores the pre-drag ORDER, so a second reorder
    // applied while the first is out would be undone by the first's failure even though its own
    // write succeeded. The lane withdraws itself after a successful reorder anyway, so refusing the
    // second drop costs a beat — where accepting it costs the operator an order nobody asked for.
    if (reorderingRef.current) {
      toast.message("One reorder at a time", {
        description: "The last drop is still being written. Try again once it settles.",
      });
      return;
    }
    const card = upNext.cards.find((c) => c.entry.beadId === beadId);
    if (!card) return;

    const verdict = reorderPriority(
      upNext.cards.map((c) => c.entry),
      beadId,
      overBeadId,
    );
    if (verdict.kind !== "write") {
      toast.message(
        verdict.kind === "settled" ? "Nothing to change" : "That order can't be written",
        {
          description:
            verdict.kind === "settled"
              ? "The plan already ranks this target where you dropped it."
              : "Priority is the only channel a drag has, and no priority holds that slot — inside one band the picker ranks by how much open work each target unblocks, then by age.",
        },
      );
      return;
    }
    const { priority } = verdict;

    const title = card.kind === "epic" ? card.epic.title : card.item.title;
    // Only the lane moves, and it moves on the LATEST board: a poll can land during the PATCH, and
    // both writing and reverting a whole pre-drag snapshot would throw that poll's result away.
    const previousUpNext = board.upNext;
    reorderingRef.current = true;
    setReordering(true);
    writesInFlightRef.current += 1;
    setBoard((prev) => {
      if (!prev) return prev;
      const { upNext: ranked, ...rest } = prev;
      const upNext = reorderUpNextEntries(ranked ?? [], beadId, overBeadId, priority);
      // Absent, never empty (types.ts). A reorder that finds nothing to move — the lane emptied
      // under us between the drag and this update — must drop the key rather than project an
      // "Up Next" heading over nothing.
      return { ...rest, ...(upNext.length ? { upNext } : {}) };
    });

    // A standalone chip is a bead in its own right, so it patches through the ticket route; both
    // routes validate the priority server-side (parseEpicPatch / parseTicketPatch).
    const resource = card.kind === "epic" ? "epics" : "tickets";
    try {
      const res = await fetch(`/api/projects/${slug}/${resource}/${beadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ priority }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Reorder failed (${res.status})`);
      }
      // The write advanced the snapshot version while RETAINING the pre-write beads, so a poll
      // carrying the pre-write token would take the non-blocking path and serve that retained
      // snapshot — re-showing the very order this drag just corrected (anton-4g35, for the
      // stage-move path). Unlike the move endpoint, a priority PATCH answers with the epic/ticket
      // detail rather than a board, so there is no authoritative version to adopt: drop the token
      // instead, and the next poll asks versionlessly and takes the blocking, post-write path.
      versionRef.current = undefined;
      // A reprioritized bead is one the recorded plan no longer describes (isPlanStale), so that
      // post-write board withholds the lane until the next pass re-ranks it. Say so, or the
      // withdrawal reads as the drag having failed.
      toast.success(`Set "${title}" to ${PRIORITY_LABELS[priority]}`, {
        description: "The lane re-ranks from it on the next board-picker pass.",
      });
    } catch (err) {
      setBoard((prev) => {
        if (!prev) return prev;
        const { upNext: ranked, ...rest } = prev;
        // Restore the pre-drag ORDER, not the pre-drag lane. A veto can land between the drop and
        // this rollback and it drops its target from the lane; writing `previousUpNext` back whole
        // would re-offer the pick the operator just declined until the next poll. Keep only what
        // the current lane still ranks, so both updates stand.
        const stillRanked = new Set((ranked ?? []).map((entry) => entry.beadId));
        const restored = (previousUpNext ?? []).filter((entry) => stillRanked.has(entry.beadId));
        return { ...rest, ...(restored.length ? { upNext: restored } : {}) };
      });
      toast.error(err instanceof Error ? err.message : "Failed to reorder");
    } finally {
      // Every poll that left before this point asked on the pre-write version, so its answer is
      // about a board that no longer exists. Bump on failure too: a rejected PATCH is not proof the
      // server wrote nothing. Order matters — the sequence takes over the moment the in-flight
      // suppression lifts, so no poll slips between the two.
      writeSeqRef.current += 1;
      writesInFlightRef.current -= 1;
      reorderingRef.current = false;
      setReordering(false);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    draggingRef.current = false;
    setActiveId(null);
    const { active, over } = event;
    if (!board || !over) return;

    const epicId = String(active.id);
    // Both ends inside the lane is a REORDER, not a move: Up Next is a ranking, so the drop changes
    // the target's priority rather than its stage.
    if (active.data.current?.upNext && over.data.current?.upNext) {
      await reorderUpNext(epicId, String(over.id));
      return;
    }

    const toStage = over.id as Stage;
    // The lane's cards are droppables too, so `over` is only a column when it says it is — a card
    // dropped on a lane card from outside must not be read as a move to a stage named after a bead.
    if (!STAGES.includes(toStage)) return;
    const fromStage = active.data.current?.stage as Stage | undefined;
    if (!fromStage || fromStage === toStage) return;

    const epic = board.columns[fromStage]?.find((e) => e.id === epicId);
    if (!epic) return;

    const previous = board;
    writesInFlightRef.current += 1;
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
    } finally {
      // Same as the reorder path: a poll fetched against the pre-move version must not be believed
      // now that the move has settled.
      writeSeqRef.current += 1;
      writesInFlightRef.current -= 1;
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
        {polledBreaker ? (
          <AutopilotBreakerHeader slug={slug} breaker={polledBreaker.value} />
        ) : (
          <AutopilotBreakerBand slug={slug} breaker={breaker} />
        )}
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
        <div
          className={cn(
            "grid min-h-0 flex-1 grid-cols-1 gap-3.5 sm:grid-cols-2",
            hasUpNext ? "xl:grid-cols-5" : "xl:grid-cols-4",
          )}
        >
          {STAGES.map((stage) => (
            <Fragment key={stage}>
              <BoardColumn
                stage={stage}
                epics={upNext.columns[stage] ?? []}
                standalone={upNext.standalone[stage] ?? []}
                slug={slug}
                budgetAware={budgetAware}
                onEpicDeleted={handleEpicDeleted}
                onOpenTicket={setOpenTicketId}
              />
              {/* Between Backlog and Implementing, never left of Backlog: flow direction is
                  load-bearing, so a card must not move left as it advances (R3.1). */}
              {stage === "backlog" && hasUpNext && (
                <UpNextLane
                  slug={slug}
                  cards={upNext.cards}
                  budgetAware={budgetAware}
                  reordering={reordering}
                  onEpicDeleted={handleEpicDeleted}
                  onOpenTicket={setOpenTicketId}
                  onVetoed={handleVetoed}
                />
              )}
            </Fragment>
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
