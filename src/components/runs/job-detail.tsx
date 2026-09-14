"use client";

import type { JobStatus, JobSummary } from "@/lib/jobs-view";
import type { PassRecordSummary } from "@/lib/gardener/record";
import { PassRecordPanel } from "@/components/runs/pass-record";
import { absTime } from "@/components/runs/job-view-utils";

/**
 * The expanded row: the job's full record, so a failed scan is diagnosable without touching the DB
 * (anton-ner.3).
 */
export function JobDetail({
  job,
  status,
  slug,
  passRecord,
}: {
  job: JobSummary;
  status: JobStatus;
  slug: string;
  passRecord?: PassRecordSummary;
}) {
  const rows: Array<[string, string]> = [
    ["Job ID", job.id],
    ["Type", job.type],
    ["Status", status],
    ["Attempts", String(job.attempts)],
    ["Created", absTime(job.createdAt)],
    ["Updated", absTime(job.updatedAt)],
  ];
  if (job.epicBeadId) rows.push(["Epic", job.epicBeadId]);
  if (job.scheduleId) rows.push(["Schedule", job.scheduleId]);

  return (
    <div className="flex flex-col gap-3 border-t border-border bg-card/20 px-6 py-3 pl-[3.25rem]">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono text-[11px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-subtle">{k}</dt>
            <dd className="min-w-0 break-all text-muted-foreground">{v}</dd>
          </div>
        ))}
      </dl>
      {passRecord && <PassRecordPanel summary={passRecord} slug={slug} />}
      {job.lastError && (
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] tracking-[0.05em] text-subtle uppercase">
            Last error
          </span>
          <pre className="max-h-64 overflow-auto rounded-md border border-border bg-background/60 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/90">
            {job.lastError}
          </pre>
        </div>
      )}
    </div>
  );
}
