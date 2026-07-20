import { NextResponse } from "next/server";
import { deleteEpic, getEpicDetail } from "@/lib/epic-detail";
import { resolveProject } from "../../resolve-project";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; epicId: string }> },
) {
  const { slug, epicId } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  try {
    const detail = await getEpicDetail(project, epicId);
    return NextResponse.json({ detail });
  } catch {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ slug: string; epicId: string }> },
) {
  const { slug, epicId } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  try {
    await deleteEpic(project, epicId);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }
}
