"use client";

import { useId, useState } from "react";
import { toast } from "sonner";
import { CircleSlashIcon } from "lucide-react";

import { MAX_ABANDON_REASON_CHARS, type TicketDetail } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/** What the abandon settled — a ticket hands back its refreshed detail, an epic the ids it cascaded to. */
export type AbandonResult =
  | { kind: "ticket"; detail: TicketDetail }
  | { kind: "epic"; epicId: string; children: string[] };

export interface AbandonButtonProps {
  slug: string;
  /** The bead to abandon — a ticket id, or an epic id when `kind` is "epic". */
  targetId: string;
  /** Which abandon route to call; an epic's cascades to its still-open children. */
  kind: "ticket" | "epic";
  size?: React.ComponentProps<typeof Button>["size"];
  className?: string;
  onAbandoned?: (result: AbandonResult) => void;
}

/**
 * The abandon action (anton-a5vc) — one control shared by the ticket dialog and the epic detail so
 * both speak the same language. Abandoning is a decision, not a slip: the button arms into an
 * inline form that will not submit without a reason, because the reason is the durable record of
 * why this work was dropped (the route rejects an empty one anyway).
 *
 * Deliberately not the two-step of ConfirmDeleteButton with a native prompt bolted on: the reason
 * IS the confirmation — you cannot type one by accident.
 */
export function AbandonButton({
  slug,
  targetId,
  kind,
  size = "sm",
  className,
  onAbandoned,
}: AbandonButtonProps) {
  const [armed, setArmed] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const inputId = useId();
  const what = kind === "epic" ? "epic" : "ticket";

  async function confirm() {
    const why = reason.trim();
    if (!why) return;
    setPending(true);
    try {
      const path = kind === "epic" ? "epics" : "tickets";
      const res = await fetch(`/api/projects/${slug}/${path}/${targetId}/abandon`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: why }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Abandon failed (${res.status})`);
      }
      const data = (await res.json()) as {
        detail?: TicketDetail;
        abandoned?: { epicId: string; children: string[] };
      };
      setArmed(false);
      setReason("");
      toast.success(`Abandoned — this ${what} won't be done`, { description: why });
      if (kind === "epic" && data.abandoned) {
        onAbandoned?.({ kind: "epic", ...data.abandoned });
      } else if (data.detail) {
        onAbandoned?.({ kind: "ticket", detail: data.detail });
      }
    } catch (err) {
      // Stay armed on failure so the typed reason survives a retry.
      toast.error(err instanceof Error ? err.message : "Abandon failed");
    } finally {
      setPending(false);
    }
  }

  if (!armed) {
    return (
      <Button
        type="button"
        variant="outline"
        size={size}
        onClick={() => setArmed(true)}
        className={className}
        title={
          kind === "epic"
            ? "Close this epic as won't-do — its open tickets go with it, and any run is stopped"
            : "Close this ticket as won't-do — it keeps its history, but nothing will ship for it"
        }
      >
        <CircleSlashIcon aria-hidden="true" />
        Abandon
      </Button>
    );
  }

  return (
    <span className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <label htmlFor={inputId} className="sr-only">
        Reason for abandoning this {what}
      </label>
      <input
        id={inputId}
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void confirm();
          }
        }}
        maxLength={MAX_ABANDON_REASON_CHARS}
        disabled={pending}
        placeholder={`Why is this ${what} won't-do?`}
        aria-label={`Reason for abandoning this ${what}`}
        className="h-7 w-52 rounded-lg border border-border bg-card px-2.5 text-xs text-foreground outline-none focus:border-primary/60"
      />
      <Button
        type="button"
        variant="destructive"
        size={size}
        onClick={confirm}
        disabled={pending || !reason.trim()}
        title={reason.trim() ? undefined : "A reason is required"}
      >
        <CircleSlashIcon aria-hidden="true" />
        {pending ? "Abandoning…" : "Confirm abandon"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size={size}
        onClick={() => {
          setArmed(false);
          setReason("");
        }}
        disabled={pending}
      >
        Cancel
      </Button>
    </span>
  );
}
