import { NextResponse } from "next/server";
import { getBoard } from "@/lib/board";
import { getProjectBySlug } from "@/lib/projects";

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

  const board = await getBoard(project);
  return NextResponse.json({ board });
}
