import { NextResponse } from "next/server";
import { deleteProject, getProjectBySlug } from "@/lib/projects";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) {
    return NextResponse.json({ error: `Project not found: ${slug}` }, { status: 404 });
  }

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
