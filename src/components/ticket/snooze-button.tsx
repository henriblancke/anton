"use client";

import { useState } from "react";
import { toast } from "sonner";
import { AlarmClockIcon, MoonIcon } from "lucide-react";

import type { TicketDetail } from "@/lib/types";
import { Button } from "@/components/ui/button";

/**
 * The snooze toggle (anton-ywi8) — one control shared by the ticket dialog and the board card, so
 * both hit the same defer route and speak the same language. Snoozing parks a ticket out of the
 * ready queue (the runtime stops seeing it) without abandoning it; un-snoozing restores it.
 *
 * The caller owns the state: `deferred` comes from its own view model and `onChanged` hands back
 * the refreshed detail, so an optimistic surface (board card) and a truth-carrying one (dialog)
 * can each reconcile the way that suits it.
 */
export function SnoozeButton({
  slug,
  ticketId,
  deferred,
  size = "sm",
  iconOnly = false,
  className,
  onChanged,
}: {
  slug: string;
  ticketId: string;
  deferred: boolean;
  size?: "xs" | "sm" | "icon-xs";
  /** Render just the icon (tight surfaces like the board chip); the label rides in the tooltip. */
  iconOnly?: boolean;
  className?: string;
  onChanged?: (detail: TicketDetail) => void;
}) {
  const [pending, setPending] = useState(false);
  const label = deferred ? "Un-snooze" : "Snooze";
  const Icon = deferred ? AlarmClockIcon : MoonIcon;

  async function toggle(event: React.MouseEvent) {
    // The board chip sits under a full-bleed open-dialog trigger — never let the toggle open it.
    event.stopPropagation();
    setPending(true);
    try {
      const res = await fetch(`/api/projects/${slug}/tickets/${ticketId}/defer`, {
        method: deferred ? "DELETE" : "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `${label} failed (${res.status})`);
      }
      const { detail } = (await res.json()) as { detail: TicketDetail };
      onChanged?.(detail);
      toast.success(deferred ? "Un-snoozed — back in the queue" : "Snoozed — out of the ready queue");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      onClick={toggle}
      disabled={pending}
      aria-label={label}
      title={
        deferred
          ? "Restore this ticket to the ready queue"
          : "Park this ticket out of the ready queue — it keeps everything, the runtime just stops picking it up"
      }
      className={className}
    >
      <Icon className="size-3" aria-hidden="true" />
      {!iconOnly && <span>{pending ? `${label}…` : label}</span>}
    </Button>
  );
}
