"use client";

import { useId, useState } from "react";
import { toast } from "sonner";
import { CheckIcon, CircleDotIcon, CircleSlashIcon, MoonIcon } from "lucide-react";

import { MAX_ABANDON_REASON_CHARS, STAGES, type Stage, type TicketDetail } from "@/lib/types";
import { cn } from "@/lib/utils";
import { STAGE_ACCENT_DOT, STAGE_LABELS } from "@/components/board/board-utils";
import { Button } from "@/components/ui/button";
import { resolutionOf, type Resolution } from "./ticket-dialog-utils";

/**
 * The unified state control (anton-rtx2) — one bar that replaces the three scattered representations
 * of a ticket's state (the header stage pill, the `deferred` special-case in the Status dropdown, and
 * the footer Snooze/Abandon buttons). It reads as two honest axes:
 *
 *   - lifecycle / stage — derived from the bead, read-only; you watch it move.
 *   - resolution — the human decision: Active → Snoozed → Abandoned (or the terminal Done).
 *
 * Snooze and abandon are the SAME routes the old buttons hit (defer / abandon); only their surface
 * changed. Abandon still arms an inline reason that must be non-empty — the reason IS the confirmation,
 * so it can't be a plain segment click. There is no un-abandon route, so Abandoned is terminal here.
 */
export function TicketStateBar({
  slug,
  ticketId,
  detail,
  onChanged,
}: {
  slug: string;
  ticketId: string;
  detail: TicketDetail;
  /** Hands back the refreshed detail so the dialog can reconcile its own copy + draft. */
  onChanged: (detail: TicketDetail) => void;
}) {
  const [pending, setPending] = useState<null | "snooze" | "abandon">(null);
  const [arming, setArming] = useState(false);
  const [reason, setReason] = useState("");
  const inputId = useId();

  const resolution = resolutionOf(detail);
  // Abandon settles work that hasn't settled — the route 409s an already-closed bead, so it's offered
  // exactly where it can succeed (mirrors the old `canAbandon` gate).
  const canAbandon = detail.stage !== "done" && !detail.abandoned;
  const busy = pending !== null;

  async function toggleSnooze(next: boolean) {
    setPending("snooze");
    try {
      const res = await fetch(`/api/projects/${slug}/tickets/${ticketId}/defer`, {
        method: next ? "POST" : "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `${next ? "Snooze" : "Un-snooze"} failed (${res.status})`);
      }
      const { detail: updated } = (await res.json()) as { detail: TicketDetail };
      onChanged(updated);
      toast.success(next ? "Snoozed — out of the ready queue" : "Un-snoozed — back in the queue");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Snooze failed");
    } finally {
      setPending(null);
    }
  }

  async function confirmAbandon() {
    const why = reason.trim();
    if (!why) return;
    setPending("abandon");
    try {
      const res = await fetch(`/api/projects/${slug}/tickets/${ticketId}/abandon`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: why }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Abandon failed (${res.status})`);
      }
      const data = (await res.json()) as { detail?: TicketDetail };
      setArming(false);
      setReason("");
      toast.success("Abandoned — this ticket won't be done", { description: why });
      if (data.detail) onChanged(data.detail);
    } catch (err) {
      // Stay armed on failure so the typed reason survives a retry.
      toast.error(err instanceof Error ? err.message : "Abandon failed");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-raised/50 px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <StageTrack stage={detail.stage} muted={detail.abandoned} />

        <div className="flex flex-col items-start gap-1.5 sm:items-end">
          <span className="text-[10px] tracking-wide text-subtle uppercase">Resolution</span>
          {resolution === "done" ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-stage-done/30 bg-stage-done/10 px-2.5 py-1 text-xs font-medium text-stage-done">
              <CheckIcon className="size-3" aria-hidden="true" />
              Done
            </span>
          ) : (
            <div className="inline-flex rounded-lg border border-border bg-secondary p-0.5">
              <SegmentButton
                selected={resolution === "active"}
                disabled={detail.abandoned || busy}
                onClick={() => resolution !== "active" && toggleSnooze(false)}
                title="Active — in the ready queue; the runtime can pick it up"
              >
                <CircleDotIcon className="size-3" aria-hidden="true" />
                Active
              </SegmentButton>
              <SegmentButton
                selected={resolution === "snoozed"}
                tone="snooze"
                disabled={detail.abandoned || busy}
                onClick={() => resolution !== "snoozed" && toggleSnooze(true)}
                title="Snoozed — parked out of the ready queue until you restore it"
              >
                <MoonIcon className="size-3" aria-hidden="true" />
                Snoozed
              </SegmentButton>
              <SegmentButton
                selected={detail.abandoned}
                tone="abandon"
                disabled={!canAbandon || busy}
                onClick={() => canAbandon && setArming(true)}
                title={
                  canAbandon
                    ? "Abandon — close as won't-do; keeps its history but nothing ships"
                    : "Already settled — can't abandon"
                }
              >
                <CircleSlashIcon className="size-3" aria-hidden="true" />
                Abandoned
              </SegmentButton>
            </div>
          )}
        </div>
      </div>

      {arming && (
        <div className="flex flex-wrap items-center gap-1.5">
          <label htmlFor={inputId} className="sr-only">
            Reason for abandoning this ticket
          </label>
          <input
            id={inputId}
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void confirmAbandon();
              }
            }}
            maxLength={MAX_ABANDON_REASON_CHARS}
            disabled={pending === "abandon"}
            placeholder="Why is this ticket won't-do?"
            aria-label="Reason for abandoning this ticket"
            className="h-7 flex-1 rounded-lg border border-border bg-card px-2.5 text-xs text-foreground outline-none focus:border-primary/60"
          />
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={confirmAbandon}
            disabled={pending === "abandon" || !reason.trim()}
            title={reason.trim() ? undefined : "A reason is required"}
          >
            <CircleSlashIcon aria-hidden="true" />
            {pending === "abandon" ? "Abandoning…" : "Confirm abandon"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setArming(false);
              setReason("");
            }}
            disabled={pending === "abandon"}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

function SegmentButton({
  selected,
  tone = "active",
  disabled,
  onClick,
  title,
  children,
}: {
  selected: boolean;
  tone?: "active" | "snooze" | "abandon";
  disabled?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  // Selected states carry the resolution's own tone — abandoned reads muted-grey (never done-green),
  // matching AbandonedChip; snoozed reads calm; active takes the raised card highlight.
  const selectedClass =
    tone === "abandon"
      ? "bg-card text-muted-foreground shadow-sm"
      : tone === "snooze"
        ? "bg-card text-foreground shadow-sm"
        : "bg-card text-foreground shadow-sm";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={selected}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-45",
        selected ? selectedClass : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The derived pipeline as a compact four-step track. An abandoned bead derives to `done` (it's
 * closed), so its track is rendered muted — never the green Done fill — because the whole point of
 * the Abandoned resolution is that this work was dropped, not shipped.
 */
function StageTrack({ stage, muted }: { stage: Stage; muted?: boolean }) {
  const currentIndex = STAGES.indexOf(stage);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] tracking-wide text-subtle uppercase">Stage</span>
      <div className="flex items-center gap-1">
        {STAGES.map((s, i) => {
          const filled = !muted && i <= currentIndex;
          return (
            <span
              key={s}
              className={cn(
                "h-1.5 w-7 rounded-full sm:w-9",
                filled ? STAGE_ACCENT_DOT[stage] : "bg-border",
                filled && i === currentIndex && stage === "implementing" && "anton-pulse",
              )}
            />
          );
        })}
      </div>
      <span className="font-mono text-[10px] text-subtle">
        {muted ? "abandoned" : STAGE_LABELS[stage].toLowerCase()}
      </span>
    </div>
  );
}

export type { Resolution };
