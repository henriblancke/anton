"use client";

import type { StandaloneItem } from "@/lib/types";
// The predicate itself, not a chip-local copy: approve and the runner ask the same one.
import { contractBlocks } from "@/lib/beads/contract";
import { cn } from "@/lib/utils";
import { SnoozeButton } from "@/components/ticket/snooze-button";
import { ClaimControl } from "@/components/board/claim-control";
import { ApproveBlocked } from "@/components/board/contract-mark";
import { ApproveRunButtons } from "@/components/board/approve-run-buttons";
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
 * The run affordance in its three shapes: inert-and-explaining when the contract blocks the run,
 * split into Queue/Approve when the project is budget-aware (anton-y2ue), and a single
 * "Approve & run" otherwise. Renders nothing when this chip may not offer a run.
 *
 * A contract gap withholds the run the way an open blocker does, but asks for an edit rather than a
 * wait — so the affordance stays put and names the missing section instead of failing on click
 * (mirrors the card).
 */
export function ApproveRunAction({
  item,
  budgetAware,
  approval,
}: {
  item: StandaloneItem;
  budgetAware: boolean;
  approval: StandaloneApproval;
}) {
  if (!canOfferRun(item, approval.approved, approval.deferred)) return null;

  if (contractBlocks(item.contract)) {
    return <ApproveBlocked violations={item.contract?.blocking ?? []} label="Approve & run" />;
  }

  return (
    <ApproveRunButtons
      budgetAware={budgetAware}
      approval={approval}
      label="Approve & run"
      busyLabel="Starting…"
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
}: {
  slug: string;
  item: StandaloneItem;
  budgetAware: boolean;
  approval: StandaloneApproval;
  /** The chip's full-bleed open trigger sits behind this row; controls opt back into pointers. */
  hasOverlay: boolean;
}) {
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
      {/* Queue · Approve · Snooze share one line (anton-tc6y); snooze is pushed to the right. */}
      <div className="flex items-center gap-1">
        <ApproveRunAction item={item} budgetAware={budgetAware} approval={approval} />
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
