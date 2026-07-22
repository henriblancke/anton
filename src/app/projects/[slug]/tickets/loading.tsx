"use client";

import { usePathname } from "next/navigation";

import { TicketsPageFallback } from "@/components/tickets/tickets-view";
import { extractProjectSlug } from "@/components/shell/shell-utils";

/**
 * Instant fallback while the tickets RSC resolves getTickets() — that await happens before
 * the page returns its inner <Suspense>, so only a route-level boundary can cover it.
 * Client component: loading.tsx gets no params, so the slug for the breadcrumb comes from
 * the already-committed pathname.
 */
export default function TicketsLoading() {
  const pathname = usePathname();
  const projectSlug = extractProjectSlug(pathname);

  return <TicketsPageFallback slug={projectSlug} />;
}
