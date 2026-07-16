"use client";

import { useState } from "react";

import type { StandaloneItem } from "@/lib/types";
import { StandaloneChip } from "@/components/board/standalone-chip";

/** How many chips show before the "+N more" cap. Keeps the epics-only board uncluttered. */
const CAP = 3;

/**
 * The standalone (parentless) task/bug chips at the foot of a stage column, under a
 * "standalone · N" divider. Beyond the cap, the overflow collapses behind a "+N more" expander so
 * the board stays epics-first above the fold.
 */
export function StandaloneGroup({
  slug,
  items,
  onOpenTicket,
}: {
  slug: string;
  items: StandaloneItem[];
  /** Open a chip's detail dialog — forwarded from the board. */
  onOpenTicket?: (ticketId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;

  const overflow = items.length - CAP;
  const visible = expanded ? items : items.slice(0, CAP);

  return (
    <div className="mt-1 flex flex-col gap-2">
      <div className="flex items-center gap-2 px-0.5 pt-1">
        <span className="text-[10px] font-medium tracking-wide text-subtle uppercase">standalone</span>
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
        <span className="font-mono text-[10px] text-subtle">{items.length}</span>
      </div>
      {visible.map((item) => (
        <StandaloneChip key={item.id} slug={slug} item={item} onOpen={onOpenTicket} />
      ))}
      {overflow > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="self-start rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {expanded ? "Show less" : `+${overflow} more`}
        </button>
      )}
    </div>
  );
}
