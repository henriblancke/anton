"use client";

import { toast } from "sonner";

import type { Epic } from "@/lib/types";
// The predicate itself, not a card-local copy: approve and the runner ask the same one.
import { contractBlocks } from "@/lib/beads/contract";
import { ConfirmDeleteButton } from "@/components/ui/confirm-delete-button";
import { canStartRun, typeWord } from "@/components/board/board-utils";
import { ClaimControl } from "@/components/board/claim-control";
import { ApproveBlocked } from "@/components/board/contract-mark";
import { ApproveRunButtons } from "@/components/board/approve-run-buttons";
import type { ApproveRun } from "@/components/board/use-approve-run";
import type { EpicCardProps } from "@/components/board/epic-card";

/**
 * The run affordance in its three shapes: inert-and-explaining when the contract blocks the run,
 * the Queue/Approve split when the project is budget-aware, and a single Approve otherwise.
 * Renders nothing once the card may not offer a run.
 *
 * Gates on readiness, not just stage: approving enqueues execute-epic immediately, so a fully
 * blocked epic (nothing it would dispatch can run) must not be startable before its blocker
 * completes. A partially-gated one still is — mirrors the approve route, which gates on the same
 * verdict. A contract gap is the other reason a run can't start; it differs from a blocker in what
 * it asks of the founder — a blocker needs waiting, this needs a one-line edit — so the affordance
 * stays in place and names the missing section instead of disappearing (or 422ing on click).
 */
function ApproveEpicAction({
  epic,
  budgetAware,
  approval,
}: {
  epic: Epic;
  budgetAware: boolean;
  approval: ApproveRun;
}) {
  if (approval.approved || !canStartRun(epic)) return null;

  if (contractBlocks(epic.contract)) {
    return <ApproveBlocked violations={epic.contract?.blocking ?? []} />;
  }

  return (
    <ApproveRunButtons
      budgetAware={budgetAware}
      approval={approval}
      label="Approve"
      busyLabel="Approving…"
    />
  );
}

/** Everything a backlog card can be driven by: the human claim, the run affordance, and delete. */
export function EpicBacklogActions({
  slug,
  epic,
  budgetAware = false,
  approval,
  onDeleted,
}: EpicCardProps & { approval: ApproveRun }) {
  const word = typeWord(epic.type);

  async function handleDelete() {
    const res = await fetch(`/api/projects/${slug}/epics/${epic.id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error ?? `Delete failed (${res.status})`);
      return;
    }
    toast.success(`Deleted "${epic.title}"`);
    onDeleted?.(epic.id);
  }

  return (
    <ClaimControl
      slug={slug}
      itemId={epic.id}
      owner={epic.assignee}
      variant="stack"
      readOnly={approval.approved}
      canTakeOver={epic.stage === "backlog"}
      className="mt-0.5"
    >
      <ApproveEpicAction epic={epic} budgetAware={budgetAware} approval={approval} />
      <ConfirmDeleteButton
        onConfirm={handleDelete}
        iconOnly
        size="xs"
        stopPropagation
        confirmLabel="Delete"
        title={`Delete ${word}`}
        className="pointer-events-auto ml-auto shrink-0"
      />
    </ClaimControl>
  );
}
