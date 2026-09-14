import { notFound } from "next/navigation";

import { getProjectBySlug } from "@/lib/projects";
import { getProjectHealth } from "@/lib/health";
import { HealthReport } from "@/components/health/health-report";

export const dynamic = "force-dynamic";

export default async function ProjectHealthPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();

  const health = await getProjectHealth(project);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-6">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">{project.name}</span>
          <span className="text-subtle">/</span>
          <span className="font-medium text-foreground">Health</span>
        </div>
        <span className="ml-1 font-mono text-[11px] text-subtle">
          patrol · scan trend · review trajectory
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-[18px]">
        <HealthReport slug={slug} health={health} />
      </div>
    </div>
  );
}
