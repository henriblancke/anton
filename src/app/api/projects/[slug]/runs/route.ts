import { NextResponse } from "next/server";
import { getProjectBySlug } from "@/lib/projects";
import { listRuns } from "@/lib/runs";

export const dynamic = "force-dynamic";

/** List every run for a project (active + history), newest activity first. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const runs = await listRuns(project.id);
  return NextResponse.json({ runs });
}
