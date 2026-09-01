"use client";

import { useState } from "react";
import { DndContext, closestCorners } from "@dnd-kit/core";
import { restrictToWindowEdges } from "@dnd-kit/modifiers";

import type { Board, EscalationView } from "@/lib/types";
import type { AutopilotBreaker } from "@/lib/autopilot-breaker";
import { BoardCanvas } from "@/components/board/board-canvas";
import {
  BoardBreakerSlot,
  BoardDragOverlay,
  BoardLoadError,
} from "@/components/board/board-parts";
import { BoardSkeleton } from "@/components/board/board-skeleton";
import { BoardToolbar } from "@/components/board/board-toolbar";
import { EscalationStrip } from "@/components/board/escalation-strip";
import { useBoardBreaker } from "@/components/board/use-board-breaker";
import { useBoardDrag } from "@/components/board/use-board-drag";
import { useBoardPoll } from "@/components/board/use-board-poll";
import { useBoardView } from "@/components/board/use-board-view";
import { useUpNextReorder } from "@/components/board/use-up-next-reorder";
import { useBoardGrouping } from "@/lib/use-board-grouping";
import type { BoardSort } from "@/components/board/board-utils";
import { TicketDialog } from "@/components/ticket/ticket-dialog";

/**
 * The project board: every run target and loose ticket, in the arrangement the operator chose, live.
 *
 * The reads live in use-board-poll / use-board-breaker, the drag write in use-board-drag, and the
 * narrow → sort → group derivation in use-board-view — so this only wires them to the surfaces that
 * render them.
 */
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
   * the board re-reads it on its own slower cadence because a hold is released by a PR merging or
   * closing, which nothing on an open board would otherwise notice.
   *
   * A PROMISE, not a value: deciding the hold reads GitHub, and the cards must not wait on that.
   */
  breaker?: Promise<AutopilotBreaker | undefined>;
  /** Project budget-aware flag (anton-y2ue): when on, cards offer Approve (immediate) vs Queue (paced). */
  budgetAware?: boolean;
}) {
  const [sort, setSort] = useState<BoardSort>("default");
  // Stage columns or epic swimlanes — the same cards either way, remembered per project.
  const [grouping, setGrouping] = useBoardGrouping(slug);
  // The standalone task/bug whose detail dialog is open. Epics still deep-link to their own page;
  // standalone chips (an epic-of-one) reuse the shared TicketDialog inline.
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);

  const state = useBoardPoll(slug, initialBoard);
  const polledBreaker = useBoardBreaker(slug, breaker);
  const view = useBoardView(state.board, sort, grouping);
  const reorder = useUpNextReorder(slug, state, view.upNext);
  const drag = useBoardDrag(slug, state, reorder);

  if (state.error) return <BoardLoadError message={state.error} onRetry={state.refresh} />;
  if (!state.board) return <BoardSkeleton />;

  return (
    <DndContext
      // Stable id → deterministic aria-describedby. dnd-kit's useUniqueId falls back to a
      // module-level counter that drifts between SSR and hydration (DndDescribedBy-0 vs -N);
      // passing an explicit id short-circuits it and kills the hydration mismatch. Scope by
      // slug so multiple boards on a page still get distinct, deterministic ids.
      id={`epic-board-${slug}`}
      collisionDetection={closestCorners}
      modifiers={[restrictToWindowEdges]}
      {...drag.dnd}
    >
      <BoardToolbar
        slug={slug}
        board={state.board}
        filters={view.filters}
        query={view.query}
        grouping={grouping}
        onGroupingChange={setGrouping}
        sort={sort}
        onSortChange={setSort}
      />
      {/* Above the escalations, because it outranks them: an escalation is one stalled card, a
          breaker is every card that would have started. */}
      <BoardBreakerSlot slug={slug} polled={polledBreaker} streamed={breaker} />
      {/* The one band that still needs a DECISION about a card below it, not just a look. Escalations
          come from the page's server render — they are answered by an action that reloads, not by a
          poll — so they don't ride the board payload the way hygiene/trend/scan health used to. */}
      <EscalationStrip slug={slug} escalations={escalations} />
      <BoardCanvas
        slug={slug}
        view={view}
        budgetAware={budgetAware}
        reordering={reorder.reordering}
        onEpicDeleted={state.removeEpic}
        onOpenTicket={setOpenTicketId}
        onVetoed={state.vetoBead}
      />
      <BoardDragOverlay slug={slug} epic={drag.activeEpic} />
      <TicketDialog
        slug={slug}
        ticketId={openTicketId}
        open={openTicketId !== null}
        onClose={() => setOpenTicketId(null)}
        // A saved/deleted standalone ticket may change title, stage, or drop off the board — force a
        // fresh load so the chips reflect it.
        onSaved={state.refresh}
        onDeleted={state.refresh}
      />
    </DndContext>
  );
}
