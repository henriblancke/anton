"use client";

import { cn } from "@/lib/utils";
import {
  BOARD_GROUPINGS,
  BOARD_GROUPING_LABELS,
  type BoardGrouping,
} from "@/components/board/board-utils";

/**
 * Stage | Epic — the board's grouping switch. Two states, both one click away and neither hidden
 * behind a menu, because the swimlane view is a glance you take and leave
 * (docs/design/2026-07-26-tier-and-linear-ux.md).
 */
export function BoardGroupingToggle({
  value,
  onChange,
}: {
  value: BoardGrouping;
  onChange: (next: BoardGrouping) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Board grouping"
      className="inline-flex h-8 items-stretch overflow-hidden rounded-lg border border-border"
    >
      {BOARD_GROUPINGS.map((grouping) => {
        const active = grouping === value;
        return (
          <button
            key={grouping}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(grouping)}
            className={cn(
              "border-l border-border bg-card px-2.5 text-xs text-muted-foreground transition-colors first:border-l-0 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
              active && "bg-primary/15 font-semibold text-foreground",
            )}
          >
            {BOARD_GROUPING_LABELS[grouping]}
          </button>
        );
      })}
    </div>
  );
}
