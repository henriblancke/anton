import Link from "next/link";
import { notFound } from "next/navigation";
import { SquareTerminalIcon } from "lucide-react";

import { getProjectBySlug } from "@/lib/projects";
import { listRuns, type RunStatus, type RunSummary } from "@/lib/runs";
import { cn } from "@/lib/utils";
import { fmtDuration, isActiveRun } from "@/components/runs/run-view-utils";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<RunStatus, { dot: string; text: string; pulse?: boolean }> = {
  running: { dot: "bg-stage-implementing", text: "text-stage-implementing", pulse: true },
  queued: { dot: "bg-stage-backlog", text: "text-muted-foreground" },
  parked: { dot: "bg-risk-med", text: "text-risk-med" },
  failed: { dot: "bg-risk-high", text: "text-risk-high" },
  done: { dot: "bg-stage-done", text: "text-stage-done" },
};

/** Compact "3m ago" / "2h ago" for the history column. */
function relativeTime(epoch?: number): string {
  if (!epoch) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epoch);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default async function ProjectRunsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();

  const runs = await listRuns(project.id);
  // Split active (queued/running/parked) from history (done/failed) for diagnostics browsing.
  const active = runs.filter((r) => isActiveRun(r.status));
  const history = runs.filter((r) => !isActiveRun(r.status));

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-6">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">{project.name}</span>
          <span className="text-subtle">/</span>
          <span className="font-medium text-foreground">Runs</span>
        </div>
        <span className="ml-1 font-mono text-[11px] text-subtle">{runs.length}</span>
      </header>

      {runs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl border border-dashed border-border">
            <SquareTerminalIcon className="size-5 text-subtle" aria-hidden="true" />
          </span>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold">No runs yet</p>
            <p className="max-w-sm text-xs leading-relaxed text-subtle">
              Approve an epic on the board to kick off an autonomous run. Live execution — a headless{" "}
              <span className="font-mono text-muted-foreground">claude</span> in a worktree — streams
              here.
            </p>
          </div>
          <Link href={`/projects/${slug}`} className="font-mono text-xs text-primary hover:underline">
            → Go to board
          </Link>
        </div>
      ) : (
        <div className="flex flex-col">
          {active.length > 0 && <RunGroup label="Active" runs={active} slug={slug} />}
          {history.length > 0 && <RunGroup label="History" runs={history} slug={slug} />}
        </div>
      )}
    </div>
  );
}

function RunGroup({ label, runs, slug }: { label: string; runs: RunSummary[]; slug: string }) {
  return (
    <section>
      <div className="flex items-center gap-2 border-b border-border bg-card/30 px-6 py-2">
        <span className="font-mono text-[10px] tracking-[0.05em] text-subtle uppercase">{label}</span>
        <span className="font-mono text-[10px] text-subtle">{runs.length}</span>
      </div>
      <ul className="flex flex-col divide-y divide-border">
        {runs.map((run) => (
          <RunRow key={run.id} run={run} slug={slug} />
        ))}
      </ul>
    </section>
  );
}

function RunRow({ run, slug }: { run: RunSummary; slug: string }) {
  const style = STATUS_STYLE[run.status];
  const finished = !isActiveRun(run.status);
  return (
    <li>
      <Link
        href={`/projects/${slug}/runs/${run.id}`}
        className="flex items-center gap-4 px-6 py-3.5 transition-colors hover:bg-card/50"
      >
        <span
          className={cn("size-2 shrink-0 rounded-full", style.dot, style.pulse && "anton-pulse")}
          aria-hidden="true"
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-mono text-[13px]">{run.id}</span>
          <span className="truncate font-mono text-[11px] text-subtle">
            {run.epicBeadId}
            {run.ticketBeadId ? ` · ${run.ticketBeadId}` : ""}
            {run.agentTag ? ` · ${run.agentTag}` : ""}
            {run.model ? ` · ${run.model}` : ""}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 flex-col items-end gap-0.5">
          <span className={cn("font-mono text-[11px]", style.text)}>{run.status}</span>
          <span className="font-mono text-[10px] text-subtle">
            {finished
              ? `${fmtDuration(run.startedAt, run.endedAt)} · ${relativeTime(run.endedAt ?? run.updatedAt)}`
              : relativeTime(run.startedAt ?? run.updatedAt)}
          </span>
        </div>
      </Link>
    </li>
  );
}
