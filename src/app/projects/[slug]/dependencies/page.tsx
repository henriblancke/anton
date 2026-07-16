import { notFound } from "next/navigation";

import { getProjectBySlug } from "@/lib/projects";
import { ProjectGraph } from "@/components/epic/project-graph";

export const dynamic = "force-dynamic";

export default async function ProjectDependenciesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-6">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">{project.name}</span>
          <span className="text-subtle">/</span>
          <span className="font-medium text-foreground">Dependencies</span>
        </div>
        <span className="ml-1 font-mono text-[11px] text-subtle">epic sequence · blocks · dagre</span>
      </header>
      <ProjectGraph slug={slug} />
    </div>
  );
}
