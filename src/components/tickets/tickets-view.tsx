"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ListTodoIcon, TriangleAlertIcon } from "lucide-react";

import type { TicketRow } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { STAGE_ACCENT_DOT, STAGE_LABELS, badgeVariant } from "@/components/board/board-utils";
import { TicketsFilters } from "@/components/tickets/tickets-filters";
import { filtersFromSearchParams, ticketsQueryString } from "@/components/tickets/tickets-utils";

export function TicketsView({ slug }: { slug: string }) {
  const searchParams = useSearchParams();
  const filters = filtersFromSearchParams(searchParams);
  const queryString = ticketsQueryString(filters);

  const [tickets, setTickets] = useState<TicketRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setTickets(null);
    setError(null);

    async function load() {
      try {
        const res = await fetch(`/api/projects/${slug}/tickets${queryString}`);
        if (!res.ok) throw new Error(`Failed to load tickets (${res.status})`);
        const data = (await res.json()) as { tickets: TicketRow[] };
        if (!cancelled) setTickets(data.tickets);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load tickets");
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, queryString, attempt]);

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Tickets</h1>
        {tickets && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {tickets.length} ticket{tickets.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <TicketsFilters tickets={tickets ?? []} />

      {error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-destructive/30 p-8 text-center">
          <TriangleAlertIcon className="size-6 text-destructive" aria-hidden="true" />
          <p className="text-sm text-destructive">{error}</p>
          <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      ) : tickets === null ? (
        <TicketsSkeleton />
      ) : tickets.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border/70 px-3 py-16 text-center">
          <ListTodoIcon className="size-5 text-muted-foreground/60" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">No tickets match these filters</p>
        </div>
      ) : (
        <TicketsTable slug={slug} tickets={tickets} />
      )}
    </div>
  );
}

function TicketsTable({ slug, tickets }: { slug: string; tickets: TicketRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border/70 text-left text-xs text-muted-foreground">
            <th scope="col" className="px-3 py-2 font-medium">
              Title
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Epic
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Agent
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Risk
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Size
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Status
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Stage
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/70">
          {tickets.map((ticket) => (
            <tr key={ticket.id} className="transition-colors hover:bg-muted/50">
              <td className="max-w-64 px-3 py-2">
                <span className="block truncate font-medium" title={ticket.title}>
                  {ticket.title}
                </span>
              </td>
              <td className="max-w-40 px-3 py-2">
                {ticket.epicId ? (
                  <Link
                    href={`/projects/${slug}/epics/${ticket.epicId}`}
                    className="block truncate text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    title={ticket.epicTitle ?? ticket.epicId}
                  >
                    {ticket.epicTitle ?? ticket.epicId}
                  </Link>
                ) : (
                  <span className="text-muted-foreground/60">—</span>
                )}
              </td>
              <td className="px-3 py-2">
                {ticket.agent ? <Badge variant="outline">{ticket.agent}</Badge> : <Dash />}
              </td>
              <td className="px-3 py-2">
                {ticket.risk ? (
                  <Badge variant={badgeVariant({ key: "risk", label: `risk:${ticket.risk}` })}>
                    {ticket.risk}
                  </Badge>
                ) : (
                  <Dash />
                )}
              </td>
              <td className="px-3 py-2">
                {ticket.size ? <Badge variant="outline">{ticket.size}</Badge> : <Dash />}
              </td>
              <td className="px-3 py-2 text-muted-foreground">{ticket.status}</td>
              <td className="px-3 py-2">
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <span
                    className={cn("size-1.5 shrink-0 rounded-full", STAGE_ACCENT_DOT[ticket.stage])}
                    aria-hidden="true"
                  />
                  {STAGE_LABELS[ticket.stage]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Dash() {
  return <span className="text-muted-foreground/60">—</span>;
}

function TicketsSkeleton() {
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-border/70 bg-card p-3"
      aria-busy="true"
      aria-label="Loading tickets"
    >
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="h-6 w-full animate-pulse rounded bg-muted/60" />
      ))}
    </div>
  );
}
