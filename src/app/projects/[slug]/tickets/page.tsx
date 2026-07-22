import { Suspense } from "react";

import { TicketsSkeleton, TicketsView } from "@/components/tickets/tickets-view";
import { ticketsQueryString } from "@/components/tickets/tickets-utils";
import { getProjectBySlug } from "@/lib/projects";
import { getTickets } from "@/lib/tickets";
import type { TicketFilters } from "@/lib/types";

export default async function ProjectTicketsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const rawFilters = await searchParams;
  const filters: TicketFilters = {};
  for (const key of ["agent", "risk", "size", "domain", "status", "type", "epic", "q"] as const) {
    const value = rawFilters[key];
    if (typeof value === "string" && value.trim()) filters[key] = value.trim();
  }
  const project = await getProjectBySlug(slug);
  const tickets = project ? await getTickets(project, filters) : [];
  const initialQueryString = ticketsQueryString(filters);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={<TicketsPageFallback slug={slug} />}>
        <TicketsView
          slug={slug}
          initialTickets={tickets}
          initialQueryString={initialQueryString}
        />
      </Suspense>
    </div>
  );
}

/** Mirrors the TicketsView frame (h-14 header, filter bar, table rows) so the real view
 * swaps in without layout shift. */
function TicketsPageFallback({ slug }: { slug: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy="true">
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-5 sm:px-6">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">{slug}</span>
          <span className="text-subtle">/</span>
          <span className="font-medium text-foreground">Tickets</span>
        </div>
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-border px-5 py-3 sm:px-6">
        <span className="anton-shimmer h-8 w-52 rounded-lg" />
        <span className="h-5 w-px bg-border" aria-hidden="true" />
        {Array.from({ length: 4 }).map((_, i) => (
          <span key={i} className="anton-shimmer h-8 w-24 rounded-lg" />
        ))}
      </div>
      <TicketsSkeleton />
    </div>
  );
}
