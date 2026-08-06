"use client";

import { usePathname } from "next/navigation";

import { HealthPageFallback } from "@/components/health/health-page-fallback";
import { extractProjectSlug } from "@/components/shell/shell-utils";

/**
 * Instant fallback while the Health page's RSC resolves its reads — see
 * `HealthPageFallback`'s docblock. Client component: `loading.tsx` gets no params, so the slug for
 * the breadcrumb comes from the committed pathname, same as the roadmap page's own loading state.
 */
export default function HealthLoading() {
  const pathname = usePathname();
  return <HealthPageFallback slug={extractProjectSlug(pathname)} />;
}
