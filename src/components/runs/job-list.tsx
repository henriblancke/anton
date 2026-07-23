"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";

// Type-only import: pulling the runtime `isActiveJob`/`listJobs` from jobs-view would drag its
// better-sqlite3 (server-only) dependency into this client bundle. Types are erased at build, so
// this is safe; the active-status check is inlined below.
import type { JobStatus, JobSummary } from "@/lib/jobs-view";
import { cn } from "@/lib/utils";
import { fmtDuration } from "@/components/runs/run-view-utils";
import { ResumeJobButton } from "@/components/runs/resume-job-button";
import { KillJobButton } from "@/components/runs/kill-job-button";
import {
  InvestigateJobButton,
  InvestigateTerminal,
} from "@/components/runs/investigate-job";

const STATUS_STYLE: Record<JobStatus, { dot: string; text: string; pulse?: boolean }> = {
  running: { dot: "bg-stage-implementing", text: "text-stage-implementing", pulse: true },
  queued: { dot: "bg-stage-backlog", text: "text-muted-foreground" },
  parked: { dot: "bg-risk-med", text: "text-risk-med" },
  failed: { dot: "bg-risk-high", text: "text-risk-high" },
  cancelled: { dot: "bg-muted-foreground", text: "text-muted-foreground" },
  done: { dot: "bg-stage-done", text: "text-stage-done" },
};

/** Job statuses still in flight — mirrors jobs-view.isActiveJob, inlined to keep this bundle server-free. */
const ACTIVE_JOB_STATUSES = new Set<JobStatus>(["queued", "running", "parked"]);

/** Compact "3m ago" / "2h ago" for the activity column. */
function relativeTime(epoch?: number): string {
  if (!epoch) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epoch);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Absolute local timestamp for the detail panel. */
function absTime(epoch?: number): string {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleString();
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
  investigateCwds,
}: {
  jobs: JobSummary[];
  slug: string;
  /** jobId → live cwd for jobs running on this instance (anton-gjhu) — gates the Investigate action. */
  investigateCwds?: Record<string, string>;
}) {
  return (
    <ul className="flex flex-col divide-y divide-border">
      {jobs.map((job) => (
        <JobRow key={job.id} job={job} slug={slug} investigateCwd={investigateCwds?.[job.id]} />
      ))}
    </ul>
  );
}

function JobRow({
  job,
  slug,
  investigateCwd,
}: {
  job: JobSummary;
  slug: string;
  investigateCwd?: string;
}) {
  const [open, setOpen] = useState(false);
  // A confirmed kill is terminal, so the row can show `cancelled` immediately rather than waiting
  // on router.refresh(). Only ever set from a 200 — a failed kill leaves the job's own status.
  const [killed, setKilled] = useState(false);
  // Live investigate pty under this row (anton-gjhu). Set only from a 201 spawn, cleared on close.
  const [investigateSession, setInvestigateSession] = useState<string | null>(null);
  const status: JobStatus = killed ? "cancelled" : job.status;
  const style = STATUS_STYLE[status];
  const active = ACTIVE_JOB_STATUSES.has(status);
  const finished = !active;
  // Parked/failed jobs are recoverable but not self-healing — offer a manual resume (anton-ner.4).
  const resumable = !killed && (job.status === "parked" || job.status === "failed");
  // Investigate needs a job that's still running here with a reported cwd — the map only carries
  // those, and a local kill drops the action immediately.
  const investigable = !killed && job.status === "running" && Boolean(investigateCwd);

  return (
    <li className="flex flex-col">
      <div className="flex items-center gap-4 px-6 py-3.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-subtle transition-transform",
              open && "rotate-90",
            )}
            aria-hidden="true"
          />
          <span
            className={cn("size-2 shrink-0 rounded-full", style.dot, style.pulse && "anton-pulse")}
            aria-hidden="true"
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-mono text-[13px]">{job.type}</span>
            <span className="truncate font-mono text-[11px] text-subtle">
              {job.epicBeadId ? `${job.epicBeadId} · ` : ""}
              {job.attempts} {job.attempts === 1 ? "attempt" : "attempts"}
              {job.lastError ? ` · ${job.lastError}` : ""}
            </span>
          </div>
        </button>
        {(resumable || active) && (
          <div
            className="flex shrink-0 items-center gap-1.5"
            onClick={(e) => e.stopPropagation()}
          >
            {resumable && <ResumeJobButton slug={slug} jobId={job.id} />}
            {investigable && !investigateSession && (
              <InvestigateJobButton slug={slug} jobId={job.id} onSession={setInvestigateSession} />
            )}
            {active && (
              <KillJobButton slug={slug} jobId={job.id} onKilled={() => setKilled(true)} />
            )}
          </div>
        )}
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <span className={cn("font-mono text-[11px]", style.text)}>{status}</span>
          <span className="font-mono text-[10px] text-subtle">
            {finished
              ? `${fmtDuration(job.createdAt, job.updatedAt)} · ${relativeTime(job.updatedAt)}`
              : relativeTime(job.createdAt)}
          </span>
        </div>
      </div>

      {open && <JobDetail job={job} status={status} />}

      {investigateSession && investigateCwd && (
        <InvestigateTerminal
          slug={slug}
          sessionId={investigateSession}
          cwd={investigateCwd}
          onClose={() => setInvestigateSession(null)}
        />
      )}
    </li>
  );
}

function JobDetail({ job, status }: { job: JobSummary; status: JobStatus }) {
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
