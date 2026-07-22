"use client";

import { useState } from "react";
import { toast } from "sonner";
import { GitPullRequestIcon } from "lucide-react";

import type { StandaloneItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { AbandonedChip, BlockedChip, MetaChip, PrLink, RiskChip, SnoozedChip } from "@/components/atoms";
import { SnoozeButton } from "@/components/ticket/snooze-button";
import { ClaimControl } from "@/components/board/claim-control";
import { TYPE_RAIL, TYPE_TEXT, agentDotClass } from "@/components/board/board-utils";
import { TypeBadge, TypeIcon } from "@/components/board/type-language";

/** Short PR label from a bead external-ref: `gh-218` / a URL ending in `/218` → `#218`. */
function prLabel(ref: string): string {
  const m = /(\d+)\s*$/.exec(ref);
  return m ? `#${m[1]}` : ref;
}

/**
 * A standalone (parentless) task/bug — an epic-of-one — rendered as a compact typed chip, not a
 * fake epic card. Carries the shared type language (icon + hue + left rail + badge) and, in the
 * backlog, an "Approve & run" affordance that hits the same T2 approve route an epic uses (the
 * route validates the id is a real run target). A self-filed, still-unread bug shows a marker.
 */
export function StandaloneChip({
  slug,
  item,
  budgetAware = false,
  onOpen,
}: {
  slug: string;
  item: StandaloneItem;
  /**
   * Project budget-aware flag (anton-y2ue): on → the backlog action splits into "Approve" (immediate)
   * and "Queue" (paced for optimal usage); off → a single "Approve & run" button.
   */
  budgetAware?: boolean;
  /** Open this ticket's detail dialog. When omitted the chip is non-interactive (view-only). */
  onOpen?: (ticketId: string) => void;
}) {
  // Optimistic override only — the source of truth is `item.approved`, which a later board poll
  // refreshes. Deriving from the prop (rather than seeding local state once) keeps the button in
  // sync when another operator approves the same item between polls; the flag just hides it
  // immediately on our own click and reverts on failure.
  const [optimisticApproved, setOptimisticApproved] = useState(false);
  const [running, setRunning] = useState(false);
  const approved = item.approved || optimisticApproved;

  // Snooze is two-way, so an optimistic override can't be a one-way flag like `approved`: hold the
  // clicked value until the board's own poll reports it, then drop back to the server truth (which
  // keeps another operator's un-snooze from being masked by our stale override). Reconciled during
  // render — the props-changed reset pattern, not an effect.
  const [optimisticDeferred, setOptimisticDeferred] = useState<boolean | null>(null);
  if (optimisticDeferred !== null && optimisticDeferred === item.deferred) {
    setOptimisticDeferred(null);
  }
  const deferred = optimisticDeferred ?? item.deferred;

  async function handleApproveRun(immediate = true) {
    // `immediate` is the run-directly choice (anton-y2ue): true → run now (bypass budget pacing),
    // false → queue for optimal usage. Defaults true so the single (non-budget-aware) button runs now.
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
      toast.success(
        immediate ? `Approved & running "${item.title}"` : `Queued "${item.title}" for optimal usage`,
      );
    } catch (err) {
      setOptimisticApproved(false);
      toast.error(err instanceof Error ? err.message : "Failed to approve run");
    } finally {
      setRunning(false);
    }
  }

  // Gate on readiness, not just stage: the approve route rejects a still-blocked standalone target
  // with 409, so a chip with open blockers must not offer Approve & run (mirrors the epic card).
  // A snoozed item hides it too — the snooze exists to keep this off the runtime's plate.
  const showApproveRun = item.stage === "backlog" && !approved && item.ready && !deferred;

  return (
    <div
      className={cn(
        "relative flex flex-col gap-2 rounded-[10px] border border-border bg-card/70 p-2.5 text-card-foreground transition-colors hover:border-ring/40",
        TYPE_RAIL[item.type],
        // Dimmed like a blocked card: the runtime won't pick this up as it stands.
        (deferred || item.abandoned) && "opacity-60",
      )}
    >
      {/* Full-bleed trigger — opens the shared TicketDialog. Interactive controls below sit above it
          (z-[1] + pointer-events-auto) so PR links, copy, and Approve & run still work. Mirrors the
          overlay-link pattern the epic card uses to stay a single, valid interactive target. */}
      {onOpen && (
        <button
          type="button"
          onClick={() => onOpen(item.id)}
          aria-label={`Open ${item.type} "${item.title}"`}
          className="absolute inset-0 z-0 rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
      )}
      <div className={cn("relative z-[1] flex items-start gap-1.5", onOpen && "pointer-events-none")}>
        <TypeIcon type={item.type} className="mt-px" />
        {item.unread && (
          <span
            className={cn("mt-1 size-1.5 shrink-0 rounded-full", TYPE_TEXT[item.type], "bg-current")}
            title="Unread — a self-filed bug awaiting triage"
            aria-label="Unread"
          />
        )}
        <h4 className="min-w-0 flex-1 truncate text-[12.5px] leading-snug font-medium" title={item.title}>
          {item.title}
        </h4>
        {item.prRef && (
          <PrLink href={item.prUrl} className={item.prUrl ? "pointer-events-auto" : undefined}>
            {/* An abandoned item is closed (stage `done`) but nothing merged — never green-tint its PR. */}
            <MetaChip tone={item.stage === "done" && !item.abandoned ? "done" : "pr"}>
              <GitPullRequestIcon className="size-2.5" aria-hidden="true" />
              {prLabel(item.prRef)}
            </MetaChip>
          </PrLink>
        )}
        {item.stage === "implementing" && !item.prRef && (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-stage-implementing">
            <span className="size-1.5 rounded-full bg-stage-implementing anton-pulse" aria-hidden="true" />
            working
          </span>
        )}
      </div>

      <div className={cn("relative z-[1] flex flex-wrap items-center gap-1.5", onOpen && "pointer-events-none")}>
        <TypeBadge type={item.type} />
        <CopyButton value={item.id} label="ticket id" className="pointer-events-auto font-mono text-[10px]">
          {item.id}
        </CopyButton>
        {item.agent && <MetaChip dotClass={agentDotClass(item.agent)}>{item.agent}</MetaChip>}
        {item.risk && <RiskChip risk={item.risk} />}
        {item.stage === "backlog" && <BlockedChip blockedBy={item.blockedBy} />}
        {item.abandoned && <AbandonedChip />}
        {deferred && <SnoozedChip />}
        {showApproveRun &&
          (budgetAware ? (
            // Budget-aware: run now or hand the run to the governor's pace-line.
            <span className="ml-auto flex items-center gap-1 pointer-events-auto">
              <Button
                size="xs"
                variant="outline"
                onClick={() => handleApproveRun(false)}
                disabled={running}
                title="Queue this run for the budget governor to pace against the weekly plan"
              >
                Queue
              </Button>
              <Button
                size="xs"
                onClick={() => handleApproveRun(true)}
                disabled={running}
                title="Approve and run now, bypassing budget pacing (the session limit still applies)"
              >
                {running ? "…" : "Approve"}
              </Button>
            </span>
          ) : (
            <Button
              size="xs"
              onClick={() => handleApproveRun()}
              disabled={running}
              className="ml-auto pointer-events-auto"
            >
              {running ? "Starting…" : "Approve & run"}
            </Button>
          ))}
      </div>

      {item.stage === "backlog" && (
        <div className={cn("relative z-[1] flex items-center", onOpen && "pointer-events-none")}>
          <ClaimControl
            slug={slug}
            itemId={item.id}
            owner={item.assignee}
            readOnly={approved}
            canTakeOver={item.stage === "backlog"}
          />
          <SnoozeButton
            slug={slug}
            ticketId={item.id}
            deferred={deferred}
            size="icon-xs"
            iconOnly
            className="pointer-events-auto ml-auto shrink-0"
            onChanged={(detail) => setOptimisticDeferred(detail.deferred)}
          />
        </div>
      )}
    </div>
  );
}
