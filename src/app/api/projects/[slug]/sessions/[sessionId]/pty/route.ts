import { z } from "zod";

import { getSessionById } from "@/lib/sessions";
import { getPtyManager, type PtyEvent } from "@/lib/pty/manager";
import type { Project } from "@/lib/types";
import { notFoundResponse, withProject } from "../../../resolve-project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A shaping conversation runs for as long as the human keeps typing; never buffer/cap the stream.
export const maxDuration = 3600;

/**
 * Interactive pty transport for a session (anton-bm4.1):
 *   GET    → SSE stream of pty output. Replays the buffer, then follows live output until the pty
 *            exits or the client disconnects. Frames (data is base64 of UTF-8 bytes, so ANSI/control
 *            sequences survive intact): `event: data`, `event: exit`.
 *   POST   → send input to the pty. Body `{ type: "input", data }` (keystrokes) or
 *            `{ type: "resize", cols, rows }` (terminal geometry).
 *   DELETE → kill the pty and tear the session down.
 *
 * The session is scoped to its project: a session whose row belongs to another project 404s.
 */

/** Verify the session exists and belongs to the project. Returns a 404 Response to send if not. */
async function resolveSession(
  project: Project,
  sessionId: string,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const session = await getSessionById(sessionId);
  if (!session || session.projectId !== project.id) {
    return { ok: false, response: notFoundResponse("Session not found") };
  }
  return { ok: true };
}

export const GET = withProject<{ slug: string; sessionId: string }>(async (request, { project, params }) => {
  const { sessionId } = params;
  const resolved = await resolveSession(project, sessionId);
  if (!resolved.ok) return resolved.response;

  const manager = getPtyManager();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: string, data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the client — ignore.
        }
      };

      let detach: (() => void) | null = null;
      let detached = false;
      const detachAndClose = () => {
        if (!detached) {
          detached = true;
          detach?.();
          request.signal.removeEventListener("abort", detachAndClose);
        }
        close();
      };

      const onEvent = (evt: PtyEvent) => {
        if (evt.type === "data") {
          send("data", Buffer.from(evt.data, "utf8").toString("base64"));
        } else {
          send("exit", String(evt.exitCode));
          detachAndClose();
        }
      };

      const attach = manager.attach(sessionId, onEvent);
      if (!attach) {
        // The live pty is gone (never spawned, or reaped after exit). Report a clean end.
        send("exit", "0");
        close();
        return;
      }
      detach = attach.detach;

      // Repaint from the buffer, then either close (already exited) or follow live output.
      if (attach.replay) send("data", Buffer.from(attach.replay, "utf8").toString("base64"));
      if (attach.status === "exited") {
        send("exit", String(attach.exit?.exitCode ?? 0));
        detachAndClose();
        return;
      }

      request.signal.addEventListener("abort", detachAndClose, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

const inputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string() }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  }),
]);

export const POST = withProject<{ slug: string; sessionId: string }>(async (request, { project, params }) => {
  const { sessionId } = params;
  const resolved = await resolveSession(project, sessionId);
  if (!resolved.ok) return resolved.response;

  let body: z.infer<typeof inputSchema>;
  try {
    body = inputSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: "Invalid request", issues: err.issues }, { status: 400 });
    }
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const manager = getPtyManager();
  const ok =
    body.type === "input"
      ? manager.write(sessionId, body.data)
      : manager.resize(sessionId, body.cols, body.rows);

  if (!ok) {
    // No live pty (exited or reaped) — the client should stop writing.
    return Response.json({ error: "Session not live" }, { status: 409 });
  }
  return new Response(null, { status: 204 });
});

export const DELETE = withProject<{ slug: string; sessionId: string }>(async (_request, { project, params }) => {
  const { sessionId } = params;
  const resolved = await resolveSession(project, sessionId);
  if (!resolved.ok) return resolved.response;

  getPtyManager().kill(sessionId);
  return new Response(null, { status: 204 });
});
