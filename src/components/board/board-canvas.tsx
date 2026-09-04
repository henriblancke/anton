"use client";

import { Fragment } from "react";

import { STAGES, type Epic, type Stage, type StandaloneItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BoardColumn } from "@/components/board/board-column";
import { EpicLaneView, LaneStageStrip } from "@/components/board/epic-lane";
import { PlanGenerationProvider } from "@/components/board/pick-decision";
import { UpNextAbsenceLane, UpNextLane } from "@/components/board/up-next-lane";
import type { EpicLane } from "@/components/board/board-utils";
import type { BoardView } from "@/components/board/use-board-view";

/** What every card on the board needs, whichever arrangement it is drawn in. */
interface CardContext {
  slug: string;
  /** Project budget-aware flag (anton-y2ue): when on, cards offer Approve (immediate) vs Queue (paced). */
  budgetAware: boolean;
  onEpicDeleted: (epicId: string) => void;
  /** Open a standalone ticket's detail dialog — hoisted to the board so one dialog serves all. */
  onOpenTicket: (ticketId: string) => void;
  /** A target the operator just set aside, so the board can hold it back before the next poll. */
  onVetoed: (beadId: string, untilMs: number) => void;
}

/** The cards themselves, arranged the way the grouping toggle asked for. */
export function BoardCanvas({
  view,
  reordering,
  ...cards
}: {
  view: BoardView;
  /** A lane reorder is being written; the lane closes its handles for the round-trip. */
  reordering: boolean;
} & CardContext) {
  return view.lanes ? (
    <BoardLanes lanes={view.lanes} planId={view.planId} {...cards} />
  ) : (
    <BoardStageGrid
      columns={view.columns}
      standalone={view.standalone}
      upNext={view.upNext}
      upNextPlan={view.upNextPlan}
      {...(view.planId === undefined ? {} : { planId: view.planId })}
      {...(view.upNextAbsence === undefined ? {} : { upNextAbsence: view.upNextAbsence })}
      reordering={reordering}
      {...cards}
    />
  );
}

/**
 * The daily execution view: one droppable column per stage, with the Up Next lane between Backlog
 * and Implementing — never left of Backlog, because flow direction is load-bearing and a card must
 * not move left as it advances (R3.1).
 *
 * An empty lane is worse than none: with no plan recorded — or a picker the operator disarmed —
 * "Up Next" with nothing under it reads as "anton has nothing to start" rather than "no pass is
 * running here" (R3.4). Which is why the lane holds its column for a NAMED absence (anton-w579) and
 * only for a named one: the header then says which nothing it is and what clears it, instead of
 * leaving the operator to read a bare count of zero — or a missing column — as a verdict on their
 * board.
 */
function BoardStageGrid({
  columns,
  standalone,
  upNext,
  upNextPlan,
  planId,
  upNextAbsence,
  reordering,
  onVetoed,
  ...cards
}: {
  columns: Record<Stage, Epic[]>;
  standalone: Record<Stage, StandaloneItem[]>;
  reordering: boolean;
} & Pick<BoardView, "upNext" | "upNextPlan" | "planId" | "upNextAbsence"> &
  CardContext) {
  const hasUpNext = upNext.length > 0;
  // The section keeps its column while it has something to say — a ranking, or an absence it can
  // name. Only the unnamed absence (a plan the board has moved past) drops back to four columns.
  const showsLane = hasUpNext || upNextAbsence !== undefined;
  return (
    <div
      className={cn(
        "grid min-h-0 flex-1 grid-cols-1 gap-3.5 sm:grid-cols-2",
        showsLane ? "xl:grid-cols-5" : "xl:grid-cols-4",
      )}
    >
      {STAGES.map((stage) => (
        <Fragment key={stage}>
          <BoardColumn
            stage={stage}
            epics={columns[stage]}
            standalone={standalone[stage]}
            {...cards}
          />
          {stage === "backlog" && hasUpNext && (
            <UpNextLane
              cards={upNext}
              plan={upNextPlan}
              {...(planId === undefined ? {} : { planId })}
              reordering={reordering}
              onVetoed={onVetoed}
              {...cards}
            />
          )}
          {stage === "backlog" && !hasUpNext && upNextAbsence !== undefined && (
            <UpNextAbsenceLane slug={cards.slug} absence={upNextAbsence} />
          )}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The product swimlanes. They share one horizontal scroller so every lane's stage columns line up
 * under the single stage strip, at any width.
 *
 * The picks stay in their epic's Backlog slice here — no lane, so no row to carry the generation
 * they were drawn from, and none to carry the vetoes either. The surface supplies both: without the
 * generation `[Release]` would post an unnamed accept the server resolves against whatever plan is
 * current by then, and without the veto sink this layout would offer the operator no way to REFUSE
 * a pick at all (PR #212 review).
 */
function BoardLanes({
  lanes,
  planId,
  onVetoed,
  ...cards
}: { lanes: EpicLane[]; planId?: string } & CardContext) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <LaneStageStrip />
      {lanes.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-3 py-10 text-center text-xs text-subtle">
          No cards to group yet
        </p>
      ) : (
        <PlanGenerationProvider
          {...(planId === undefined ? {} : { planId })}
          onVetoed={onVetoed}
        >
          <div className="flex flex-col divide-y divide-border">
            {lanes.map((lane) => (
              <EpicLaneView key={lane.epic?.id ?? "no-epic"} lane={lane} {...cards} />
            ))}
          </div>
        </PlanGenerationProvider>
      )}
    </div>
  );
}
