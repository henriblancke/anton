"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CircleSlashIcon, RotateCcwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/** How the resume route describes what it actually did, in the operator's words. */
const RESUME_DETAIL: Record<string, string> = {
  "resumed-job": "Resumed — the parked run picks up where it stopped",
  enqueued: "Re-queued — the runner starts it on the next tick",
  "already-active": "Already running — nothing to restart",
};

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
}: {
  slug: string;
  escalationId: string;
  /** False when the finding names no epic to re-enqueue (e.g. a job with an unreadable payload). */
  canResume: boolean;
  /** False when the finding names no bead to close. */
  canAbandon: boolean;
}) {
  const router = useRouter();
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
        action === "resume"
          ? (RESUME_DETAIL[body?.detail ?? ""] ?? "Resumed")
          : "Abandoned — the work is closed as won't-do",
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
          {pending === "resume" ? "Resuming…" : "Resume"}
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
            {pending === "abandon" ? "Abandoning…" : "Confirm abandon"}
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
          Abandon
        </Button>
      ) : null}
    </div>
  );
}
