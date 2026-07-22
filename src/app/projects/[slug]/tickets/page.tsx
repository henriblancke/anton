import { Suspense } from "react";

import { TicketsPageFallback, TicketsView } from "@/components/tickets/tickets-view";
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
