import { NextResponse } from "next/server";
import { z } from "zod";

import { createDraftEpic } from "@/lib/backlog";
import { resolveProject } from "../resolve-project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Accept a shaping draft and create the open (unapproved) epic bead in backlog (anton-bm4.2). This
 * is the "Send to backlog" action of the Add-work screen: the interactive `/shape` pty forms the
 * draft, and this commit turns the founder's accepted title + goal into a real bead via `bd`.
 */
const draftSchema = z.object({
  title: z.string().trim().min(1).max(200),
  goal: z.string().trim().max(8000).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  let draft: z.infer<typeof draftSchema>;
  try {
    draft = draftSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request", issues: err.issues }, { status: 400 });
    }
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const id = await createDraftEpic(project, draft);
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to create bead: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
