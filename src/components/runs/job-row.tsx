"use client";

import { useState } from "react";
import { ChevronRightIcon, ScrollTextIcon } from "lucide-react";

// Type-only import: pulling the runtime `isActiveJob`/`listJobs` from jobs-view would drag its
// better-sqlite3 (server-only) dependency into this client bundle.
import type { JobStatus, JobSummary } from "@/lib/jobs-view";
// Type-only for the same reason: runner.ts is server-only, but its LiveJobInfo shape is exactly
// what the page resolves per running job.
import type { LiveJobInfo } from "@/lib/jobs/runner";
// Pure string→data, no server deps — see src/lib/gardener/record.ts.
import type { PassRecordSummary } from "@/lib/gardener/record";
import { cn } from "@/lib/utils";
import { PassRecordChips } from "@/components/runs/pass-record";
import { Button } from "@/components/ui/button";
import { fmtDuration } from "@/components/runs/run-view-utils";
import {
  JOB_STATUS_STYLE,
  isActionable,
  isActiveJobStatus,
  jobRowAffordances,
  relativeTime,
  type JobRowAffordances,
} from "@/components/runs/job-view-utils";
import { useJobRowPanels, type JobRowPanels } from "@/components/runs/use-job-row-panels";
import { SelectCheckbox } from "@/components/runs/select-checkbox";
import { JobDetail } from "@/components/runs/job-detail";
import { ResumeJobButton } from "@/components/runs/resume-job-button";
import { KillJobButton } from "@/components/runs/kill-job-button";
import {
  InvestigateJobButton,
  InvestigateTerminal,
} from "@/components/runs/investigate-job";
import { JobOutputPanel } from "@/components/runs/view-job-output";

/** The status dot. Pulses only while the job is still doing something. */
export function JobStatusDot({ status }: { status: JobStatus }) {
  const style = JOB_STATUS_STYLE[status];
  return (
    <span
      className={cn("size-2 shrink-0 rounded-full", style.dot, style.pulse && "anton-pulse")}
      aria-hidden="true"
    />
  );
}

/** The right-hand column: where the job stands, and how long it has stood there. */
export function JobRowTiming({ job, status }: { job: JobSummary; status: JobStatus }) {
  const finished = !isActiveJobStatus(status);
  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5">
      <span className={cn("font-mono text-[11px]", JOB_STATUS_STYLE[status].text)}>{status}</span>
      <span className="font-mono text-[10px] text-subtle">
        {finished
          ? `${fmtDuration(job.createdAt, job.updatedAt)} · ${relativeTime(job.updatedAt)}`
          : relativeTime(job.createdAt)}
      </span>
    </div>
  );
}

/** Everything identifying the job, in one expand target. */
export function JobRowSummary({
  job,
  status,
  open,
  onToggle,
  passRecord,
}: {
  job: JobSummary;
  status: JobStatus;
  open: boolean;
  onToggle: () => void;
  passRecord?: PassRecordSummary;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex min-w-0 flex-1 items-center gap-3 text-left"
    >
      <ChevronRightIcon
        className={cn("size-3.5 shrink-0 text-subtle transition-transform", open && "rotate-90")}
        aria-hidden="true"
      />
      <JobStatusDot status={status} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-mono text-[13px]">{job.type}</span>
        <span className="truncate font-mono text-[11px] text-subtle">
          {job.epicBeadId ? `${job.epicBeadId} · ` : ""}
          {job.attempts} {job.attempts === 1 ? "attempt" : "attempts"}
          {job.lastError ? ` · ${job.lastError}` : ""}
        </span>
      </div>
      {/* An unattended write has to be visible without expanding anything — a founder scanning
          the list is the first reader this record has. */}
      {passRecord && <PassRecordChips summary={passRecord} />}
    </button>
  );
}

/**
 * Opens the session log — live while the job runs, a replay once it has settled. Absent when there
 * is no log to read, and while its own panel already holds one.
 */
export function ViewOutputAction({
  affordances,
  panels,
}: {
  affordances: JobRowAffordances;
  panels: JobRowPanels;
}) {
  if (!affordances.observable || panels.outputOpen) return null;
  return (
    <Button size="xs" variant="outline" onClick={panels.openOutput}>
      <ScrollTextIcon aria-hidden="true" />
      {affordances.following ? "View live output" : "View output"}
    </Button>
  );
}

/** Attaches a pty to the job's worktree. Absent unless it runs here, and while one is attached. */
export function InvestigateAction({
  slug,
  jobId,
  affordances,
  panels,
}: {
  slug: string;
  jobId: string;
  affordances: JobRowAffordances;
  panels: JobRowPanels;
}) {
  if (!affordances.investigable || panels.investigateSession) return null;
  return <InvestigateJobButton slug={slug} jobId={jobId} onSession={panels.openInvestigate} />;
}

/** What the founder can do to this job from the list — nothing at all, for a settled one. */
export function JobRowActions({
  slug,
  jobId,
  affordances,
  panels,
  onKilled,
}: {
  slug: string;
  jobId: string;
  affordances: JobRowAffordances;
  panels: JobRowPanels;
  onKilled: () => void;
}) {
  if (!isActionable(affordances)) return null;

  return (
    <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      {affordances.resumable && <ResumeJobButton slug={slug} jobId={jobId} />}
      <ViewOutputAction affordances={affordances} panels={panels} />
      <InvestigateAction slug={slug} jobId={jobId} affordances={affordances} panels={panels} />
      {affordances.active && <KillJobButton slug={slug} jobId={jobId} onKilled={onKilled} />}
    </div>
  );
}

/** The bulk-kill checkbox, or the width it would take — settled rows keep the labels aligned. */
function JobRowSelect({
  job,
  selectable,
  selected,
  onSelectedChange,
  column,
}: {
  job: JobSummary;
  selectable: boolean;
  selected: boolean;
  onSelectedChange: (checked: boolean) => void;
  column: boolean;
}) {
  if (selectable) {
    return (
      <SelectCheckbox
        checked={selected}
        onChange={onSelectedChange}
        label={`Select ${job.type} job ${job.id} for bulk kill`}
      />
    );
  }
  return column ? <span className="size-3.5 shrink-0" aria-hidden="true" /> : null;
}

/** The live panels this row opens beneath itself, each gated on the handle it reads from. */
function JobRowPanelStack({
  slug,
  affordances,
  panels,
}: {
  slug: string;
  affordances: JobRowAffordances;
  panels: JobRowPanels;
}) {
  return (
    <>
      {panels.outputOpen && affordances.sessionId && (
        <JobOutputPanel
          slug={slug}
          sessionId={affordances.sessionId}
          live={affordances.following}
          onClose={panels.closeOutput}
        />
      )}
      {panels.investigateSession && affordances.liveCwd && (
        <InvestigateTerminal
          slug={slug}
          sessionId={panels.investigateSession}
          cwd={affordances.liveCwd}
          onClose={panels.closeInvestigate}
        />
      )}
    </>
  );
}

/**
 * One queue row: identity and status on the left, actions and timing on the right, with the detail
 * and the live panels beneath. The row itself only wires the parts together — what each part may
 * show comes from `jobRowAffordances`, and the panels' lifetime from `useJobRowPanels`.
 */
export function JobRow({
  job,
  slug,
  live,
  loggedSessionId,
  passRecord,
  killed,
  onKilled,
  selectable,
  selected,
  onSelectedChange,
  selectionColumn,
}: {
  job: JobSummary;
  slug: string;
  live?: LiveJobInfo;
  /** The session this job durably recorded — the only handle a settled job has (anton-lmps). */
  loggedSessionId?: string;
  /** This pass's record, for a gardener / product-master job (anton-hzce). */
  passRecord?: PassRecordSummary;
  /** Confirmed cancelled by the server (per-row or bulk) — the row shows `cancelled` at once. */
  killed: boolean;
  onKilled: () => void;
  selectable: boolean;
  selected: boolean;
  onSelectedChange: (checked: boolean) => void;
  /** The page has a selection column — settled rows still reserve its width so labels stay aligned. */
  selectionColumn: boolean;
}) {
  const [open, setOpen] = useState(false);
  const affordances = jobRowAffordances({ job, live, loggedSessionId, killed });
  const panels = useJobRowPanels({
    slug,
    liveCwd: affordances.liveCwd,
    sessionId: affordances.sessionId,
  });

  return (
    <li className="flex flex-col">
      <div className="flex items-center gap-3 px-6 py-3.5">
        <JobRowSelect
          job={job}
          selectable={selectable}
          selected={selected}
          onSelectedChange={onSelectedChange}
          column={selectionColumn}
        />
        <JobRowSummary
          job={job}
          status={affordances.status}
          open={open}
          onToggle={() => setOpen((v) => !v)}
          passRecord={passRecord}
        />
        <JobRowActions
          slug={slug}
          jobId={job.id}
          affordances={affordances}
          panels={panels}
          onKilled={onKilled}
        />
        <JobRowTiming job={job} status={affordances.status} />
      </div>

      {open && (
        <JobDetail job={job} status={affordances.status} slug={slug} passRecord={passRecord} />
      )}

      <JobRowPanelStack slug={slug} affordances={affordances} panels={panels} />
    </li>
  );
}
