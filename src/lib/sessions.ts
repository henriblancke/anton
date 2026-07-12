/**
 * Claude session persistence (anton-dzh.5). A session is one `claude` invocation (execute /
 * shape / review-fix): rows for history + diagnostics, plus an append-only log file the UI can
 * tail (SSE) or replay. db-injectable so the runner and tests share one connection.
 */
import { appendFile, mkdir, open, readFile, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { dirname, join } from "node:path";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { AntonDb, Clock } from "./jobs/queue";

export type SessionKind =
  | "shape"
  | "execute"
  | "review-fix"
  | "nightly-stringer"
  | "orphan-grooming"
  | "interactive";
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

/** JSON-friendly session shape for the run-detail API / timeline (epoch seconds, no Date). */
export interface SessionSummary {
  id: string;
  runId?: string;
  kind: SessionKind;
  beadId?: string;
  status: SessionStatus;
  startedAt?: number;
  endedAt?: number;
}

function sessionToEpoch(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  return Number(value);
}

export function toSessionSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    runId: row.runId ?? undefined,
    kind: row.kind as SessionKind,
    beadId: row.beadId ?? undefined,
    status: row.status as SessionStatus,
    startedAt: sessionToEpoch(row.startedAt),
    endedAt: sessionToEpoch(row.endedAt),
  };
}

/** Read path for the UI (uses the shared anton.db). */
export async function listSessions(projectId: string, runId?: string): Promise<SessionRow[]> {
  const db = getDb();
  const where = runId
    ? eq(schema.sessions.runId, runId)
    : eq(schema.sessions.projectId, projectId);
  return db.select().from(schema.sessions).where(where).orderBy(desc(schema.sessions.startedAt));
}

/** A single session by id (shared anton.db read path — for run detail + log stream). */
export async function getSessionById(id: string): Promise<SessionRow | undefined> {
  const rows = await getDb()
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, id))
    .limit(1);
  return rows[0];
}

/** Full current contents of a session log (replay for finished sessions / diagnostics). */
export async function readSessionLog(logPath: string): Promise<string> {
  try {
    return await readFile(logPath, "utf8");
  } catch (err) {
    // A session that hasn't emitted anything yet has no file — treat as empty, not an error.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/** One chunk from {@link tailSessionLog}: appended log bytes, or the terminal `end` marker. */
export type LogChunk = { type: "data"; text: string } | { type: "end" };

/**
 * Tail an append-only session log as an async iterable: yields the existing contents first, then
 * every subsequent append. Ends once `isDone()` reports the session is terminal AND the file has
 * been drained — or when `signal` aborts (client disconnect). Uses fs.watch with a poll fallback
 * so a missed change event (or a log created after we start) is still picked up.
 */
export async function* tailSessionLog(
  logPath: string,
  opts: { isDone: () => Promise<boolean>; signal?: AbortSignal; pollMs?: number } = {
    isDone: async () => true,
  },
): AsyncGenerator<LogChunk> {
  const pollMs = opts.pollMs ?? 1000;
  let offset = 0;

  const readFrom = async (): Promise<string> => {
    let size: number;
    try {
      size = (await stat(logPath)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
    if (size <= offset) {
      // File truncated/rotated under us — restart from the top.
      if (size < offset) offset = 0;
      else return "";
    }
    const handle = await open(logPath, "r");
    try {
      const length = size - offset;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, offset);
      offset = size;
      return buf.toString("utf8");
    } finally {
      await handle.close();
    }
  };

  // A promise that resolves whenever the file changes, the poll timer fires, or the client aborts.
  const nextTick = (watcher: ReturnType<typeof watch> | null): Promise<void> =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        watcher?.off("change", finish);
        opts.signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, pollMs);
      watcher?.on("change", finish);
      opts.signal?.addEventListener("abort", finish, { once: true });
    });

  let watcher: ReturnType<typeof watch> | null = null;
  try {
    // fs.watch throws if the file doesn't exist yet; poll-only until it appears.
    try {
      watcher = watch(logPath);
    } catch {
      watcher = null;
    }

    while (!opts.signal?.aborted) {
      const chunk = await readFrom();
      if (chunk) yield { type: "data", text: chunk };

      // Attach a watcher lazily once the file exists (log is created on first append).
      if (!watcher) {
        try {
          watcher = watch(logPath);
        } catch {
          watcher = null;
        }
      }

      if (await opts.isDone()) {
        // Drain any final bytes written between the last read and the done check, then stop.
        const tail = await readFrom();
        if (tail) yield { type: "data", text: tail };
        yield { type: "end" };
        return;
      }

      await nextTick(watcher);
    }
  } finally {
    watcher?.close();
  }
}
