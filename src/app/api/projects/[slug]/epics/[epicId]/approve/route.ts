import { NextResponse } from "next/server";
import { getBoard } from "@/lib/board";
import { beads } from "@/lib/beads/bd";
import { getProjectBySlug } from "@/lib/projects";
import { STAGES } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string; epicId: string }> },
) {
  const { slug, epicId } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  await beads.approve(project.repoPath, epicId);

  const board = await getBoard(project);
  for (const stage of STAGES) {
    const epic = board.columns[stage].find((e) => e.id === epicId);
    if (epic) {
      return NextResponse.json({ epic });
    }
  }

  return NextResponse.json({ error: "Epic not found" }, { status: 404 });
}
