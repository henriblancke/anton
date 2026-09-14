import { randomUUID } from "node:crypto";

import {
  claudeRouting,
  routingEnvDelta,
  type ClaudeRouting,
  type RoutingEnvDelta,
} from "@/lib/claude/driver-routing";
import { getDb } from "@/lib/db";
import { systemClock } from "@/lib/jobs/queue";
import { getProjectSettings } from "@/lib/projects";
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
  /**
   * Working directory for the pty; defaults to the project's repoPath. The investigate flow
   * (anton-gjhu) passes a running job's reported cwd so the operator lands in the exact directory
   * the job is working in (e.g. its worktree). Callers must resolve this server-side — never from
   * client input directly.
   */
  cwd?: string;
  /**
   * Routing to pin the pty to, resolved from a LIVE run's captured settings snapshot (anton-7poz).
   * A headless run pins its routing at run start, so current project settings can drift mid-run; the
   * investigate flow passes the run's captured routing here so the terminal hits the SAME endpoint as
   * the headless session it debugs. Server-resolved from the live job handle — never client input.
   * Absent (generic / `/shape` spawns), the pty routes on the project's CURRENT settings.
   */
  routing?: ClaudeRouting;
}

/**
 * Fold a routing delta into a pty env: a string SETS the var, `undefined` DELETES it. The headless
 * driver hands the delta straight to `child_process.spawn`, which drops undefined-valued keys — but
 * node-pty's `_parseEnv` stringifies every own key, so a lingering `undefined` would reach the child
 * as the literal `ANTHROPIC_BASE_URL=undefined`. Deleting the key is what actually keeps an unrouted
 * project's terminal off anton's ambient gateway (anton-7poz).
 */
function applyRoutingDelta(env: NodeJS.ProcessEnv, delta: RoutingEnvDelta): NodeJS.ProcessEnv {
  for (const [key, value] of Object.entries(delta)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
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
    // Route the terminal exactly like the run it belongs to (anton-7poz). An investigate terminal
    // carries the live job's OWN captured routing, so it hits the run's endpoint even if project
    // settings changed since the run began. Absent one (generic / `/shape` spawns), resolve the
    // project's CURRENT settings through the SAME resolver, applied OVER anton's env — so an unrouted
    // project's pty never inherits a stray ambient ANTHROPIC_BASE_URL. Kept inside the guard so a
    // failed settings read marks the row failed rather than leaving it stuck `running`.
    const routing = input.routing ?? claudeRouting(await getProjectSettings(db, project.id));
    getPtyManager().spawn({
      sessionId,
      file: bin,
      args: input.args ?? [],
      cwd: input.cwd ?? project.repoPath,
      env: applyRoutingDelta(
        { ...process.env, TERM: "xterm-256color" },
        routingEnvDelta(routing),
      ),
      cols: input.cols ?? 80,
      rows: input.rows ?? 24,
    });
  } catch (err) {
    await endSession(db, systemClock, sessionId, "failed");
    throw err;
  }

  return sessionId;
}
