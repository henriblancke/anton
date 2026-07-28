"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronRightIcon, ScrollTextIcon } from "lucide-react";

// Type-only import: pulling the runtime `isActiveJob`/`listJobs` from jobs-view would drag its
// better-sqlite3 (server-only) dependency into this client bundle. Types are erased at build, so
// this is safe; the active-status check is inlined below.
import type { JobStatus, JobSummary } from "@/lib/jobs-view";
// Type-only for the same reason: runner.ts is server-only, but its LiveJobInfo shape is exactly
// what the page resolves per running job.
import type { LiveJobInfo } from "@/lib/jobs/runner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { fmtDuration } from "@/components/runs/run-view-utils";
import { ResumeJobButton } from "@/components/runs/resume-job-button";
import { KillJobButton } from "@/components/runs/kill-job-button";
import { BulkKillJobsBar } from "@/components/runs/bulk-kill-jobs-bar";
import {
  InvestigateJobButton,
  InvestigateTerminal,
} from "@/components/runs/investigate-job";
import { JobOutputPanel } from "@/components/runs/view-job-output";

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
  liveJobs,
}: {
  jobs: JobSummary[];
  slug: string;
  /**
   * jobId → live handle for jobs running on this instance: cwd gates the Investigate action
   * (anton-gjhu), sessionId gates View live output (anton-x10l).
   */
  liveJobs?: Record<string, LiveJobInfo>;
}) {
  // Confirmed kills, held here rather than per row so the bulk bar and the per-row button write to
  // the same place. Only ever grown from a 200 — a refused kill leaves the job's own status.
  const [killedIds, setKilledIds] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(EMPTY_IDS);

  // Selection may only ever cover rows on screen, so it is keyed to exactly the rows rendered.
  const rowsKey = useMemo(() => jobs.map((job) => job.id).join("|"), [jobs]);
  const [renderedRowsKey, setRenderedRowsKey] = useState(rowsKey);
  if (renderedRowsKey !== rowsKey) {
    // A different result set is on screen (filter or page changed) — drop the selection during
    // render so a stale one can never be killed against rows the founder is no longer looking at.
    // Local kill state goes with it: the freshly loaded rows carry the server's own status.
    setRenderedRowsKey(rowsKey);
    setSelectedIds(EMPTY_IDS);
    setKilledIds(EMPTY_IDS);
  }

  // Selectable === killable: exactly the rows that render a per-row Force kill.
  const selectableIds = jobs
    .filter((job) => ACTIVE_JOB_STATUSES.has(job.status) && !killedIds.has(job.id))
    .map((job) => job.id);
  const selected = selectableIds.filter((id) => selectedIds.has(id));
  const allSelected = selectableIds.length > 0 && selected.length === selectableIds.length;

  function toggle(jobId: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(jobId);
      else next.delete(jobId);
      return next;
    });
  }

  function markKilled(ids: string[]) {
    setKilledIds((prev) => new Set([...prev, ...ids]));
    setSelectedIds((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
  }

  return (
    <div className="flex flex-col">
      {selectableIds.length > 0 && (
        <div className="flex items-center gap-3 border-b border-border px-6 py-2.5">
          <SelectCheckbox
            id={SELECT_ALL_ID}
            checked={allSelected}
            indeterminate={selected.length > 0 && !allSelected}
            onChange={(checked) =>
              setSelectedIds(checked ? new Set(selectableIds) : EMPTY_IDS)
            }
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
              onKilled={markKilled}
              onClear={() => setSelectedIds(EMPTY_IDS)}
            />
          )}
        </div>
      )}
      <ul className="flex flex-col divide-y divide-border">
        {jobs.map((job) => (
          <JobRow
            key={job.id}
            job={job}
            slug={slug}
            live={liveJobs?.[job.id]}
            killed={killedIds.has(job.id)}
            onKilled={() => markKilled([job.id])}
            selectable={selectableIds.includes(job.id)}
            selected={selectedIds.has(job.id)}
            onSelectedChange={(checked) => toggle(job.id, checked)}
            selectionColumn={selectableIds.length > 0}
          />
        ))}
      </ul>
    </div>
  );
}

/** Stable empty selection, so a reset can't churn identity on every render. */
const EMPTY_IDS: ReadonlySet<string> = new Set();

/** One list per page, so a constant id is enough to bind the visible "Select all" text to it. */
const SELECT_ALL_ID = "jobs-select-all";

/**
 * Native checkbox — keyboard-reachable and indeterminate-capable for free, which is the whole
 * requirement here. `indeterminate` is DOM-only state, so it is written through a ref.
 */
function SelectCheckbox({
  id,
  checked,
  indeterminate = false,
  onChange,
  label,
}: {
  id?: string;
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      id={id}
      aria-label={label}
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = indeterminate;
      }}
      onChange={(event) => onChange(event.target.checked)}
      className="size-3.5 shrink-0 cursor-pointer accent-destructive outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    />
  );
}

function JobRow({
  job,
  slug,
  live,
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
  // Live investigate pty under this row (anton-gjhu). Set only from a 201 spawn, cleared on close.
  const [investigateSession, setInvestigateSession] = useState<string | null>(null);
  // Live output viewer under this row (anton-x10l) — read-only tail of the job's session log.
  const [outputOpen, setOutputOpen] = useState(false);
  const liveCwd = live?.cwd;

  // Job settled while the terminal was open (an RSC refresh dropped the live handle, e.g. after a
  // confirmed kill) → drop the session during render (React's "adjusting state when props change"
  // pattern) so the teardown effect below fires and a later resume can't resurrect a dead session.
  if (investigateSession && !liveCwd) setInvestigateSession(null);
  // Same for the output panel: without this, a settled job leaves outputOpen=true and a later
  // resume with a fresh sessionId would silently reopen the panel without a user click.
  if (outputOpen && !live?.sessionId) setOutputOpen(false);

  // The row owns the investigate pty's lifetime: dropping the session — Close, the job settling
  // out from under the terminal, or this row unmounting — must kill the pty, because unmounting
  // PtyTerminal only aborts the SSE stream and the claude process would outlive the panel until
  // the server-side timeout. Keyed on the session (not a cleanup inside InvestigateTerminal) so
  // dev StrictMode's double-mount of the panel can't kill a live session: at row mount the
  // session is null and the double-invoked effect is a no-op.
  useEffect(() => {
    if (!investigateSession) return;
    return () => {
      void fetch(`/api/projects/${slug}/sessions/${investigateSession}/pty`, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => {
        /* best-effort teardown — the pty exits on its own if this never lands */
      });
    };
  }, [slug, investigateSession]);
  const status: JobStatus = killed ? "cancelled" : job.status;
  const style = STATUS_STYLE[status];
  const active = ACTIVE_JOB_STATUSES.has(status);
  const finished = !active;
  // Parked/failed jobs are recoverable but not self-healing — offer a manual resume (anton-ner.4).
  const resumable = !killed && (job.status === "parked" || job.status === "failed");
  // Investigate needs a job that's still running here with a reported cwd — the map only carries
  // those, and a local kill drops the action immediately.
  const investigable = !killed && job.status === "running" && Boolean(live?.cwd);
  // View live output needs a running job whose handler reported a session — same locality rules.
  const observable = !killed && job.status === "running" && Boolean(live?.sessionId);

  return (
    <li className="flex flex-col">
      <div className="flex items-center gap-3 px-6 py-3.5">
        {selectable ? (
          <SelectCheckbox
            checked={selected}
            onChange={onSelectedChange}
            label={`Select ${job.type} job ${job.id} for bulk kill`}
          />
        ) : (
          selectionColumn && <span className="size-3.5 shrink-0" aria-hidden="true" />
        )}
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
            {observable && !outputOpen && (
              <Button size="xs" variant="outline" onClick={() => setOutputOpen(true)}>
                <ScrollTextIcon aria-hidden="true" />
                View live output
              </Button>
            )}
            {investigable && !investigateSession && (
              <InvestigateJobButton slug={slug} jobId={job.id} onSession={setInvestigateSession} />
            )}
            {active && <KillJobButton slug={slug} jobId={job.id} onKilled={onKilled} />}
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

      {outputOpen && live?.sessionId && (
        <JobOutputPanel
          slug={slug}
          sessionId={live.sessionId}
          onClose={() => setOutputOpen(false)}
        />
      )}

      {investigateSession && liveCwd && (
        <InvestigateTerminal
          slug={slug}
          sessionId={investigateSession}
          cwd={liveCwd}
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
