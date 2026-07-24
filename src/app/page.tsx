import Link from "next/link";
import { CircleAlertIcon } from "lucide-react";

import { listProjects } from "@/lib/projects";
import { AddProjectDialog } from "@/components/projects/add-project-dialog";
import { AntonMark } from "@/components/shell/brand";
import { LinkPendingIndicator } from "@/components/ui/link-pending-indicator";

// Reads the local anton.db at request time — never prerender.
export const dynamic = "force-dynamic";

export default async function Home() {
  const projects = await listProjects();

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-6 py-4">
        <h1 className="text-[15px] font-semibold">Projects</h1>
        <span className="font-mono text-[11px] text-subtle">{projects.length}</span>
        <div className="ml-auto">
          <AddProjectDialog />
        </div>
      </div>

      {projects.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <span className="flex size-14 items-center justify-center rounded-2xl border border-dashed border-border">
            <AntonMark size={26} />
          </span>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold">No projects yet</p>
            <p className="max-w-xs text-xs leading-relaxed text-subtle">
              Point anton at a local repo with a{" "}
              <span className="font-mono text-muted-foreground">.beads/</span> directory to start
              driving its work.
            </p>
          </div>
          <AddProjectDialog />
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-6">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/projects/${project.slug}`}
              className="group flex items-center gap-4 rounded-xl border border-border bg-card p-[18px] transition-colors hover:border-ring/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 has-[[data-pending]]:opacity-60"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] border border-border bg-secondary font-mono text-[15px] font-medium text-primary">
                {project.name[0]?.toLowerCase() ?? "a"}
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-[15px] font-semibold" title={project.name}>
                  {project.name}
                </span>
                <span className="truncate font-mono text-[11px] text-subtle" title={project.repoPath}>
                  {project.repoPath} · {project.defaultBranch}
                </span>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-5">
                {project.hasBeads ? (
                  <span className="hidden items-center gap-1.5 font-mono text-[11px] text-stage-done sm:inline-flex">
                    <span className="size-1.5 rounded-full bg-stage-done" aria-hidden="true" />
                    beads
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-risk-high">
                    <CircleAlertIcon className="size-3.5" aria-hidden="true" />
                    no .beads/
                  </span>
                )}
                <LinkPendingIndicator className="text-muted-foreground" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
