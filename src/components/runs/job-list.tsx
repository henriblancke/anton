"use client";

// Type-only import: pulling the runtime `isActiveJob`/`listJobs` from jobs-view would drag its
// better-sqlite3 (server-only) dependency into this client bundle.
import type { JobSummary } from "@/lib/jobs-view";
// Type-only for the same reason: runner.ts is server-only, but its LiveJobInfo shape is exactly
// what the page resolves per running job.
import type { LiveJobInfo } from "@/lib/jobs/runner";
// Pure string→data, no server deps — see src/lib/gardener/record.ts.
import type { PassRecordSummary } from "@/lib/gardener/record";
import { BulkKillJobsBar } from "@/components/runs/bulk-kill-jobs-bar";
import { JobRow } from "@/components/runs/job-row";
import { SelectCheckbox } from "@/components/runs/select-checkbox";
import { useJobSelection, type JobSelection } from "@/components/runs/use-job-selection";

/** One list per page, so a constant id is enough to bind the visible "Select all" text to it. */
const SELECT_ALL_ID = "jobs-select-all";

/** The bulk header — present only while the page holds something cancellable. */
export function JobSelectionBar({ slug, selection }: { slug: string; selection: JobSelection }) {
  const { selectableIds, selected, allSelected } = selection;
  if (selectableIds.length === 0) return null;

  return (
    <div className="flex items-center gap-3 border-b border-border px-6 py-2.5">
      <SelectCheckbox
        id={SELECT_ALL_ID}
        checked={allSelected}
        indeterminate={selected.length > 0 && !allSelected}
        onChange={selection.selectAll}
        label={`Select all ${selectableIds.length} cancellable ${
          selectableIds.length === 1 ? "job" : "jobs"
        } on this page`}
      />
      <label htmlFor={SELECT_ALL_ID} className="cursor-pointer font-mono text-[11px] text-subtle">
        Select all
      </label>
      {selected.length > 0 && (
        <BulkKillJobsBar
          slug={slug}
          jobIds={selected}
          onKilled={selection.markKilled}
          onClear={selection.clear}
        />
      )}
    </div>
  );
}

/**
 * All queue activity from the `jobs` table — every type (execute-epic, review-fix,
 * nightly-stringer, orphan-grooming) and every status, so parked/failed jobs stay auditable even
 * when they never wrote a `runs` row (anton-ner.3). Rows expand to show the full lastError +
 * metadata, so a failed scan is diagnosable without touching the DB. Rendered on its own paginated
 * Jobs page, so no section chrome here — just the row list.
 */
export function JobList({
  jobs,
  slug,
  liveJobs,
  jobSessions,
  passRecords,
}: {
  jobs: JobSummary[];
  slug: string;
  /**
   * jobId → live handle for jobs running on this instance: cwd gates the Investigate action
   * (anton-gjhu), sessionId gates View live output (anton-x10l).
   */
  liveJobs?: Record<string, LiveJobInfo>;
  /**
   * jobId → the session that job opened, read from the durable link (anton-lmps). Survives the job
   * settling, which the live handle does not — this is what makes a finished pass's log readable.
   */
  jobSessions?: Record<string, string>;
  /**
   * jobId → what that pass applied, shadowed and refused (anton-hzce). Present for every gardener /
   * product-master job on the page — including the ones that recorded nothing, which is what lets a
   * quiet patrol render as a clean pass rather than as a row with the record missing.
   */
  passRecords?: Record<string, PassRecordSummary>;
}) {
  const selection = useJobSelection(jobs);
  const selectionColumn = selection.selectableIds.length > 0;

  return (
    <div className="flex flex-col">
      <JobSelectionBar slug={slug} selection={selection} />
      <ul className="flex flex-col divide-y divide-border">
        {jobs.map((job) => (
          <JobRow
            key={job.id}
            job={job}
            slug={slug}
            live={liveJobs?.[job.id]}
            loggedSessionId={jobSessions?.[job.id]}
            passRecord={passRecords?.[job.id]}
            killed={selection.isKilled(job.id)}
            onKilled={() => selection.markKilled([job.id])}
            selectable={selection.selectableIds.includes(job.id)}
            selected={selection.isSelected(job.id)}
            onSelectedChange={(checked) => selection.toggle(job.id, checked)}
            selectionColumn={selectionColumn}
          />
        ))}
      </ul>
    </div>
  );
}
