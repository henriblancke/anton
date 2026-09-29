import Link from "next/link";

import { COHORT_DIMENSIONS, type CohortDimension } from "@/lib/prompt-series";
import { SPEND_WINDOWS, type SpendWindow } from "@/lib/spend-breakdown";
import { cn } from "@/lib/utils";

const TAB_CLASS =
  "rounded-lg border px-2.5 py-1 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
const TAB_ACTIVE_CLASS = "border-ring/40 bg-card text-foreground";
const TAB_INACTIVE_CLASS =
  "border-transparent text-muted-foreground hover:bg-card/60 hover:text-foreground";

/**
 * The two query bounds a cohort series is folded over (anton-lplyz): which stamp dimension groups
 * the cohorts, and which window decides which run targets are in scope.
 *
 * Links, not a client control — same reasoning as `SpendWindowTabs`: both bounds are server-side
 * query params the page reads before folding, so they belong in the URL and keep this a Server
 * Component. Rendered together because changing either one re-requests the same page with the
 * other held fixed.
 */
export function CohortControls({
  slug,
  dimension,
  window,
}: {
  slug: string;
  dimension: CohortDimension;
  window: SpendWindow;
}) {
  const href = (next: { dimension?: CohortDimension; window?: SpendWindow }) =>
    `/projects/${slug}/cohorts?dimension=${next.dimension ?? dimension}&window=${next.window ?? window}`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <nav aria-label="Cohort dimension" className="flex flex-wrap items-center gap-1">
        {COHORT_DIMENSIONS.map((option) => (
          <Link
            key={option.value}
            href={href({ dimension: option.value })}
            aria-current={option.value === dimension ? "page" : undefined}
            className={cn(TAB_CLASS, option.value === dimension ? TAB_ACTIVE_CLASS : TAB_INACTIVE_CLASS)}
          >
            {option.label}
          </Link>
        ))}
      </nav>
      <nav aria-label="Cohort window" className="flex flex-wrap items-center gap-1">
        {SPEND_WINDOWS.map((option) => (
          <Link
            key={option.value}
            href={href({ window: option.value })}
            aria-current={option.value === window ? "page" : undefined}
            className={cn(TAB_CLASS, option.value === window ? TAB_ACTIVE_CLASS : TAB_INACTIVE_CLASS)}
          >
            {option.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
