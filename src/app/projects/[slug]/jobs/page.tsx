import { notFound } from "next/navigation";

import { getProjectBySlug } from "@/lib/projects";
import { getRunningJobInfos } from "@/lib/jobs/service";
// Type-only: runner.ts is server-only, but the type is erased at build time.
import type { LiveJobInfo } from "@/lib/jobs/runner";
import { jobsQueryString, normalizeJobFilters } from "@/lib/jobs-filters";
import { countJobs, listJobsPaged } from "@/lib/jobs-view";
import { countRuns } from "@/lib/runs";
import { passRecordsByJob } from "@/lib/jobs/pass-records";
import { sessionsByJob } from "@/lib/sessions";
import { PAGE_SIZE, resolvePage } from "@/lib/pagination";
import { PageHeader } from "@/components/atoms";
import { SectionTabs } from "@/components/runs/section-tabs";
import { Pagination } from "@/components/runs/pagination";
import { JobList } from "@/components/runs/job-list";
import { JobsFilters } from "@/components/runs/jobs-filters";
import { JobsEmptyState } from "@/components/runs/jobs-empty-state";

export const dynamic = "force-dynamic";

export default async function ProjectJobsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string; status?: string; type?: string }>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const project = await getProjectBySlug(slug);
  if (!project) notFound();

  const filters = normalizeJobFilters(query);
  // Two counts, two jobs: `total` answers "has this project ever queued anything" (the onboarding
  // gate, and the Jobs tab badge shared with the Runs page); `matching` drives the list, the pager
  // and the filtered-empty state.
  const [total, matching, runsCount] = await Promise.all([
    countJobs(project.id),
    countJobs(project.id, filters),
    countRuns(project.id),
  ]);
  const current = resolvePage(query.page, matching);
  const jobs = matching > 0 ? await listJobsPaged(project.id, {
    limit: PAGE_SIZE,
    offset: (current - 1) * PAGE_SIZE,
    filters,
  }) : [];

  // Live handle per running job, read from the runner's in-memory state. Only jobs running on
  // THIS instance carry one — a reported cwd gates the Investigate action (anton-gjhu), a reported
  // sessionId gates View live output (anton-x10l); a queued/settled or other-machine job has
  // neither. The batch read trusts listJobsPaged's project scoping (no per-job DB re-check), and
  // only the two UI-relevant fields cross the RSC boundary.
  const liveJobs: Record<string, LiveJobInfo> = Object.fromEntries(
    Object.entries(
      getRunningJobInfos(jobs.filter((job) => job.status === "running").map((job) => job.id)),
    )
      .map(([id, info]) => [id, { sessionId: info.sessionId, cwd: info.cwd }] as const)
      .filter(([, live]) => Boolean(live.sessionId || live.cwd)),
  );

  // The durable session link (anton-lmps), which is what a SETTLED job has instead of a live handle:
  // a gardener or product-master pass writes no run row, so without this its log — the shadow
  // records among it — would be readable only while the pass was still running.
  const sessions = await sessionsByJob(jobs.map((job) => job.id));
  const jobSessions = Object.fromEntries(
    Object.entries(sessions).map(([jobId, session]) => [jobId, session.id]),
  );

  // What each pass APPLIED, shadowed and refused (anton-hzce), read out of that same log. An
  // auto-applied proposal is closed the moment it is filed, so it never stands on the board as an
  // open ask — without this the founder's first evidence of an unattended write is a bead that moved.
  const passRecords = await passRecordsByJob(jobs, sessions);

  return (
    <div className="flex flex-1 flex-col">
      <PageHeader project={project.name} section="Jobs" />

      <SectionTabs slug={slug} active="jobs" runsCount={runsCount} jobsCount={total} />

      {total === 0 ? (
        <JobsEmptyState slug={slug} filtered={false} />
      ) : (
        <div className="flex flex-1 flex-col">
          <JobsFilters />
          {matching === 0 ? (
            <JobsEmptyState slug={slug} filtered />
          ) : (
            <>
              <JobList
                jobs={jobs}
                slug={slug}
                liveJobs={liveJobs}
                jobSessions={jobSessions}
                passRecords={passRecords}
              />
              <Pagination
                basePath={`/projects/${slug}/jobs${jobsQueryString(filters)}`}
                page={current}
                total={matching}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
