"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckIcon, CircleSlashIcon, RotateCcwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/** How the route describes what it actually did, in the operator's words. */
const ACTION_DETAIL: Record<string, string> = {
  "resumed-job": "Resumed — the parked run picks up where it stopped",
  enqueued: "Re-queued — the runner starts it on the next tick",
  "already-active": "Already running — nothing to restart",
  "job-cancelled": "Not resumed — this job was cancelled, and a cancel is never undone",
  "job-not-resumable": "Nothing to retry — the job had already moved on",
  abandoned: "Abandoned — the work is closed as won't-do",
  "cancelled-job": "Stopped — the job is cancelled and won't retry",
  "job-already-settled": "Already settled — the job had already stopped",
  "job-restarted": "Not stopped — the job is running again, so it was left alone",
  dismissed: "Dismissed — anton raises it again if it's still stuck at the next sweep",
  "target-gone": "Nothing to act on — this work was deleted from the board, so the alert is cleared",
};

/** Button copy per target: a stall that names only a job is retried/stopped, not abandoned. */
const COPY = {
  work: { resume: "Resume", pendingResume: "Resuming…", abandon: "Abandon", confirm: "Confirm abandon", pendingAbandon: "Abandoning…" },
  job: { resume: "Retry job", pendingResume: "Retrying…", abandon: "Stop retrying", confirm: "Confirm stop", pendingAbandon: "Stopping…" },
} as const;

type Action = "resume" | "abandon" | "dismiss";

/** Said plainly when the route reports a detail this build doesn't have copy for. */
const FALLBACK_DETAIL: Record<Action, string> = {
  resume: "Resumed",
  abandon: "Abandoned",
  dismiss: "Dismissed",
};

/**
 * The founder's answers to an escalation (anton-wvcy): retry it, call it won't-do, or acknowledge
 * one anton has no verb for (a stale PR — see escalation-actions.ts).
 *
 * A client leaf inside the server-rendered panel — the only interactive part, so the escalation
 * list itself stays a Server Component. Abandon is deliberately two-step (it closes the bead and
 * cascades to its open children); Resume and Dismiss are one click because they are idempotent —
 * clicking twice re-queues nothing and the second settle is refused.
 */
export function EscalationActions({
  slug,
  escalationId,
  canResume,
  canAbandon,
  canDismiss = false,
  target = "work",
}: {
  slug: string;
  escalationId: string;
  /** False when the finding names no epic to re-enqueue (e.g. a job with an unreadable payload). */
  canResume: boolean;
  /** False when the finding names no bead to close. */
  canAbandon: boolean;
  /**
   * Offer "Dismiss" — settle the row without touching the work. Shown where a resume would be
   * theatre (a stale PR is waiting on a reviewer, not on anton), so the panel never advertises a
   * resolution that resolves nothing.
   */
  canDismiss?: boolean;
  /** What the buttons act on: the work itself, or (no bead named) the job that stranded it. */
  target?: "work" | "job";
}) {
  const router = useRouter();
  const copy = COPY[target];
  const [pending, setPending] = useState<Action | null>(null);
  const [armed, setArmed] = useState(false);

  async function act(action: Action) {
    setPending(action);
    try {
      const res = await fetch(`/api/projects/${slug}/escalations/${escalationId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; detail?: string }
        | null;
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      toast.success(ACTION_DETAIL[body?.detail ?? ""] ?? FALLBACK_DETAIL[action]);
      // The panel is server-rendered, so a refresh is what removes the settled row.
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to settle the escalation");
      setPending(null);
      setArmed(false);
      // The settle and the action are separate steps server-side, so a failure can still have left
      // the row resolved. Refresh either way — a stale row here errors on every subsequent click.
      router.refresh();
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {canResume ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={pending !== null}
          onClick={() => void act("resume")}
        >
          <RotateCcwIcon aria-hidden="true" />
          {pending === "resume" ? copy.pendingResume : copy.resume}
        </Button>
      ) : null}
      {canDismiss ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={pending !== null}
          title="Settle this alert without changing the work — anton raises it again if it's still stuck at the next sweep"
          onClick={() => void act("dismiss")}
        >
          <CheckIcon aria-hidden="true" />
          {pending === "dismiss" ? "Dismissing…" : "Dismiss"}
        </Button>
      ) : null}
      {canAbandon && armed ? (
        <>
          <Button
            type="button"
            size="xs"
            variant="destructive"
            disabled={pending !== null}
            onClick={() => void act("abandon")}
          >
            <CircleSlashIcon aria-hidden="true" />
            {pending === "abandon" ? copy.pendingAbandon : copy.confirm}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={pending !== null}
            onClick={() => setArmed(false)}
          >
            Cancel
          </Button>
        </>
      ) : null}
      {canAbandon && !armed ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={pending !== null}
          onClick={() => setArmed(true)}
        >
          <CircleSlashIcon aria-hidden="true" />
          {copy.abandon}
        </Button>
      ) : null}
    </div>
  );
}
