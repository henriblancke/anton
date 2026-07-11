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
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Repos anton drives autonomously via beads and Claude Code.
          </p>
        </div>
        <AddProjectDialog />
      </div>

      {projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">No projects yet. Add one to get started.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/projects/${project.slug}`}
              className="rounded-xl focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <Card className="h-full transition-colors hover:bg-muted/40">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FolderGitIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    {project.name}
                  </CardTitle>
                  <CardDescription className="truncate">{project.repoPath}</CardDescription>
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
