"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckIcon, ListTodoIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";

import type { Stage, TicketRow } from "@/lib/types";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { agentDotClass } from "@/components/board/board-utils";
import { TicketsFilters } from "@/components/tickets/tickets-filters";
import {
  countActiveFilters,
  filtersFromSearchParams,
  ticketsQueryString,
} from "@/components/tickets/tickets-utils";

export function TicketsView({ slug }: { slug: string }) {
  const searchParams = useSearchParams();
  const filters = filtersFromSearchParams(searchParams);
  const queryString = ticketsQueryString(filters);
  const activeFilters = countActiveFilters(filters);

  // Keyed by the active query so a filter change resets to the loading state during render —
  // avoids a synchronous setState inside the effect (React 19 set-state-in-effect).
  const [state, setState] = useState<{
    key: string;
    tickets: TicketRow[] | null;
    error: string | null;
  }>({ key: queryString, tickets: null, error: null });
  const [attempt, setAttempt] = useState(0);

  if (state.key !== queryString) {
    setState({ key: queryString, tickets: null, error: null });
  }
  const tickets = state.tickets;
  const error = state.error;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/projects/${slug}/tickets${queryString}`);
        if (!res.ok) throw new Error(`Failed to load tickets (${res.status})`);
        const data = (await res.json()) as { tickets: TicketRow[] };
        if (!cancelled) setState({ key: queryString, tickets: data.tickets, error: null });
      } catch (err) {
        if (!cancelled) {
          setState({
            key: queryString,
            tickets: null,
            error: err instanceof Error ? err.message : "Failed to load tickets",
          });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, queryString, attempt]);

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-5 sm:px-6">
        <div className="flex items-center gap-2 text-[13px]">
          <Link href={`/projects/${slug}`} className="text-muted-foreground hover:text-foreground">
            {slug}
          </Link>
          <span className="text-subtle">/</span>
          <span className="font-medium text-foreground">Tickets</span>
        </div>
        {tickets && (
          <span className="ml-1 font-mono text-[11px] text-subtle">{tickets.length} total</span>
        )}
        <Link
          href={`/projects/${slug}/shape`}
          className={cn(buttonVariants({ size: "sm" }), "ml-auto")}
        >
          <PlusIcon aria-hidden="true" />
          Add work
        </Link>
      </header>

      <TicketsFilters tickets={tickets ?? []} />

      {error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl border border-risk-high/30 bg-risk-high/10">
            <TriangleAlertIcon className="size-5 text-risk-high" aria-hidden="true" />
          </span>
          <p className="text-sm text-risk-high">{error}</p>
          <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      ) : tickets === null ? (
        <TicketsSkeleton />
      ) : tickets.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-3 py-16 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl border border-dashed border-border">
            <ListTodoIcon className="size-5 text-subtle" aria-hidden="true" />
          </span>
          <p className="text-sm text-subtle">No tickets match these filters</p>
        </div>
      ) : (
        <>
          <TicketsTable slug={slug} tickets={tickets} />
          <div className="mt-auto flex items-center justify-between border-t border-border px-5 py-3 sm:px-6">
            <span className="font-mono text-[11px] text-subtle">
              {tickets.length} matching
              {activeFilters > 0 && ` · ${activeFilters} filter${activeFilters === 1 ? "" : "s"}`}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

const GRID = "grid grid-cols-[26px_minmax(0,1fr)_92px_150px_120px_72px_60px] items-center gap-3";

function TicketsTable({ slug, tickets }: { slug: string; tickets: TicketRow[] }) {
  return (
    <div className="flex flex-col">
      <div
        className={cn(
          GRID,
          "border-b border-border px-5 py-2.5 font-mono text-[10px] tracking-[0.05em] text-subtle uppercase sm:px-6",
        )}
      >
        <span />
        <span>Ticket</span>
        <span>ID</span>
        <span>Epic</span>
        <span>Agent</span>
        <span>Risk</span>
        <span>Size</span>
      </div>
      <ul>
        {tickets.map((ticket, i) => {
          const isDone = ticket.stage === "done";
          const isEpic = ticket.type === "epic";
          const titleHref = isEpic
            ? `/projects/${slug}/epics/${ticket.id}`
            : ticket.epicId
              ? `/projects/${slug}/epics/${ticket.epicId}`
              : null;
          const titleClass = cn(
            "truncate text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            isDone
              ? "text-muted-foreground line-through decoration-border"
              : isEpic
                ? "font-semibold text-foreground"
                : "text-foreground",
          );
          return (
            <li
              key={ticket.id}
              className={cn(GRID, "px-5 py-2.5 sm:px-6", i % 2 === 1 && "bg-card/40")}
            >
              <StatusCircle stage={ticket.stage} epic={isEpic} />
              {titleHref ? (
                <Link href={titleHref} className={titleClass} title={ticket.title}>
                  {ticket.title}
                </Link>
              ) : (
                <span className={titleClass} title={ticket.title}>
                  {ticket.title}
                </span>
              )}
              <span className="font-mono text-[11px] text-subtle">{ticket.id}</span>
              {isEpic ? (
                <span className="font-mono text-[10px] tracking-wide text-primary uppercase">epic</span>
              ) : (
                <span className="truncate text-xs text-muted-foreground" title={ticket.epicTitle ?? ""}>
                  {ticket.epicTitle ?? "—"}
                </span>
              )}
              <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                {ticket.agent ? (
                  <>
                    <span className={cn("size-1.5 rounded-full", agentDotClass(ticket.agent))} aria-hidden="true" />
                    {ticket.agent}
                  </>
                ) : (
                  <span className="text-subtle">—</span>
                )}
              </span>
              <span
                className={cn(
                  "font-mono text-[11px]",
                  ticket.risk === "high"
                    ? "text-risk-high"
                    : ticket.risk === "med"
                      ? "text-risk-med"
                      : "text-subtle",
                )}
              >
                {ticket.risk ?? "—"}
              </span>
              <span className="font-mono text-[11px] text-subtle">{ticket.size ?? "—"}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const STAGE_MARK: Record<Stage, string> = {
  backlog: "border-subtle",
  implementing: "border-stage-implementing",
  "in-review": "border-stage-in-review",
  done: "border-stage-done",
};

function StatusCircle({ stage, epic = false }: { stage: Stage; epic?: boolean }) {
  // Epics read as a rounded square (a container of tickets) tinted by their stage.
  if (epic) {
    return (
      <span
        className={cn(
          "size-[15px] rounded-[4px] border-[1.5px]",
          STAGE_MARK[stage],
          stage === "done" && "bg-stage-done",
        )}
        aria-label={`epic · ${stage}`}
      />
    );
  }
  if (stage === "done") {
    return (
      <span className="flex size-[15px] items-center justify-center rounded-full bg-stage-done" aria-label="done">
        <CheckIcon className="size-2.5 text-[#0b0a09]" strokeWidth={3} aria-hidden="true" />
      </span>
    );
  }
  if (stage === "implementing") {
    return (
      <span className="flex size-[15px] items-center justify-center rounded-full border-[1.5px] border-stage-implementing" aria-label="in progress">
        <span className="size-1.5 rounded-full bg-stage-implementing anton-pulse" />
      </span>
    );
  }
  if (stage === "in-review") {
    return (
      <span className="flex size-[15px] items-center justify-center rounded-full border-[1.5px] border-stage-in-review" aria-label="in review">
        <span className="size-1.5 rounded-full bg-stage-in-review" />
      </span>
    );
  }
  return <span className="size-[15px] rounded-full border-[1.5px] border-subtle" aria-label="todo" />;
}

function TicketsSkeleton() {
  return (
    <div className="flex flex-col" aria-busy="true" aria-label="Loading tickets">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className={cn(GRID, "px-5 py-3 sm:px-6", i % 2 === 1 && "bg-card/40")}>
          <span className="anton-shimmer size-[15px] rounded-full" />
          <span className="anton-shimmer h-3 w-3/5 rounded" />
          <span className="anton-shimmer h-2.5 w-12 rounded" />
          <span className="anton-shimmer h-2.5 w-20 rounded" />
          <span className="anton-shimmer h-2.5 w-16 rounded" />
          <span className="anton-shimmer h-2.5 w-8 rounded" />
          <span className="anton-shimmer h-2.5 w-6 rounded" />
        </div>
      ))}
    </div>
  );
}
