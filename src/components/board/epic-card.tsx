"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { GitPullRequestIcon } from "lucide-react";

import type { Epic } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { badgeVariant, isExternalUrl, ticketBadges, ticketDotTitle } from "@/components/board/board-utils";

export function EpicCard({
  slug,
  epic,
  overlay = false,
}: {
  slug: string;
  epic: Epic;
  overlay?: boolean;
}) {
  const [approved, setApproved] = useState(epic.approved);
  const [approving, setApproving] = useState(false);

  async function handleApprove() {
    setApproving(true);
    setApproved(true);
    try {
      const res = await fetch(`/api/projects/${slug}/epics/${epic.id}/approve`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Approve failed (${res.status})`);
      }
      toast.success(`Approved "${epic.title}"`);
    } catch (err) {
      setApproved(false);
      toast.error(err instanceof Error ? err.message : "Failed to approve epic");
    } finally {
      setApproving(false);
    }
  }

  const showApprove = epic.stage === "backlog" && !approved;
  const singleTicket = epic.tickets.length === 1 ? epic.tickets[0] : null;
  const multiTickets = epic.tickets.length > 1 ? epic.tickets : [];
  const singleBadges = singleTicket ? ticketBadges(singleTicket) : [];

  return (
    <div
      className={cn(
        "group/card relative flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-3 text-card-foreground shadow-xs transition-all",
        !overlay && "hover:border-border hover:shadow-sm",
        overlay && "rotate-1 shadow-lg ring-1 ring-ring/30",
      )}
    >
      {!overlay && (
        <Link
          href={`/projects/${slug}/epics/${epic.id}`}
          className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="sr-only">Open epic {epic.title}</span>
        </Link>
      )}

      <div className="pointer-events-none relative z-[1] flex flex-col gap-3">
        <div className="flex flex-col gap-1 pr-5">
          <h3 className="truncate text-sm font-medium leading-snug" title={epic.title}>
            {epic.title}
          </h3>
          {epic.goal && (
            <p className="truncate text-xs text-muted-foreground" title={epic.goal}>
              {epic.goal}
            </p>
          )}
        </div>

        {singleBadges.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {singleBadges.map((badge) => (
              <Badge key={badge.key} variant={badgeVariant(badge)}>
                {badge.label}
              </Badge>
            ))}
          </div>
        )}

        {multiTickets.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs tabular-nums text-muted-foreground">
              {multiTickets.length} tickets
            </span>
            <div
              className="flex items-center gap-1"
              role="img"
              aria-label={`${multiTickets.length} tickets, ${multiTickets.filter((t) => t.risk === "high").length} high risk`}
            >
              {multiTickets.slice(0, 8).map((ticket) => (
                <span
                  key={ticket.id}
                  title={ticketDotTitle(ticket)}
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    ticket.risk === "high" ? "bg-destructive" : "bg-muted-foreground/40",
                  )}
                />
              ))}
              {multiTickets.length > 8 && (
                <span className="text-[0.65rem] text-muted-foreground">
                  +{multiTickets.length - 8}
                </span>
              )}
            </div>
          </div>
        )}

        <div className="flex min-h-6 items-center justify-between gap-2">
          {epic.prRef ? (
            isExternalUrl(epic.prRef) ? (
              <a
                href={epic.prRef}
                target="_blank"
                rel="noopener noreferrer"
                className="pointer-events-auto inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Badge variant="outline" className="gap-1">
                  <GitPullRequestIcon aria-hidden="true" />
                  PR
                </Badge>
              </a>
            ) : (
              <Badge variant="outline" className="gap-1">
                <GitPullRequestIcon aria-hidden="true" />
                {epic.prRef}
              </Badge>
            )
          ) : (
            <span aria-hidden="true" />
          )}

          {showApprove && (
            <Button
              size="xs"
              onClick={handleApprove}
              disabled={approving}
              className="pointer-events-auto"
            >
              {approving ? "Approving…" : "Approve"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
