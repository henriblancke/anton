"use client";

import type { TicketDetail } from "@/lib/types";
import { PrChip, RelativeTime } from "@/components/atoms";
import { ClaimControl, InheritedOwner, StaticOwner } from "@/components/board/claim-control";
import { PrLinkControl } from "@/components/board/pr-link-control";
import { CopyButton } from "@/components/ui/copy-button";
import { isStandaloneRunTarget } from "./ticket-dialog-utils";

/**
 * The dialog's read-only identity block: what this ticket IS (id, type, its PR) and who holds it.
 * Stage + resolution deliberately live in the state bar below, not as header chips — one home for
 * state instead of three.
 */
export function TicketDialogHeader({
  slug,
  detail,
  approved,
  onLinked,
  onClaimChanged,
}: {
  slug: string;
  detail: TicketDetail;
  /** Approved locks the claim control (the claim route 409s past that point). */
  approved: boolean;
  /** A PR link moves the external ref AND the stage, so the dialog refetches. */
  onLinked: () => void;
  onClaimChanged: () => void;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2 pr-8">
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-subtle">
          <CopyButton value={detail.id} label="ticket id">
            {detail.id}
          </CopyButton>
          · {detail.type}
        </span>
        <TicketPr slug={slug} detail={detail} onLinked={onLinked} />
      </div>
      {/* claimed-by + created — mirrors the epic detail + tickets list surfaces */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-subtle">
        <span className="inline-flex items-center gap-1.5">
          Claimed by <TicketOwner slug={slug} detail={detail} approved={approved} onChanged={onClaimChanged} />
        </span>
        <span>
          Created <RelativeTime iso={detail.createdAt} className="text-foreground/85" />
          {detail.createdBy && <> by {detail.createdBy}</>}
        </span>
      </div>
    </div>
  );
}

/**
 * A standalone task/bug carries its own PR — let it be linked/relinked here (same
 * /epics/<id>/pr route the epic detail uses). Linking flips it to in-review. A child ticket ships
 * through its epic's PR, so its ref is shown read-only.
 */
function TicketPr({
  slug,
  detail,
  onLinked,
}: {
  slug: string;
  detail: TicketDetail;
  onLinked: () => void;
}) {
  if (isStandaloneRunTarget(detail)) {
    return (
      <PrLinkControl
        slug={slug}
        itemId={detail.id}
        prRef={detail.prRef}
        prUrl={detail.prUrl}
        onLinked={onLinked}
      />
    );
  }
  if (!detail.prRef) return null;
  return <PrChip href={detail.prUrl}>{detail.prUrl ? "PR" : detail.prRef}</PrChip>;
}

/**
 * Who holds the ticket, in the one form its type allows: a parentless task/bug is a run target and
 * claimable on its own (the same isRunTarget gate the claim route enforces); a child ticket inherits
 * its epic's human claim; a parentless non-run-target (learning/chore/etc.) can't be claimed at all —
 * the claim route 422s it — so its owner shows read-only, matching the hidden Approve & run control.
 */
function TicketOwner({
  slug,
  detail,
  approved,
  onChanged,
}: {
  slug: string;
  detail: TicketDetail;
  approved: boolean;
  onChanged: () => void;
}) {
  if (isStandaloneRunTarget(detail)) {
    return (
      <ClaimControl
        slug={slug}
        itemId={detail.id}
        owner={detail.assignee}
        variant="row"
        readOnly={approved}
        canTakeOver={detail.stage === "backlog"}
        onChanged={onChanged}
      />
    );
  }
  if (detail.epicId) return <InheritedOwner owner={detail.epicAssignee ?? null} />;
  return <StaticOwner owner={detail.assignee} />;
}
