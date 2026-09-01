"use client";

import { useState } from "react";
import { toast } from "sonner";

import type { StandaloneItem } from "@/lib/types";
import { toastContractAdvisory } from "@/components/board/contract-advisory";
import { readAppliedSummary } from "@/components/board/proposal-applied";

/**
 * What an accepted approve is reported as. A gardener PROPOSAL is applied, not run (anton-1t3n), so
 * its board move is announced instead of a run that never started; otherwise the wording follows the
 * run-directly choice (anton-y2ue).
 */
export function approveOutcomeMessage({
  applied,
  immediate,
  title,
}: {
  applied?: string;
  immediate: boolean;
  title: string;
}): string {
  if (applied) return `Applied — ${applied}`;
  return immediate ? `Approved & running "${title}"` : `Queued "${title}" for optimal usage`;
}

/** Everything a standalone chip needs to show and drive approval — the chip renders, this decides. */
export interface StandaloneApproval {
  /** Approved as far as this surface knows — server truth OR our own un-reconciled click. */
  approved: boolean;
  /** Snoozed as far as this surface knows — our clicked value until the board's poll catches up. */
  deferred: boolean;
  /** An approve is in flight; the affordance disables rather than double-firing. */
  running: boolean;
  /** `immediate`: true → run now (bypass budget pacing), false → queue for optimal usage. */
  approveRun: (immediate?: boolean) => Promise<void>;
  /** Lock the chip's run affordance for an approval another control drove (the picker's [Release]). */
  setApproved: () => void;
  /** Record a snooze toggle's result until the board's own poll reports it. */
  setDeferred: (deferred: boolean) => void;
}

/**
 * The approval/snooze state machine behind a standalone chip.
 *
 * Both overrides are optimistic only — `item` stays the source of truth, refreshed by a later board
 * poll. Approval is one-way (a chip never un-approves itself), so a plain flag that hides the button
 * on click and reverts on failure suffices; deriving `approved` from the prop each render keeps
 * another operator's approval visible between polls. Snooze is two-way, so its override holds the
 * clicked value only until the server agrees, then yields — otherwise a stale override would mask
 * someone else's un-snooze.
 */
export function useStandaloneApproval(slug: string, item: StandaloneItem): StandaloneApproval {
  const [optimisticApproved, setOptimisticApproved] = useState(false);
  const [running, setRunning] = useState(false);
  const [optimisticDeferred, setOptimisticDeferred] = useState<boolean | null>(null);

  // Reconciled during render — the props-changed reset pattern, not an effect.
  if (optimisticDeferred !== null && optimisticDeferred === item.deferred) {
    setOptimisticDeferred(null);
  }

  async function approveRun(immediate = true) {
    setRunning(true);
    setOptimisticApproved(true);
    try {
      const res = await fetch(`/api/projects/${slug}/epics/${item.id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ immediate }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Approve failed (${res.status})`);
      }
      const applied = await readAppliedSummary(res);
      toast.success(approveOutcomeMessage({ applied, immediate, title: item.title }));
      // The run starts with whatever thin sections it has; say so once, here.
      await toastContractAdvisory(res);
    } catch (err) {
      setOptimisticApproved(false);
      toast.error(err instanceof Error ? err.message : "Failed to approve run");
    } finally {
      setRunning(false);
    }
  }

  return {
    approved: item.approved || optimisticApproved,
    deferred: optimisticDeferred ?? item.deferred,
    running,
    approveRun,
    setApproved: () => setOptimisticApproved(true),
    setDeferred: setOptimisticDeferred,
  };
}
