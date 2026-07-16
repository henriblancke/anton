"use client";

import { useState } from "react";
import { toast } from "sonner";
import { GitPullRequestIcon } from "lucide-react";

import type { StandaloneItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { MetaChip, PrLink, RiskChip } from "@/components/atoms";
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
  onOpen,
}: {
  slug: string;
  item: StandaloneItem;
  /** Open this ticket's detail dialog. When omitted the chip is non-interactive (view-only). */
  onOpen?: (ticketId: string) => void;
}) {
  const [approved, setApproved] = useState(item.approved);
  const [running, setRunning] = useState(false);

  async function handleApproveRun() {
    setRunning(true);
    setApproved(true);
    try {
      const res = await fetch(`/api/projects/${slug}/epics/${item.id}/approve`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Approve failed (${res.status})`);
      }
      toast.success(`Approved & running "${item.title}"`);
    } catch (err) {
      setApproved(false);
      toast.error(err instanceof Error ? err.message : "Failed to approve run");
    } finally {
      setRunning(false);
    }
  }

  const showApproveRun = item.stage === "backlog" && !approved;

  return (
    <div
      className={cn(
        "relative flex flex-col gap-2 rounded-[10px] border border-border bg-card/70 p-2.5 text-card-foreground transition-colors hover:border-ring/40",
        TYPE_RAIL[item.type],
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
          <PrLink href={item.prUrl} className="pointer-events-auto">
            <MetaChip tone={item.stage === "done" ? "done" : "pr"}>
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
        {showApproveRun && (
          <Button
            size="xs"
            onClick={handleApproveRun}
            disabled={running}
            className="ml-auto pointer-events-auto"
          >
            {running ? "Starting…" : "Approve & run"}
          </Button>
        )}
      </div>
    </div>
  );
}
