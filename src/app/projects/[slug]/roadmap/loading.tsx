"use client";

import { usePathname } from "next/navigation";

import { RoadmapPageFallback } from "@/components/roadmap/roadmap-table";
import { extractProjectSlug } from "@/components/shell/shell-utils";

/**
 * Instant fallback while the roadmap RSC resolves its bead read — that await happens before the
 * page returns any markup, so only a route-level boundary can cover it. Client component:
 * loading.tsx gets no params, so the slug for the breadcrumb comes from the committed pathname.
 */
export default function RoadmapLoading() {
  const pathname = usePathname();

  return <RoadmapPageFallback slug={extractProjectSlug(pathname)} />;
}
