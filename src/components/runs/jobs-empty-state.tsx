import Link from "next/link";
import { FilterXIcon, LayersIcon } from "lucide-react";

import { ALL_STATUSES } from "@/lib/jobs-filters";

/**
 * The two distinct "nothing here" cases on the Jobs page (anton-mjdo.3). Onboarding copy is only
 * honest when the project has never queued a job; a filtered-out list needs a way back to the
 * rows that do exist, not an explanation of what the queue is for.
 */
export function JobsEmptyState({ slug, filtered }: { slug: string; filtered: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <span className="flex size-12 items-center justify-center rounded-xl border border-dashed border-border">
        {filtered ? (
          <FilterXIcon className="size-5 text-subtle" aria-hidden="true" />
        ) : (
          <LayersIcon className="size-5 text-subtle" aria-hidden="true" />
        )}
      </span>
      {filtered ? (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold">No jobs match these filters</p>
            <p className="max-w-sm text-xs leading-relaxed text-subtle">
              This project has jobs, just none with the selected status and type. Widen the filters
              to see the full queue.
            </p>
          </div>
          {/* Straight to `status=all`: clearing to the default view lands on active-only, which is
              itself empty whenever every job has already settled. */}
          <Link
            href={`/projects/${slug}/jobs?status=${ALL_STATUSES}`}
            className="font-mono text-xs text-primary hover:underline"
          >
            → Show all jobs
          </Link>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold">No jobs yet</p>
            <p className="max-w-sm text-xs leading-relaxed text-subtle">
              The durable job queue — epic runs, review-fix polls, nightly stringer scans, and orphan
              grooming — surfaces here once work is approved or a schedule fires.
            </p>
          </div>
          <Link href={`/projects/${slug}/runs`} className="font-mono text-xs text-primary hover:underline">
            → View runs
          </Link>
        </>
      )}
    </div>
  );
}
