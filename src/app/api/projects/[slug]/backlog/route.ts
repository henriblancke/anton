import { NextResponse } from "next/server";
import { z } from "zod";

import { createDraftEpic, DraftContractError } from "@/lib/backlog";
import { AREA_SHAPE } from "@/lib/epic-patch";
import { resolveProject } from "../resolve-project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Accept a shaping draft and create the open (unapproved) epic bead in backlog (anton-bm4.2). This
 * is the "Send to backlog" action of the Add-work screen: the interactive `/shape` pty forms the
 * draft, and this commit turns the founder's accepted draft into a real bead via `bd`.
 *
 * Every field of the epic contract is REQUIRED here (anton-8mnr): the bead is rendered from the
 * project's bead formula, so what lands passes `validateBeadContract` by construction rather than
 * arriving unshaped for the board to flag. Non-empty is not enough — a field holding the formula's
 * own TODO prompt reads as unwritten, so `createDraftEpic` judges the rendered skeleton with the
 * validator and refuses (422 here) before any bead exists. `area:` uses the epic dialog's own
 * label-shape check so both write paths accept exactly the same vocabulary.
 */
const draftSchema = z.object({
  title: z.string().trim().min(1).max(200),
  goal: z.string().trim().min(1).max(8000),
  successCriteria: z.string().trim().min(1).max(8000),
  area: z.string().trim().regex(AREA_SHAPE, "expected a label-safe value — letters, digits, . _ -"),
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
    if (err instanceof DraftContractError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    return NextResponse.json(
      { error: `Failed to create bead: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
