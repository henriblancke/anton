import { NextResponse } from "next/server";
import { listRuns } from "@/lib/runs";
import { resolveProject } from "../resolve-project";

export const dynamic = "force-dynamic";

/** List every run for a project (active + history), newest activity first. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;
  const runs = await listRuns(project.id);
  return NextResponse.json({ runs });
}
