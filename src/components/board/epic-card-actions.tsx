"use client";

import { useState } from "react";
import { toast } from "sonner";

import type { Epic } from "@/lib/types";
// The predicate itself, not a card-local copy: approve and the runner ask the same one.
import { contractBlocks } from "@/lib/beads/contract";
import { ConfirmDeleteButton } from "@/components/ui/confirm-delete-button";
import { canStartRun, isPickerPick, typeWord } from "@/components/board/board-utils";
import { ClaimControl } from "@/components/board/claim-control";
import { ApproveBlocked } from "@/components/board/contract-mark";
import { ApproveRunButtons } from "@/components/board/approve-run-buttons";
import { PickAwaitingRecord, usePickDecision } from "@/components/board/pick-decision";
import { VetoActions } from "@/components/board/veto-actions";
import type { ApproveRun } from "@/components/board/use-approve-run";
import type { EpicCardProps } from "@/components/board/epic-card";

/**
 * The run affordance in its shapes: inert-and-explaining when the contract blocks the run,
 * `[Release]` when the board-picker chose this target, the Queue/Approve split when the project is
 * budget-aware, and a single Approve otherwise. Renders nothing once the card may not offer a run —
 * except after a release that approved the target without starting one, where re-approving is the
 * only way back to a run.
 *
 * Gates on readiness, not just stage: approving enqueues execute-epic immediately, so a fully
 * blocked epic (nothing it would dispatch can run) must not be startable before its blocker
 * completes. A partially-gated one still is — mirrors the approve route, which gates on the same
 * verdict. A contract gap is the other reason a run can't start; it differs from a blocker in what
 * it asks of the founder — a blocker needs waiting, this needs a one-line edit — so the affordance
 * stays in place and names the missing section instead of disappearing (or 422ing on click).
 *
 * An UNRECORDED pick withholds the run ahead of either (anton-5axf), because it withholds it for a
 * reason no edit on this card clears: there is no written-down decision to answer. Ranked first,
 * because a contract gap invites a fix that would still not produce a start, and the gap itself is
 * on the card regardless (`ContractChip`).
 */
function ApproveEpicAction({
  slug,
  epic,
  budgetAware,
  approval,
  picked,
  unconfirmed,
}: {
  slug: string;
  epic: Epic;
  budgetAware: boolean;
  approval: ApproveRun;
  /** The picker chose this target and the operator has not set it aside. */
  picked: boolean;
  /** This is anton's pick, and no recorded plan names it — so no start is offered at all. */
  unconfirmed: boolean;
}) {
  // Approved, but the enqueue threw — the target has no run, and the `approved` gate below would
  // take the retry away the moment the board catches up (PR #212 review). Held here rather than
  // inside `[Release]` because it is this gate, not the button, that hides it.
  const [unrun, setUnrun] = useState(false);
  if ((approval.approved && !unrun) || !canStartRun(epic)) return null;

  if (unconfirmed) return <PickAwaitingRecord />;

  if (contractBlocks(epic.contract)) {
    return <ApproveBlocked violations={epic.contract?.blocking ?? []} />;
  }

  return (
    <ApproveRunButtons
      budgetAware={budgetAware}
      approval={approval}
      label="Approve"
      busyLabel="Approving…"
      {...(picked
        ? {
            release: {
              slug,
              beadId: epic.id,
              title: epic.title,
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

/** Everything a backlog card can be driven by: the human claim, the run affordance, and delete. */
export function EpicBacklogActions({
  slug,
  epic,
  budgetAware = false,
  approval,
  onDeleted,
  cardVeto,
}: EpicCardProps & {
  approval: ApproveRun;
  /** Set when this card owns its pick's vetoes; where the hold they place is reported. */
  cardVeto?: (beadId: string, untilMs: number) => void;
}) {
  const word = typeWord(epic.type);
  const decision = usePickDecision();
  // A target the operator set aside keeps its plain Approve: [Release] on a card that reads
  // "set aside · back in 4h" would offer the very start the veto just declined.
  const picked = isPickerPick(epic.provenance) && epic.notNowUntil === undefined;

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
      <ApproveEpicAction
        slug={slug}
        epic={epic}
        budgetAware={budgetAware}
        approval={approval}
        picked={picked}
        unconfirmed={decision.unconfirmed}
      />
      {/* The two ways to disagree with the pick (R3.9), on the card because this surface has no row
          to put them on. Same lock as the Release beside them: one answer per pick. */}
      {cardVeto && picked && (
        <VetoActions
          slug={slug}
          beadId={epic.id}
          {...(decision.planId === undefined ? {} : { planId: decision.planId })}
          title={epic.title}
          className="pointer-events-auto"
          onVetoed={(untilMs) => cardVeto(epic.id, untilMs)}
        />
      )}
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
