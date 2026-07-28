"use client";

import { STAGES, type Stage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BoardColumn } from "@/components/board/board-column";
import { EpicBadge } from "@/components/board/epic-badge";
import { STAGE_ACCENT_DOT, STAGE_LABELS, type EpicLane } from "@/components/board/board-utils";
import { CopyButton } from "@/components/ui/copy-button";

/**
 * The lane grid — one fixed track per stage, shared by the strip and every lane so the columns line
 * up under one set of headings. Fixed rather than responsive on purpose: the headings are hoisted
 * out of the lanes, so a reflow to fewer columns would strand cards under the wrong label. Narrow
 * viewports scroll the lanes horizontally instead.
 */
const LANE_GRID = "grid grid-cols-[repeat(4,minmax(210px,1fr))] gap-3.5 px-3";

/** The stage columns are labelled once for the whole swimlane view — every lane shares the grid,
 * so repeating the headings per lane would cost four rows of chrome for no extra orientation. */
export function LaneStageStrip() {
  return (
    <div className={cn(LANE_GRID, "sticky top-0 z-10 shrink-0 bg-background pb-2")}>
      {STAGES.map((stage) => (
        <div key={stage} className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "size-2.5 rounded-full",
              STAGE_ACCENT_DOT[stage],
              stage === "implementing" && "anton-pulse",
            )}
            aria-hidden="true"
          />
          <h2 className="text-[13px] font-semibold text-foreground">{STAGE_LABELS[stage]}</h2>
        </div>
      ))}
    </div>
  );
}

/**
 * One epic swimlane: the lane's product epic, its id, its rollup — then the same stage columns and
 * the same cards the stage view renders, narrowed to that epic. Run targets with no epic collect in
 * the final "No epic" lane, which reads as unmigrated rather than broken
 * (docs/design/2026-07-26-tier-and-linear-ux.md).
 */
export function EpicLaneView({
  slug,
  lane,
  budgetAware = false,
  onEpicDeleted,
  onOpenTicket,
}: {
  slug: string;
  lane: EpicLane;
  budgetAware?: boolean;
  onEpicDeleted?: (epicId: string) => void;
  onOpenTicket?: (ticketId: string) => void;
}) {
  const key = lane.epic?.id ?? "no-epic";

  return (
    <section aria-label={lane.epic ? `Epic ${lane.epic.title}` : "No epic"} className="flex flex-col">
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 border-l-[3px] px-3 py-2",
          lane.epic ? "border-l-type-epic bg-type-epic/5" : "border-l-border bg-muted/30",
        )}
      >
        {lane.epic ? (
          <>
            <EpicBadge slug={slug} epic={lane.epic} />
            <CopyButton value={lane.epic.id} label="epic id" className="font-mono text-[11px]">
              {lane.epic.id}
            </CopyButton>
          </>
        ) : (
          <span className="inline-flex items-center rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] leading-none font-medium text-subtle">
            No epic
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
          <LaneRollup lane={lane} />
        </span>
      </div>

      <div className={cn(LANE_GRID, "border-t border-border py-3")}>
        {STAGES.map((stage: Stage) => (
          <BoardColumn
            key={stage}
            stage={stage}
            lane={key}
            epics={lane.columns[stage] ?? []}
            standalone={lane.standalone[stage] ?? []}
            slug={slug}
            budgetAware={budgetAware}
            onEpicDeleted={onEpicDeleted}
            onOpenTicket={onOpenTicket}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * What the lane amounts to. An epic lane rolls its run targets up the way the roadmap does
 * (shipped of total); the "No epic" lane has nothing to roll up, so it counts what is loose there —
 * the number that shrinks as the board migrates onto the epic tier.
 */
function LaneRollup({ lane }: { lane: EpicLane }) {
  if (!lane.epic) {
    const loose = lane.features + lane.loose;
    return <>{loose === 1 ? "1 loose run target" : `${loose} loose run targets`}</>;
  }
  if (lane.features === 0) return <>no features yet</>;
  return (
    <>
      {lane.shipped} of {lane.features} {lane.features === 1 ? "feature" : "features"} shipped
    </>
  );
}
