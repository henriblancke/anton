"use client";

import { useState } from "react";

import type { StandaloneItem } from "@/lib/types";
import { useApproveRun, type ApproveRun } from "@/components/board/use-approve-run";

/** Everything a standalone chip needs to show and drive approval — the chip renders, this decides. */
export interface StandaloneApproval extends ApproveRun {
  /** Snoozed as far as this surface knows — our clicked value until the board's poll catches up. */
  deferred: boolean;
  /** Record a snooze toggle's result until the board's own poll reports it. */
  setDeferred: (deferred: boolean) => void;
}

/**
 * The approval/snooze state machine behind a standalone chip. Approval is the shared one every run
 * target uses (useApproveRun); snooze is the part only a chip has.
 *
 * Both overrides are optimistic only — `item` stays the source of truth, refreshed by a later board
 * poll. Snooze is two-way, so its override holds the clicked value only until the server agrees,
 * then yields — otherwise a stale override would mask someone else's un-snooze.
 */
export function useStandaloneApproval(slug: string, item: StandaloneItem): StandaloneApproval {
  const approval = useApproveRun({ slug, target: item, failureMessage: "Failed to approve run" });
  const [optimisticDeferred, setOptimisticDeferred] = useState<boolean | null>(null);

  // Reconciled during render — the props-changed reset pattern, not an effect.
  if (optimisticDeferred !== null && optimisticDeferred === item.deferred) {
    setOptimisticDeferred(null);
  }

  return {
    ...approval,
    deferred: optimisticDeferred ?? item.deferred,
    setDeferred: setOptimisticDeferred,
  };
}
