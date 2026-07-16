import { NextResponse } from "next/server";
import { computeEpicGraph } from "@/lib/epic-graph";
import { getProjectBySlug } from "@/lib/projects";
import { listAllBeads } from "@/lib/tickets";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const { epics, edges } = computeEpicGraph(await listAllBeads(project));
  return NextResponse.json({ epics, edges });
}
