import { z } from "zod";

import { getRunningJobInfo } from "@/lib/jobs/service";
import { startInteractiveSession } from "@/lib/pty/interactive";
import { resolveProject } from "../../resolve-project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Spawn an interactive `claude` pty for a project (anton-bm4.1). The pty runs in the project's repo
 * with a real terminal; its output streams to the browser xterm over `GET …/pty` and keystrokes
 * come back over `POST …/pty`. The binary is always the claude bin (never client-chosen) — the
 * caller only supplies args (e.g. a `/shape` invocation, wired by bm4.2), initial size, and links.
 *
 * `jobId` roots the pty at a running job's reported cwd instead of the repo (investigate,
 * anton-gjhu). The cwd is resolved server-side from the runner's live job handle — the client can
 * name a job but never pick a directory. It's a separate pty session, so it never touches the
 * headless job's own process.
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
  jobId: z.string().min(1).max(200).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const { project, response } = await resolveProject(slug);
  if (!project) return response;

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

  // Investigating a job only makes sense while it's in flight here with a reported cwd — a
  // settled (or other-machine) job has no live directory to drop into, so fail loud with 409
  // rather than silently opening a terminal in the wrong place.
  let cwd: string | undefined;
  if (body.jobId) {
    const info = await getRunningJobInfo(project.id, body.jobId);
    if (!info?.cwd) {
      return Response.json(
        { error: "Job is not running on this instance or has not reported a working directory" },
        { status: 409 },
      );
    }
    cwd = info.cwd;
  }

  try {
    const sessionId = await startInteractiveSession(project, {
      args: body.args,
      cols: body.cols,
      rows: body.rows,
      beadId: body.beadId,
      runId: body.runId,
      cwd,
    });
    return Response.json({ sessionId }, { status: 201 });
  } catch (err) {
    // Spawn failed (e.g. claude not on PATH) — the session was already marked failed.
    return Response.json(
      { error: `Failed to start pty: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
