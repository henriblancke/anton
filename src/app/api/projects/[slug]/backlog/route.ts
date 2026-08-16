import { NextResponse } from "next/server";
import { z } from "zod";

import { createDraftFeature, DraftContractError, DraftEpicError } from "@/lib/backlog";
import { AREA_SHAPE } from "@/lib/epic-patch";
import { resolveProject } from "../resolve-project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const section = z.string().trim().min(1).max(8000);

/**
 * The epic the feature attaches to: one already on the board, or one created in the same commit
 * from its own contract. There is no "none" case (anton-h1ds) — a parentless feature runs fine and
 * appears on no roadmap, so the refusal happens here rather than on the board afterwards.
 */
const epicSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), id: z.string().trim().min(1) }),
  z.object({
    kind: z.literal("new"),
    epic: z.object({
      title: z.string().trim().min(1).max(200),
      goal: section,
      successCriteria: section,
      area: z
        .string()
        .trim()
        .regex(AREA_SHAPE, "expected a label-safe value — letters, digits, . _ -"),
    }),
  }),
]);

/**
 * Accept a shaping draft and create the open (unapproved) FEATURE bead in backlog, under its epic
 * (anton-h1ds). This is the "Send to backlog" action of the Add-work screen: the interactive
 * `/shape` pty forms the draft, and this commit turns the founder's accepted draft into real beads
 * via `bd`. A feature — one worktree, one PR — is what anton runs, so this producer and the `/shape`
 * CLI producer now emit the same shape.
 *
 * Every field of the contract is REQUIRED here (anton-8mnr): the bead is rendered from the project's
 * bead formula, so what lands passes `validateBeadContract` by construction rather than arriving
 * unshaped for the board to flag. Non-empty is not enough — a field holding the formula's own TODO
 * prompt reads as unwritten, so `createDraftFeature` judges the rendered skeletons with the
 * validator and refuses (422 here) before any bead exists. `area:` uses the epic dialog's own
 * label-shape check so both write paths accept exactly the same vocabulary.
 */
const draftSchema = z.object({
  feature: z.object({
    title: z.string().trim().min(1).max(200),
    goal: section,
    acceptance: section,
    context: section,
    outOfScope: section,
    verify: section,
  }),
  epic: epicSchema,
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
    const created = await createDraftFeature(project, draft);
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    // An unusable epic is a question for the founder (pick another), not a bd failure — 400, so the
    // panel keeps the draft and says which epic it could not use.
    if (err instanceof DraftEpicError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof DraftContractError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    return NextResponse.json(
      { error: `Failed to create bead: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
