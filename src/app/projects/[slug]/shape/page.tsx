import { notFound } from "next/navigation";

import { getKnownAreas } from "@/lib/backlog";
import { getProjectBySlug } from "@/lib/projects";
import { ShapeView } from "@/components/shape/shape-view";

export const dynamic = "force-dynamic";

export default async function ProjectShapePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();

  // Off the warm issue snapshot the board already reads — no extra bd spawn. Best-effort: a board
  // that can't be read costs the founder a suggestion list, never the ability to file work.
  const areas = await getKnownAreas(project).catch(() => []);

  return <ShapeView slug={slug} projectName={project.name} areas={areas} />;
}
