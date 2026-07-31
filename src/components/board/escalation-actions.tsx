"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CircleSlashIcon, RotateCcwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/** How the route describes what it actually did, in the operator's words. */
const ACTION_DETAIL: Record<string, string> = {
  "resumed-job": "Resumed — the parked run picks up where it stopped",
  enqueued: "Re-queued — the runner starts it on the next tick",
  "already-active": "Already running — nothing to restart",
  "job-not-resumable": "Nothing to retry — the job had already moved on",
  abandoned: "Abandoned — the work is closed as won't-do",
  "cancelled-job": "Stopped — the job is cancelled and won't retry",
  "job-already-settled": "Already settled — the job had already stopped",
};

/** Button copy per target: a stall that names only a job is retried/stopped, not abandoned. */
const COPY = {
  work: { resume: "Resume", pendingResume: "Resuming…", abandon: "Abandon", confirm: "Confirm abandon", pendingAbandon: "Abandoning…" },
  job: { resume: "Retry job", pendingResume: "Retrying…", abandon: "Stop retrying", confirm: "Confirm stop", pendingAbandon: "Stopping…" },
} as const;

/**
 * The founder's two answers to an escalation (anton-wvcy): retry it, or call it won't-do.
 *
 * A client leaf inside the server-rendered panel — the only interactive part, so the escalation
 * list itself stays a Server Component. Abandon is deliberately two-step (it closes the bead and
 * cascades to its open children); Resume is one click because it is idempotent — clicking twice
 * re-queues nothing.
 */
export function EscalationActions({
  slug,
  escalationId,
  canResume,
  canAbandon,
  target = "work",
}: {
  slug: string;
  escalationId: string;
  /** False when the finding names no epic to re-enqueue (e.g. a job with an unreadable payload). */
  canResume: boolean;
  /** False when the finding names no bead to close. */
  canAbandon: boolean;
  /** What the buttons act on: the work itself, or (no bead named) the job that stranded it. */
  target?: "work" | "job";
}) {
  const router = useRouter();
  const copy = COPY[target];
  const [pending, setPending] = useState<"resume" | "abandon" | null>(null);
  const [armed, setArmed] = useState(false);

  async function act(action: "resume" | "abandon") {
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
      toast.success(
        ACTION_DETAIL[body?.detail ?? ""] ?? (action === "resume" ? "Resumed" : "Abandoned"),
      );
      // The panel is server-rendered, so a refresh is what removes the settled row.
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to settle the escalation");
      setPending(null);
      setArmed(false);
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
