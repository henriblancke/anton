import Link from "next/link";
import { CircleCheckIcon, CircleXIcon, FolderGitIcon } from "lucide-react";

import { listProjects } from "@/lib/projects";
import { AddProjectDialog } from "@/components/projects/add-project-dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// Reads the local anton.db at request time — never prerender.
export const dynamic = "force-dynamic";

export default async function Home() {
  const projects = await listProjects();

  return (
    <div className="flex flex-1 flex-col gap-6 p-6 sm:p-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Repos anton drives autonomously via beads and Claude Code.
          </p>
        </div>
        <AddProjectDialog />
      </div>

      {projects.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
          <FolderGitIcon className="size-6 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm font-medium">No projects yet</p>
          <p className="text-sm text-muted-foreground">Add a repo to get started.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/projects/${project.slug}`}
              className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Card className="h-full transition-colors hover:border-border hover:bg-muted/40">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm font-medium">
                    <FolderGitIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate" title={project.name}>
                      {project.name}
                    </span>
                  </CardTitle>
                  <CardDescription className="truncate text-xs" title={project.repoPath}>
                    {project.repoPath}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Badge variant={project.hasBeads ? "outline" : "destructive"} className="gap-1">
                    {project.hasBeads ? (
                      <CircleCheckIcon aria-hidden="true" />
                    ) : (
                      <CircleXIcon aria-hidden="true" />
                    )}
                    beads
                  </Badge>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
