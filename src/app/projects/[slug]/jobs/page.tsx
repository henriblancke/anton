import Link from "next/link";
import { notFound } from "next/navigation";
import { LayersIcon } from "lucide-react";

import { getProjectBySlug } from "@/lib/projects";
import { countJobs, listJobsPaged } from "@/lib/jobs-view";
import { countRuns } from "@/lib/runs";
import { SectionTabs } from "@/components/runs/section-tabs";
import { PAGE_SIZE, Pagination, resolvePage } from "@/components/runs/pagination";
import { JobList } from "@/components/runs/job-list";

export const dynamic = "force-dynamic";

export default async function ProjectJobsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();

  const [total, runsCount] = await Promise.all([countJobs(project.id), countRuns(project.id)]);
  const { page } = await searchParams;
  const current = resolvePage(page, total);
  const jobs = total > 0 ? await listJobsPaged(project.id, {
    limit: PAGE_SIZE,
    offset: (current - 1) * PAGE_SIZE,
  }) : [];

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-6">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">{project.name}</span>
          <span className="text-subtle">/</span>
          <span className="font-medium text-foreground">Jobs</span>
        </div>
      </header>

      <SectionTabs slug={slug} active="jobs" runsCount={runsCount} jobsCount={total} />

      {total === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl border border-dashed border-border">
            <LayersIcon className="size-5 text-subtle" aria-hidden="true" />
          </span>
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
        </div>
      ) : (
        <div className="flex flex-1 flex-col">
          <JobList jobs={jobs} slug={slug} />
          <Pagination basePath={`/projects/${slug}/jobs`} page={current} total={total} />
        </div>
      )}
    </div>
  );
}
