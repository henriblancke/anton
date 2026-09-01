"use client";

import { Button } from "@/components/ui/button";
import type { ApproveRun } from "@/components/board/use-approve-run";

/**
 * The run affordance itself, shared by the feature card and the standalone chip (anton-y2ue): a
 * budget-aware project offers Queue (paced by the governor) beside Approve (run now), everything
 * else offers one button. Only the wording differs between surfaces, so it is what they pass.
 *
 * Callers decide whether a run may be offered at all and render the contract-blocked affordance
 * instead — this is only the enabled shape.
 */
export function ApproveRunButtons({
  budgetAware,
  approval,
  label,
  busyLabel,
}: {
  budgetAware: boolean;
  approval: ApproveRun;
  /** Idle text on the single (non-budget-aware) button — "Approve", "Approve & run". */
  label: string;
  /** Text while the approve is in flight. */
  busyLabel: string;
}) {
  const { running, approveRun } = approval;

  if (budgetAware) {
    return (
      <span className="pointer-events-auto flex items-center gap-1">
        <Button
          size="xs"
          variant="outline"
          onClick={() => approveRun(false)}
          disabled={running}
          title="Queue this run for the budget governor to pace against the weekly plan"
        >
          Queue
        </Button>
        <Button
          size="xs"
          onClick={() => approveRun(true)}
          disabled={running}
          title="Approve and run now, bypassing budget pacing (the session limit still applies)"
        >
          {running ? "…" : "Approve"}
        </Button>
      </span>
    );
  }

  return (
    <Button size="xs" onClick={() => approveRun()} disabled={running} className="pointer-events-auto">
      {running ? busyLabel : label}
    </Button>
  );
}
