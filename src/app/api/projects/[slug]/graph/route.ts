import { NextResponse } from "next/server";
import { computeEpicGraph } from "@/lib/epic-graph";
import { listAllBeads } from "@/lib/tickets";
import { resolveProject } from "../resolve-project";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  const { epics, edges } = computeEpicGraph(await listAllBeads(project));
  return NextResponse.json({ epics, edges });
}
