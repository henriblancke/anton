"use client";

import { useState } from "react";
import { toast } from "sonner";

import { toastApprovalOutcome } from "@/components/board/contract-advisory";
import { usePickDecision } from "@/components/board/pick-decision";
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
  /** This target's pick is being answered — or has been — by another control on the same surface. */
  locked: boolean;
  /** `immediate`: true → run now (bypass budget pacing), false → queue for optimal usage. */
  approveRun: (immediate?: boolean) => Promise<void>;
  /** Lock the affordance for an approval another control drove (the picker's `[Release]`). */
  setApproved: () => void;
}

/**
 * The approve POST behind every run-target surface — feature card and standalone chip alike. One
 * copy so the two never drift on what approval does: optimistic lock, the T2 approve route, then
 * the outcome the response reports — the success line included, since only the body knows whether a
 * run actually started.
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
  // Approve and Queue answer the same pick the vetoes beside them decline, so they take the lock
  // `[Release]` takes (PR #212 review) — Queue especially, since it records no accept and so leaves
  // nothing downstream to settle the race: without this it can queue a run on the very target the
  // operator is deferring. Off a picked surface there is no provider and the lock is a no-op.
  const decision = usePickDecision();

  async function approveRun(immediate = true) {
    if (!decision.claim()) return;
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
      decision.settle();
      const applied = await readAppliedSummary(res);
      // The response decides whether a run actually starts, and the run starts with whatever thin
      // sections it has; both are said once, here.
      await toastApprovalOutcome(res, {
        started: approveOutcomeMessage({ applied, immediate, title: target.title }),
        title: target.title,
      });
    } catch (err) {
      // Nothing was approved, so the pick goes back on offer — including to the vetoes.
      decision.abandon();
      setOptimisticApproved(false);
      toast.error(err instanceof Error ? err.message : failureMessage);
    } finally {
      setRunning(false);
    }
  }

  return {
    approved: target.approved || optimisticApproved,
    running,
    locked: decision.state !== "open",
    approveRun,
    setApproved: () => setOptimisticApproved(true),
  };
}
