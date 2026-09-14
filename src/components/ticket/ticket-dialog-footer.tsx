"use client";

import { contractBlocks } from "@/lib/beads/contract";
import type { TicketDetail } from "@/lib/types";
import { ApproveBlocked } from "@/components/board/contract-mark";
import { Button } from "@/components/ui/button";
import { ConfirmDeleteButton } from "@/components/ui/confirm-delete-button";
import { DialogFooter } from "@/components/ui/dialog";
import { canRunTicket } from "./ticket-dialog-utils";

/**
 * The dialog's action bar, pinned to the modal's bottom edge while the body scrolls under it:
 * `sticky bottom-0` against the DialogContent scrollport (whose bottom padding is removed there, so
 * bottom-0 sits flush). `mb-0` cancels the base `-mb-4` — that negative margin + sticky was the
 * source of the earlier mis-render; `-mx-4` (base) keeps the bar full-bleed. `bg-muted` (opaque,
 * over base bg-muted/50) hides the scrolling content; z-10 keeps it above.
 *
 * Snooze + abandon live in the state bar above; delete is the rare, destructive exit, so it's
 * demoted to an icon on the far left, out of the edit/run flow (anton-q02q).
 */
export function TicketDialogFooter({
  detail,
  approved,
  running,
  saving,
  changed,
  onRun,
  onReset,
  onSave,
  onDelete,
}: {
  detail: TicketDetail;
  approved: boolean;
  running: boolean;
  saving: boolean;
  /** Whether the draft has anything to PATCH — Save and Reset are dead without it. */
  changed: boolean;
  onRun: () => void;
  onReset: () => void;
  onSave: () => void;
  /** Awaited by the inline confirm, which shows its own pending label while the delete runs. */
  onDelete: () => Promise<void>;
}) {
  const editsLocked = saving || !changed;
  return (
    <DialogFooter className="sticky bottom-0 z-10 mb-0 bg-muted sm:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        <ConfirmDeleteButton onConfirm={onDelete} iconOnly title="Delete ticket" />
      </div>
      <div className="flex gap-2">
        <RunAction detail={detail} approved={approved} running={running} onRun={onRun} />
        <Button variant="ghost" size="sm" onClick={onReset} disabled={editsLocked}>
          Reset
        </Button>
        <Button size="sm" onClick={onSave} disabled={editsLocked}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </DialogFooter>
  );
}

/**
 * Approval as the run trigger for a standalone task/bug — the same T2 route an epic uses. Re-approving
 * an already-approved target re-triggers the run (Force run), resuming from where it stopped. A
 * blocking contract gap withholds the run the same way the board chip does: the approve route would
 * 422 the click, so the affordance names the missing section instead of failing on it.
 */
function RunAction({
  detail,
  approved,
  running,
  onRun,
}: {
  detail: TicketDetail;
  approved: boolean;
  running: boolean;
  onRun: () => void;
}) {
  if (!canRunTicket(detail)) return null;
  const label = approved ? "Force run" : "Approve & run";

  if (contractBlocks(detail.contract)) {
    return <ApproveBlocked violations={detail.contract?.blocking ?? []} label={label} size="sm" />;
  }
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onRun}
      disabled={running}
      title={
        approved
          ? "Re-trigger the run (resumes from where it stopped)"
          : "Approve and start the run"
      }
    >
      {running ? "Starting…" : label}
    </Button>
  );
}
