"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { reportApprovalOutcome } from "@/components/board/contract-advisory";
import { usePickDecision } from "@/components/board/pick-decision";
import type { ApprovalRunOutcome } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * `[Release]` — start the one target anton picked (anton-d2h6 / R3.5).
 *
 * This is shadow mode's whole payoff: the operator gets the ranked pick and one click to run it,
 * which is most of autopilot's value at none of its risk. Nothing here starts anything by itself,
 * and it releases exactly one target — there is no bulk release, by design.
 *
 * It posts to the APPROVE route with `{ release: true }`, and that is load-bearing. Approve already
 * holds the contract gate, the structure gate, the blocker check, the auto-claim and the steal
 * semantics; a second endpoint that "just starts it" would be a second answer to "may this run", and
 * the two would drift. The flag adds only what release means beyond approve: the target was anton's
 * pick, so the choice is recorded as an accept the arming decision can read.
 *
 * A 200 IS NOT A RUN, either: approve enqueues best-effort and reports what it did, so the button
 * believes the response's `run` outcome rather than its status code — "running now" against an
 * enqueue that failed is a false success the operator would only discover by waiting for a card that
 * never moves. A MISSING JOB ID IS NOT A FAILURE, though: `elsewhere` means the shared board already
 * shows a live run for this target on another machine, so nothing was enqueued here because nothing
 * needed to be. Telling the operator to retry that is telling them to double-run it.
 *
 * A LOST CLAIM RACE is the failure this control is shaped around. Between the render and the click a
 * teammate can claim the target or its run can start, and approve answers 409 — so the refusal is
 * printed on the card next to the button (never only as a toast that scrolls away) AND the surface is
 * re-read, because our copy of the board is now provably behind.
 *
 * A leaf, and deliberately the smallest one: the card around it is server-rendered, and only this
 * button needs to be interactive.
 */
export function ReleaseAction({
  slug,
  beadId,
  title,
  disabled = false,
  className,
  onReleased,
  onApprovedWithoutRun,
}: {
  slug: string;
  beadId: string;
  /** The target's title, for the success toast — the operator released a thing, not an id. */
  title: string;
  /** Another control on the same card is mid-flight; releasing now would race our own surface. */
  disabled?: boolean;
  className?: string;
  /** Fired once the run is enqueued, so the card can lock its own affordances before the next poll. */
  onReleased?: () => void;
  /**
   * The approve landed but nothing was enqueued. The surface must KEEP this control: its usual
   * `!approved` gate is about to close on a target that is approved with no run, and re-approving is
   * the retry the failure copy asks for (PR #212 review).
   */
  onApprovedWithoutRun?: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  // Accepting the pick and declining it are one decision, and on a ranked card the veto beside this
  // button is the other half of it. The lock keeps them exclusive: a release that cannot claim the
  // pick never starts a run the operator has already deferred (PR #212 review). It also names the
  // plan generation this card was drawn from — the decision this release answers.
  const decision = usePickDecision();

  async function release() {
    if (!decision.claim()) return;
    setPending(true);
    setFailure(undefined);
    try {
      const res = await fetch(`/api/projects/${slug}/epics/${beadId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // `immediate` is what "release" promises — the operator asked for this run NOW, so it is
        // never handed to the budget governor's pace-line. `planId` names the generation on screen,
        // so the accept is recorded against the pick the operator actually saw.
        body: JSON.stringify({
          release: true,
          immediate: true,
          ...(decision.planId === undefined ? {} : { planId: decision.planId }),
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        jobId?: string;
        run?: ApprovalRunOutcome;
      } | null;
      if (!res.ok) {
        // Nothing was approved, so the pick is answerable again — by this button or by the veto.
        decision.abandon();
        const message = body?.error ?? `Release failed (${res.status})`;
        setFailure(message);
        toast.error(message);
        // 409 is the claim race: someone else holds the target, or its run already started. That is
        // the one refusal that proves this surface is stale, so re-read rather than leave the lane
        // offering a pick it can no longer start.
        if (res.status === 409) router.refresh();
        return;
      }
      // Already running on another machine (anton-jz1): approve deliberately enqueued nothing,
      // because a live run there already covers this target. That is a lane that is stale, not a
      // release that failed — so the approve stands, the accept is recorded, and this reconciles the
      // board instead of pushing the operator to release again into a second concurrent run.
      if (body?.run === "elsewhere") {
        decision.settle();
        onReleased?.();
        toast.success(`"${title}" is already running on another machine`, {
          description: "Nothing new was started — the board is catching up.",
        });
        router.refresh();
        return;
      }
      // A 200 is not yet a run. Approve enqueues BEST-EFFORT — it will not fail an approval it has
      // already written over a runner hiccup — so it answers 200 with `jobId` omitted when the
      // enqueue threw. Absent both a job id and a covering run, "running now" leaves the operator
      // watching a card that will never move (the route withholds the release accept on the same
      // test). The approval stands, so releasing again enqueues afresh.
      if (!body?.jobId) {
        // The approval stands but nothing runs, and the copy says to release again — so the pick
        // stays claimable rather than settling on an answer that started no work.
        decision.abandon();
        const message = "Approved, but no run started — release again to retry";
        setFailure(message);
        toast.error(message);
        // …and the surface is told to KEEP offering it. The approve landed, so the refresh below
        // adopts a board where this target is approved, and every gate that draws this control hides
        // it on exactly that (PR #212 review) — leaving the operator an approved target with no run
        // and no way to start one. Approve re-enqueues for an already-approved target, so the button
        // the copy points at has to survive the refresh that follows.
        onApprovedWithoutRun?.();
        // The approve landed, so this surface is behind on the card regardless of the enqueue.
        router.refresh();
        return;
      }
      decision.settle();
      onReleased?.();
      // The response decides whether a run actually starts, and the run starts with whatever thin
      // sections it has; both are said once, here.
      reportApprovalOutcome(body, { started: `Released "${title}" — running now`, title });
      router.refresh();
    } catch (err) {
      decision.abandon();
      const message = err instanceof Error ? err.message : "Failed to release this target";
      setFailure(message);
      toast.error(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <span className={cn("pointer-events-auto flex items-center gap-1.5", className)}>
      <Button
        type="button"
        size="xs"
        disabled={pending || disabled || decision.state !== "open"}
        title="Start this target now — the same approve, claim and run every approval performs"
        onClick={() => void release()}
      >
        {pending ? "Releasing…" : "Release"}
      </Button>
      {/* Inline, truncated, and never cleared by a poll: a release that did not start must not read
          as started. Mirrors the kill control's own refusal copy. */}
      {failure && (
        <span
          role="alert"
          title={failure}
          className="max-w-44 truncate font-mono text-[10px] text-risk-high"
        >
          {failure}
        </span>
      )}
    </span>
  );
}
