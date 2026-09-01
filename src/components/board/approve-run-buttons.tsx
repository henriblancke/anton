"use client";

import { Button } from "@/components/ui/button";
import { ReleaseAction } from "@/components/board/release-action";
import type { ApproveRun } from "@/components/board/use-approve-run";

/** The target a `[Release]` starts, and how the surface answers the two outcomes only it can see. */
export interface ReleaseTarget {
  slug: string;
  beadId: string;
  /** The target's title, for the release toast — the operator released a thing, not an id. */
  title: string;
  /** The run is enqueued: lock the surface's own affordances before the next poll. */
  onReleased: () => void;
  /** The approve landed with nothing enqueued: keep this control, because re-approving is the retry. */
  onApprovedWithoutRun: () => void;
}

/**
 * The run affordance itself, shared by the feature card and the standalone chip (anton-y2ue): a
 * budget-aware project offers Queue (paced by the governor) beside the immediate half, everything
 * else offers one button. Only the wording differs between surfaces, so it is what they pass.
 *
 * `release` replaces that immediate half with `[Release]` (anton-d2h6 / R3.5) — same route, same
 * gates, same run, plus the accept that records the operator agreed with anton's pick. One button,
 * never two, so a picked target never offers two answers to "start this".
 *
 * Callers decide whether a run may be offered at all and render the contract-blocked affordance
 * instead — this is only the enabled shape.
 */
export function ApproveRunButtons({
  budgetAware,
  approval,
  label,
  busyLabel,
  release,
}: {
  budgetAware: boolean;
  approval: ApproveRun;
  /** Idle text on the single (non-budget-aware) button — "Approve", "Approve & run". */
  label: string;
  /** Text while the approve is in flight. */
  busyLabel: string;
  /** Set when the board-picker chose this target; absent leaves the plain approve in place. */
  release?: ReleaseTarget;
}) {
  const { running, locked, approveRun } = approval;

  if (!budgetAware && !release) {
    return (
      <Button
        size="xs"
        onClick={() => approveRun()}
        disabled={running || locked}
        className="pointer-events-auto"
      >
        {running ? busyLabel : label}
      </Button>
    );
  }

  return (
    // Release is always the immediate half, so it and Queue never make the same promise twice.
    <span className="pointer-events-auto flex items-center gap-1">
      {budgetAware && (
        <Button
          size="xs"
          variant="outline"
          onClick={() => approveRun(false)}
          disabled={running || locked}
          title="Queue this run for the budget governor to pace against the weekly plan"
        >
          Queue
        </Button>
      )}
      {release ? (
        <ReleaseAction
          slug={release.slug}
          beadId={release.beadId}
          title={release.title}
          disabled={running}
          onReleased={release.onReleased}
          onApprovedWithoutRun={release.onApprovedWithoutRun}
        />
      ) : (
        <Button
          size="xs"
          onClick={() => approveRun(true)}
          disabled={running || locked}
          title="Approve and run now, bypassing budget pacing (the session limit still applies)"
        >
          {running ? "…" : "Approve"}
        </Button>
      )}
    </span>
  );
}
