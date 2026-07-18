import { getSessionById, sessionLogPath, tailSessionLog } from "@/lib/sessions";
import { resolveProject } from "../../../resolve-project";

export const dynamic = "force-dynamic";
// The tail loop runs for the life of the session; never let the platform buffer/cap it.
export const maxDuration = 3600;

/**
 * Server-Sent Events stream of a session's log. Replays the existing log, then tails live appends
 * until the session goes terminal (or the client disconnects). Frames:
 *   event: log   data: <chunk>   — appended log text
 *   event: end   data: <status>  — session finished; stream closing
 * A finished session simply replays its whole log then ends immediately — the same endpoint backs
 * both the live terminal and history/diagnostics replay.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; sessionId: string }> },
) {
  const { slug, sessionId } = await params;

  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  const session = await getSessionById(sessionId);
  if (!session || session.projectId !== project.id) {
    return new Response("Session not found", { status: 404 });
  }

  const logPath = session.logPath ?? sessionLogPath(sessionId);
  const encoder = new TextEncoder();

  // Re-read status each poll so a session that finishes mid-stream ends the tail promptly.
  const isDone = async (): Promise<boolean> => {
    const fresh = await getSessionById(sessionId);
    return !fresh || fresh.status !== "running";
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: string) => {
        // SSE: one `data:` line per log line so multi-line chunks stay framed correctly.
        const payload = data
          .split("\n")
          .map((line) => `data: ${line}`)
          .join("\n");
        controller.enqueue(encoder.encode(`event: ${event}\n${payload}\n\n`));
      };

      try {
        for await (const chunk of tailSessionLog(logPath, {
          isDone,
          signal: request.signal,
        })) {
          if (chunk.type === "data") send("log", chunk.text);
          else send("end", session.status === "running" ? "done" : session.status);
        }
      } catch {
        // Client disconnect surfaces as an aborted read; nothing to report.
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by the client — ignore.
        }
      }
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
}
