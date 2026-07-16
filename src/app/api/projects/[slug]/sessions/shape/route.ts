import { z } from "zod";

import { buildShapeArgs } from "@/lib/claude/shape";
import { loadSkill } from "@/lib/claude/prompt";
import { startInteractiveSession } from "@/lib/pty/interactive";
import { resolveProject } from "../../resolve-project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Spawn an interactive `/shape` pty for a project (anton-bm4.2). Same session/pty machinery as the
 * generic interactive route, but the args are built server-side: the vendored `shape` skill is
 * seeded via `--append-system-prompt` and the founder's initial description opens the conversation.
 * The client only supplies the description + terminal size — never the prompt or the binary.
 */
const shapeSchema = z.object({
  description: z.string().max(8000).optional(),
  cols: z.number().int().min(1).max(1000).optional(),
  rows: z.number().int().min(1).max(1000).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  let body: z.infer<typeof shapeSchema> = {};
  try {
    const raw = await request.json();
    body = shapeSchema.parse(raw ?? {});
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: "Invalid request", issues: err.issues }, { status: 400 });
    }
    // No/invalid JSON body → shape with no seed description.
  }

  let shapeSkillBody: string;
  try {
    shapeSkillBody = await loadSkill("shape");
  } catch (err) {
    // Fail loud: the shaping session is meaningless without its skill.
    return Response.json(
      { error: `shape skill unavailable: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  const args = buildShapeArgs(shapeSkillBody, body.description);
  try {
    const sessionId = await startInteractiveSession(project, {
      args,
      cols: body.cols,
      rows: body.rows,
    });
    return Response.json({ sessionId }, { status: 201 });
  } catch (err) {
    return Response.json(
      { error: `Failed to start pty: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
