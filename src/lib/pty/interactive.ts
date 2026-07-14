import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/db";
import { systemClock } from "@/lib/jobs/queue";
import { createSession, endSession } from "@/lib/sessions";
import type { Project } from "@/lib/types";

import { getPtyManager, CLAUDE_BIN_ENV } from "./manager";

export interface StartInteractiveInput {
  /** Args passed to the claude bin (never the bin itself — that's always claude). */
  args?: string[];
  cols?: number;
  rows?: number;
  beadId?: string;
  runId?: string;
}

/**
 * Spawn an interactive `claude` pty for a project and register its `sessions` row. The `sessions`
 * row (kind: interactive) is created before the spawn so history/diagnostics see it; if the pty
 * fails to spawn (e.g. claude not on PATH) the row is marked failed and the error re-thrown.
 *
 * Shared by the generic interactive spawn route and the `/shape` spawn route (anton-bm4.2) so the
 * session ↔ pty wiring lives in one place. Returns the new session id (used by the SSE routes).
 */
export async function startInteractiveSession(
  project: Project,
  input: StartInteractiveInput,
): Promise<string> {
  const sessionId = randomUUID();
  const db = getDb();

  await createSession(db, systemClock, {
    id: sessionId,
    projectId: project.id,
    kind: "interactive",
    beadId: input.beadId,
    runId: input.runId,
  });

  const bin = process.env[CLAUDE_BIN_ENV] ?? "claude";
  try {
    getPtyManager().spawn({
      sessionId,
      file: bin,
      args: input.args ?? [],
      cwd: project.repoPath,
      env: { ...process.env, TERM: "xterm-256color" },
      cols: input.cols ?? 80,
      rows: input.rows ?? 24,
    });
  } catch (err) {
    await endSession(db, systemClock, sessionId, "failed");
    throw err;
  }

  return sessionId;
}
