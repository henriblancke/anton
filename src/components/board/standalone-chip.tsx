"use client";

import type { StandaloneItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { TYPE_RAIL, isPickerPick } from "@/components/board/board-utils";
import { ChipHeader, ChipMeta } from "@/components/board/standalone-chip-parts";
import { ChipBacklogActions } from "@/components/board/standalone-chip-actions";
import {
  PickDecisionProvider,
  useCardVeto,
  useUnrecordedPick,
} from "@/components/board/pick-decision";
import { useStandaloneApproval } from "@/components/board/use-standalone-approval";

type StandaloneChipProps = {
  slug: string;
  item: StandaloneItem;
  /**
   * Project budget-aware flag (anton-y2ue): on → the backlog action splits into "Approve" (immediate)
   * and "Queue" (paced for optimal usage); off → a single "Approve & run" button.
   */
  budgetAware?: boolean;
  /** Open this ticket's detail dialog. When omitted the chip is non-interactive (view-only). */
  onOpen?: (ticketId: string) => void;
};

/**
 * A standalone (parentless) task/bug — an epic-of-one — rendered as a compact typed chip, not a
 * fake epic card. Carries the shared type language (icon + hue + left rail + badge) and, in the
 * backlog, an "Approve & run" affordance that hits the same T2 approve route an epic uses (the
 * route validates the id is a real run target). A self-filed, still-unread bug shows a marker.
 *
 * The chip itself is only the shell: approval/snooze state lives in useStandaloneApproval, the rows
 * in standalone-chip-parts, and the backlog controls in standalone-chip-actions.
 *
 * A picked chip on a surface with no lane row to answer it (the epic swimlanes, PR #212 review)
 * carries the pick's decision itself — the vetoes beside `[Release]`, under one lock — exactly as
 * the card does. The provider wraps the chip rather than living inside it, so the chip's own
 * approval hook takes the lock it created.
 */
export function StandaloneChip(props: StandaloneChipProps) {
  const cardVeto = useCardVeto();
  const { item } = props;
  const recorded = isPickerPick(item.provenance);
  // The vetoes follow the LIVE pick, recorded or not — same reasoning as the card (PR #226 review).
  const unrecorded = useUnrecordedPick(item.id, recorded);
  const answerable =
    cardVeto !== undefined && (recorded || unrecorded) && item.notNowUntil === undefined;
  if (!answerable) return <ChipBody {...props} />;
  return (
    <PickDecisionProvider>
      <ChipBody {...props} cardVeto={cardVeto} />
    </PickDecisionProvider>
  );
}

function ChipBody({
  slug,
  item,
  budgetAware = false,
  onOpen,
  cardVeto,
}: StandaloneChipProps & {
  /** Set when this chip owns its pick's vetoes; where the hold they place is reported. */
  cardVeto?: (beadId: string, untilMs: number) => void;
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
      <ChipMeta slug={slug} item={item} deferred={approval.deferred} hasOverlay={hasOverlay} />
      {item.stage === "backlog" && (
        <ChipBacklogActions
          slug={slug}
          item={item}
          budgetAware={budgetAware}
          approval={approval}
          hasOverlay={hasOverlay}
          {...(cardVeto === undefined ? {} : { cardVeto })}
        />
      )}
    </div>
  );
}
