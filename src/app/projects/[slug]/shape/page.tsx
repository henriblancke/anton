import { notFound } from "next/navigation";

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

  return <ShapeView slug={slug} projectName={project.name} />;
}
