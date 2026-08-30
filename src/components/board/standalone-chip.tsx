"use client";

import type { StandaloneItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { TYPE_RAIL } from "@/components/board/board-utils";
import { ChipHeader, ChipMeta } from "@/components/board/standalone-chip-parts";
import { ChipBacklogActions } from "@/components/board/standalone-chip-actions";
import { useStandaloneApproval } from "@/components/board/use-standalone-approval";

/**
 * A standalone (parentless) task/bug — an epic-of-one — rendered as a compact typed chip, not a
 * fake epic card. Carries the shared type language (icon + hue + left rail + badge) and, in the
 * backlog, an "Approve & run" affordance that hits the same T2 approve route an epic uses (the
 * route validates the id is a real run target). A self-filed, still-unread bug shows a marker.
 *
 * The chip itself is only the shell: approval/snooze state lives in useStandaloneApproval, the rows
 * in standalone-chip-parts, and the backlog controls in standalone-chip-actions.
 */
export function StandaloneChip({
  slug,
  item,
  budgetAware = false,
  onOpen,
}: {
  slug: string;
  item: StandaloneItem;
  /**
   * Project budget-aware flag (anton-y2ue): on → the backlog action splits into "Approve" (immediate)
   * and "Queue" (paced for optimal usage); off → a single "Approve & run" button.
   */
  budgetAware?: boolean;
  /** Open this ticket's detail dialog. When omitted the chip is non-interactive (view-only). */
  onOpen?: (ticketId: string) => void;
}) {
  const approval = useStandaloneApproval(slug, item);
  const hasOverlay = Boolean(onOpen);

  return (
    <div
      className={cn(
        "relative flex flex-col gap-2 rounded-[10px] border border-border bg-card/70 p-2.5 text-card-foreground transition-colors hover:border-ring/40",
        TYPE_RAIL[item.type],
        // Dimmed like a blocked card: the runtime won't pick this up as it stands.
        (approval.deferred || item.abandoned) && "opacity-60",
      )}
    >
      {/* Full-bleed trigger — opens the shared TicketDialog. Interactive controls below sit above it
          (z-[1] + pointer-events-auto) so PR links, copy, and Approve & run still work. Mirrors the
          overlay-link pattern the epic card uses to stay a single, valid interactive target. */}
      {onOpen && (
        <button
          type="button"
          onClick={() => onOpen(item.id)}
          aria-label={`Open ${item.type} "${item.title}"`}
          className="absolute inset-0 z-0 rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
      )}
      <ChipHeader item={item} hasOverlay={hasOverlay} />
      <ChipMeta item={item} deferred={approval.deferred} hasOverlay={hasOverlay} />
      {item.stage === "backlog" && (
        <ChipBacklogActions
          slug={slug}
          item={item}
          budgetAware={budgetAware}
          approval={approval}
          hasOverlay={hasOverlay}
        />
      )}
    </div>
  );
}
