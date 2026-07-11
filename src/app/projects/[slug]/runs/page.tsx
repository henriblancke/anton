import Link from "next/link";
import { notFound } from "next/navigation";
import { SquareTerminalIcon } from "lucide-react";

import { getProjectBySlug } from "@/lib/projects";
import { listRuns, type RunStatus } from "@/lib/runs";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<RunStatus, { dot: string; text: string; pulse?: boolean }> = {
  running: { dot: "bg-stage-implementing", text: "text-stage-implementing", pulse: true },
  queued: { dot: "bg-stage-backlog", text: "text-muted-foreground" },
  parked: { dot: "bg-risk-med", text: "text-risk-med" },
  failed: { dot: "bg-risk-high", text: "text-risk-high" },
  done: { dot: "bg-stage-done", text: "text-stage-done" },
};

export default async function ProjectRunsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();

  const runs = await listRuns(project.id);

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
          <Link
            href={`/projects/${slug}`}
            className="font-mono text-xs text-primary hover:underline"
          >
            → Go to board
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {runs.map((run) => {
            const style = STATUS_STYLE[run.status];
            return (
              <li key={run.id}>
                <Link
                  href={`/projects/${slug}/epics/${run.epicBeadId}`}
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
                      {run.agentTag ? ` · ${run.agentTag}` : ""}
                      {run.model ? ` · ${run.model}` : ""}
                    </span>
                  </div>
                  <span className={cn("ml-auto font-mono text-[11px]", style.text)}>{run.status}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
