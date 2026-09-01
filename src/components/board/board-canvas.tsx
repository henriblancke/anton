"use client";

import { STAGES, type Epic, type Stage, type StandaloneItem } from "@/lib/types";
import { BoardColumn } from "@/components/board/board-column";
import { EpicLaneView, LaneStageStrip } from "@/components/board/epic-lane";
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
}

/** The cards themselves, arranged the way the grouping toggle asked for. */
export function BoardCanvas({ view, ...cards }: { view: BoardView } & CardContext) {
  return view.lanes ? (
    <BoardLanes lanes={view.lanes} {...cards} />
  ) : (
    <BoardStageGrid columns={view.columns} standalone={view.standalone} {...cards} />
  );
}

/** The daily execution view: one droppable column per stage. */
function BoardStageGrid({
  columns,
  standalone,
  ...cards
}: {
  columns: Record<Stage, Epic[]>;
  standalone: Record<Stage, StandaloneItem[]>;
} & CardContext) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
      {STAGES.map((stage) => (
        <BoardColumn
          key={stage}
          stage={stage}
          epics={columns[stage]}
          standalone={standalone[stage]}
          {...cards}
        />
      ))}
    </div>
  );
}

/**
 * The product swimlanes. They share one horizontal scroller so every lane's stage columns line up
 * under the single stage strip, at any width.
 */
function BoardLanes({ lanes, ...cards }: { lanes: EpicLane[] } & CardContext) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <LaneStageStrip />
      {lanes.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-3 py-10 text-center text-xs text-subtle">
          No cards to group yet
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {lanes.map((lane) => (
            <EpicLaneView key={lane.epic?.id ?? "no-epic"} lane={lane} {...cards} />
          ))}
        </div>
      )}
    </div>
  );
}
