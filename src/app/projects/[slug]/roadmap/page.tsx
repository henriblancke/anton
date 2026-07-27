import { notFound } from "next/navigation";

import { getProjectBySlug } from "@/lib/projects";
import { getRoadmap } from "@/lib/roadmap";
import { RoadmapTable } from "@/components/roadmap/roadmap-table";

export const dynamic = "force-dynamic";

export default async function ProjectRoadmapPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();

  const rows = await getRoadmap(project);
  const shipped = rows.reduce((n, row) => n + row.shipped, 0);
  const features = rows.reduce((n, row) => n + row.features, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-6">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">{project.name}</span>
          <span className="text-subtle">/</span>
          <span className="font-medium text-foreground">Roadmap</span>
        </div>
        <span className="ml-1 font-mono text-[11px] text-subtle">
          {rows.length} epics · {shipped}/{features} features shipped
        </span>
      </header>
      <RoadmapTable slug={slug} rows={rows} />
    </div>
  );
}
