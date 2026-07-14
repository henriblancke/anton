import { randomUUID } from "node:crypto";
import { z } from "zod";

import { getProjectBySlug } from "@/lib/projects";
import { getDb } from "@/lib/db";
import { createSession } from "@/lib/sessions";
import { systemClock } from "@/lib/jobs/queue";
import { getPtyManager, CLAUDE_BIN_ENV } from "@/lib/pty/manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Spawn an interactive `claude` pty for a project (anton-bm4.1). The pty runs in the project's repo
 * with a real terminal; its output streams to the browser xterm over `GET …/pty` and keystrokes
 * come back over `POST …/pty`. The binary is always the claude bin (never client-chosen) — the
 * caller only supplies args (e.g. a `/shape` invocation, wired by bm4.2), initial size, and links.
 *
 * We create the `sessions` row (kind: interactive) before spawning so history/diagnostics see it,
 * then hand the live pty to the process-wide manager.
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

  const sessionId = randomUUID();
  const db = getDb();

  await createSession(db, systemClock, {
    id: sessionId,
    projectId: project.id,
    kind: "interactive",
    beadId: body.beadId,
    runId: body.runId,
  });

  const bin = process.env[CLAUDE_BIN_ENV] ?? "claude";
  try {
    getPtyManager().spawn({
      sessionId,
      file: bin,
      args: body.args ?? [],
      cwd: project.repoPath,
      env: { ...process.env, TERM: "xterm-256color" },
      cols: body.cols ?? 80,
      rows: body.rows ?? 24,
    });
  } catch (err) {
    // Spawn failed (e.g. claude not on PATH) — mark the just-created session failed and surface it.
    const { endSession } = await import("@/lib/sessions");
    await endSession(db, systemClock, sessionId, "failed");
    return Response.json(
      { error: `Failed to start pty: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  return Response.json({ sessionId }, { status: 201 });
}
