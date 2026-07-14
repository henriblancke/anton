import { z } from "zod";

import { getProjectBySlug } from "@/lib/projects";
import { startInteractiveSession } from "@/lib/pty/interactive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Spawn an interactive `claude` pty for a project (anton-bm4.1). The pty runs in the project's repo
 * with a real terminal; its output streams to the browser xterm over `GET …/pty` and keystrokes
 * come back over `POST …/pty`. The binary is always the claude bin (never client-chosen) — the
 * caller only supplies args (e.g. a `/shape` invocation, wired by bm4.2), initial size, and links.
 *
 * The session row + pty wiring lives in {@link startInteractiveSession}, shared with the `/shape`
 * spawn route.
 */
const spawnSchema = z.object({
  args: z.array(z.string()).max(64).optional(),
  cols: z.number().int().min(1).max(1000).optional(),
  rows: z.number().int().min(1).max(1000).optional(),
  beadId: z.string().min(1).max(200).optional(),
  runId: z.string().min(1).max(200).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const project = await getProjectBySlug(slug);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  let body: z.infer<typeof spawnSchema> = {};
  try {
    const raw = await request.json();
    body = spawnSchema.parse(raw ?? {});
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: "Invalid request", issues: err.issues }, { status: 400 });
    }
    // No/invalid JSON body → spawn with defaults.
  }

  try {
    const sessionId = await startInteractiveSession(project, body);
    return Response.json({ sessionId }, { status: 201 });
  } catch (err) {
    // Spawn failed (e.g. claude not on PATH) — the session was already marked failed.
    return Response.json(
      { error: `Failed to start pty: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
