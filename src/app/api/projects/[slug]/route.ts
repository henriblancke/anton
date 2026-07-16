import { NextResponse } from "next/server";
import { deleteProject } from "@/lib/projects";
import { resolveProject } from "./resolve-project";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const { project, response } = await resolveProject(slug, `Project not found: ${slug}`);
  if (!project) return response;

  try {
    await deleteProject(slug);
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Teardown failed mid-way (residue, db error, …) — surface the service's message, never a
    // silent 200; the rows are kept so a retry can finish the job.
    const message = err instanceof Error ? err.message : "Failed to delete project";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
