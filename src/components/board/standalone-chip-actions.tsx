"use client";

import { useState } from "react";

import type { StandaloneItem } from "@/lib/types";
// The predicate itself, not a chip-local copy: approve and the runner ask the same one.
import { contractBlocks } from "@/lib/beads/contract";
import { cn } from "@/lib/utils";
import { SnoozeButton } from "@/components/ticket/snooze-button";
import { ClaimControl } from "@/components/board/claim-control";
import { ApproveBlocked } from "@/components/board/contract-mark";
import { ApproveRunButtons } from "@/components/board/approve-run-buttons";
import { VetoActions } from "@/components/board/veto-actions";
import {
  PickAwaitingRecord,
  usePickDecision,
  useUnrecordedPick,
} from "@/components/board/pick-decision";
import { isPickerPick } from "@/components/board/board-utils";
import type { StandaloneApproval } from "@/components/board/use-standalone-approval";

/**
 * Whether this chip may offer a run at all. Gates on readiness, not just stage: the approve route
 * rejects a still-blocked standalone target with 409, so a chip with open blockers must not offer
 * Approve & run (mirrors the epic card). A snoozed item hides it too — the snooze exists to keep
 * this off the runtime's plate.
 */
export function canOfferRun(item: StandaloneItem, approved: boolean, deferred: boolean): boolean {
  return item.stage === "backlog" && !approved && item.ready && !deferred;
}

/**
 * The run affordance in its shapes: inert-and-explaining when the contract blocks the run, `[Release]`
 * when the board-picker chose this target, split into Queue/Approve when the project is budget-aware
 * (anton-y2ue), and a single "Approve & run" otherwise. Renders nothing when this chip may not offer
 * a run — except after a release that approved the target without starting one, where the retry is
 * the only way back to a run.
 *
 * A contract gap withholds the run the way an open blocker does, but asks for an edit rather than a
 * wait — so the affordance stays put and names the missing section instead of failing on click
 * (mirrors the card). An unrecorded pick withholds it ahead of both and offers nothing to click at
 * all (anton-5axf) — also mirroring the card.
 */
export function ApproveRunAction({
  slug,
  item,
  budgetAware,
  approval,
}: {
  slug: string;
  item: StandaloneItem;
  budgetAware: boolean;
  approval: StandaloneApproval;
}) {
  // A release whose approve landed with nothing enqueued leaves the target approved and idle, which
  // is precisely what `canOfferRun` withholds the run for — so the retry the failure copy points at
  // would vanish on the next poll (PR #212 review). Reopen the affordance until a run actually
  // starts; approve re-enqueues for an already-approved target.
  const [unrun, setUnrun] = useState(false);
  // A chip the picker chose starts with [Release] (anton-d2h6 / R3.5) — the same approve route and
  // the same run, plus the accept that records the operator agreed with the pick. A target already
  // set aside keeps the plain approve: offering [Release] there would re-offer the declined start.
  const recorded = isPickerPick(item.provenance);
  const picked = recorded && item.notNowUntil === undefined;
  // This chip is anton's pick and nothing has recorded that decision: a start here would be one the
  // accept ledger has no answer for, so the chip says what it is waiting for instead. Asked of the
  // surface too, since the epic swimlanes have no lane row to answer it (PR #226 review).
  const unconfirmed = useUnrecordedPick(item.id, recorded);
  if (!canOfferRun(item, approval.approved, approval.deferred) && !unrun) return null;

  if (unconfirmed) return <PickAwaitingRecord />;

  if (contractBlocks(item.contract)) {
    return <ApproveBlocked violations={item.contract?.blocking ?? []} label="Approve & run" />;
  }

  return (
    <ApproveRunButtons
      budgetAware={budgetAware}
      approval={approval}
      label="Approve & run"
      busyLabel="Starting…"
      {...(picked
        ? {
            release: {
              slug,
              beadId: item.id,
              title: item.title,
              onReleased: () => {
                setUnrun(false);
                approval.setApproved();
              },
              onApprovedWithoutRun: () => setUnrun(true),
            },
          }
        : {})}
    />
  );
}

/** Everything a backlog chip can be driven by: claim on its own line, then Queue · Approve · Snooze. */
export function ChipBacklogActions({
  slug,
  item,
  budgetAware,
  approval,
  hasOverlay,
  cardVeto,
}: {
  slug: string;
  item: StandaloneItem;
  budgetAware: boolean;
  approval: StandaloneApproval;
  /** The chip's full-bleed open trigger sits behind this row; controls opt back into pointers. */
  hasOverlay: boolean;
  /**
   * Set when this chip owns its pick's vetoes — a surface with no lane row above it (PR #212
   * review). Reports the hold they place so that surface can hold the target back.
   */
  cardVeto?: (beadId: string, untilMs: number) => void;
}) {
  const decision = usePickDecision();
  const recorded = isPickerPick(item.provenance);
  // The vetoes answer the live pick whether or not a pass wrote it down — mirrors the card, and the
  // lane rows that offer both on an unrecorded row (PR #226 review). Only the START waits for the
  // record; a target already set aside has answered.
  const unconfirmed = useUnrecordedPick(item.id, recorded);
  const answerable = (recorded || unconfirmed) && item.notNowUntil === undefined;
  return (
    <div className={cn("relative z-[1] flex flex-col gap-2", hasOverlay && "pointer-events-none")}>
      {/* Claim sits on its own line, above the action row. */}
      <ClaimControl
        slug={slug}
        itemId={item.id}
        owner={item.assignee}
        readOnly={approval.approved}
        canTakeOver={item.stage === "backlog"}
      />
      {/* Queue · Approve · Snooze share one line (anton-tc6y); snooze is pushed to the right. Wraps,
          because a picked chip adds both vetoes to that line and a lane column is narrow. */}
      <div className="flex flex-wrap items-center gap-1">
        <ApproveRunAction slug={slug} item={item} budgetAware={budgetAware} approval={approval} />
        {/* The two ways to disagree with the pick (R3.9), on the chip because this surface has no
            row to put them on. Same lock as the Release beside them: one answer per pick. */}
        {cardVeto && answerable && canOfferRun(item, approval.approved, approval.deferred) && (
          <VetoActions
            slug={slug}
            beadId={item.id}
            {...(decision.planId === undefined ? {} : { planId: decision.planId })}
            title={item.title}
            className="pointer-events-auto"
            onVetoed={(untilMs) => cardVeto(item.id, untilMs)}
          />
        )}
        <SnoozeButton
          slug={slug}
          ticketId={item.id}
          deferred={approval.deferred}
          size="icon-xs"
          iconOnly
          className="pointer-events-auto ml-auto shrink-0"
          onChanged={(detail) => approval.setDeferred(detail.deferred)}
        />
      </div>
    </div>
  );
}
