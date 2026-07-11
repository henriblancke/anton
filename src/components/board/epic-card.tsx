"use client";

import { useState } from "react";
import { toast } from "sonner";

import type { Epic } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { isExternalUrl, ticketBadges } from "@/components/board/board-utils";

export function EpicCard({ slug, epic }: { slug: string; epic: Epic }) {
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>{epic.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {epic.goal && (
          <div>
            <p className="text-xs font-medium text-muted-foreground">Goal</p>
            <p className="text-sm">{epic.goal}</p>
          </div>
        )}

        {epic.acceptance && (
          <details className="group/acceptance">
            <summary className="cursor-pointer rounded text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
              Acceptance
            </summary>
            <p className="mt-1 text-sm whitespace-pre-line">{epic.acceptance}</p>
          </details>
        )}

        {epic.prRef && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="font-medium">PR</span>
            {isExternalUrl(epic.prRef) ? (
              <a
                href={epic.prRef}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded"
              >
                {epic.prRef}
              </a>
            ) : (
              <span>{epic.prRef}</span>
            )}
          </div>
        )}

        {epic.tickets.length > 0 && (
          <>
            <Separator />
            <ul className="flex flex-col gap-2">
              {epic.tickets.map((ticket) => {
                const badges = ticketBadges(ticket);
                return (
                  <li key={ticket.id} className="flex flex-col gap-1 rounded-lg bg-muted/40 p-2">
                    <span className="text-sm">{ticket.title}</span>
                    {badges.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {badges.map((badge) => (
                          <Badge key={badge.key} variant="outline">
                            {badge.label}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </CardContent>

      {showApprove && (
        <CardFooter>
          <Button size="sm" onClick={handleApprove} disabled={approving}>
            {approving ? "Approving…" : "Approve"}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
