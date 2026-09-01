"use client";

import { useState } from "react";
import { toast } from "sonner";

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

/** The run target an approve acts on, as any surface knows it. */
export interface ApprovableTarget {
  id: string;
  title: string;
  approved: boolean;
}

/** Everything a surface needs to show and drive approval — the surface renders, this decides. */
export interface ApproveRun {
  /** Approved as far as this surface knows — server truth OR our own un-reconciled click. */
  approved: boolean;
  /** An approve is in flight; the affordance disables rather than double-firing. */
  running: boolean;
  /** `immediate`: true → run now (bypass budget pacing), false → queue for optimal usage. */
  approveRun: (immediate?: boolean) => Promise<void>;
}

/**
 * The approve POST behind every run-target surface — feature card and standalone chip alike. One
 * copy so the two never drift on what approval does: optimistic lock, the T2 approve route, the
 * outcome toast, then the advisory gaps the route reported.
 *
 * The override is optimistic only — `target` stays the source of truth, refreshed by a later board
 * poll. Approval is one-way (a surface never un-approves itself), so a plain flag that hides the
 * button on click and reverts on failure suffices; deriving `approved` from the prop each render
 * keeps another operator's approval visible between polls.
 */
export function useApproveRun({
  slug,
  target,
  failureMessage,
}: {
  slug: string;
  target: ApprovableTarget;
  /** Toast text when the approve fails and the route named no reason of its own. */
  failureMessage: string;
}): ApproveRun {
  const [optimisticApproved, setOptimisticApproved] = useState(false);
  const [running, setRunning] = useState(false);

  async function approveRun(immediate = true) {
    setRunning(true);
    setOptimisticApproved(true);
    try {
      const res = await fetch(`/api/projects/${slug}/epics/${target.id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ immediate }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Approve failed (${res.status})`);
      }
      const applied = await readAppliedSummary(res);
      toast.success(approveOutcomeMessage({ applied, immediate, title: target.title }));
      // The run starts with whatever thin sections it has; say so once, here.
      await toastContractAdvisory(res);
    } catch (err) {
      setOptimisticApproved(false);
      toast.error(err instanceof Error ? err.message : failureMessage);
    } finally {
      setRunning(false);
    }
  }

  return { approved: target.approved || optimisticApproved, running, approveRun };
}
