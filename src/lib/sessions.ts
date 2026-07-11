/**
 * Claude session persistence (anton-dzh.5). A session is one `claude` invocation (execute /
 * shape / review-fix): rows for history + diagnostics, plus an append-only log file the UI can
 * tail (SSE) or replay. db-injectable so the runner and tests share one connection.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { AntonDb, Clock } from "./jobs/queue";

export type SessionKind = "shape" | "execute" | "review-fix" | "interactive";
export type SessionStatus = "running" | "done" | "failed";

export type SessionRow = typeof schema.sessions.$inferSelect;

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

/** Where a session's append-only log lives. Under anton's own dir; disposable with anton.db. */
export function sessionLogPath(sessionId: string): string {
  const root = process.env.ANTON_SESSIONS_ROOT ?? join(process.cwd(), ".anton", "sessions");
  return join(root, `${sessionId}.log`);
}

export interface CreateSessionInput {
  id: string;
  projectId: string;
  runId?: string;
  kind: SessionKind;
  beadId?: string;
  logPath?: string;
}

export async function createSession(
  db: AntonDb,
  clock: Clock,
  input: CreateSessionInput,
): Promise<string> {
  await db.insert(schema.sessions).values({
    id: input.id,
    projectId: input.projectId,
    runId: input.runId,
    kind: input.kind,
    beadId: input.beadId,
    status: "running",
    logPath: input.logPath ?? sessionLogPath(input.id),
    startedAt: secDate(clock.now()),
  });
  return input.id;
}

export async function endSession(
  db: AntonDb,
  clock: Clock,
  id: string,
  status: SessionStatus,
): Promise<void> {
  await db
    .update(schema.sessions)
    .set({ status, endedAt: secDate(clock.now()) })
    .where(eq(schema.sessions.id, id));
}

/** Append a chunk to a session log, creating the parent dir on first write. */
export async function appendSessionLog(logPath: string, chunk: string): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, chunk);
}

/** Read path for the UI (uses the shared anton.db). */
export async function listSessions(projectId: string, runId?: string): Promise<SessionRow[]> {
  const db = getDb();
  const where = runId
    ? eq(schema.sessions.runId, runId)
    : eq(schema.sessions.projectId, projectId);
  return db.select().from(schema.sessions).where(where).orderBy(desc(schema.sessions.startedAt));
}
