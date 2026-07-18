import { NextResponse } from "next/server";
import { moveCard } from "@/lib/board-move";
import { STAGES } from "@/lib/types";
import type { MoveRequest } from "@/lib/types";
import { resolveProject } from "../../../resolve-project";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; cardId: string }> },
) {
  const { slug, cardId } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  const body = (await request.json().catch(() => null)) as MoveRequest | null;
  if (!body || !STAGES.includes(body.toStage)) {
    return NextResponse.json({ error: "Invalid toStage" }, { status: 400 });
  }

  try {
    await moveCard(project, cardId, body.toStage);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Card not found";
    return NextResponse.json({ error: message }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
