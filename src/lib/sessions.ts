/**
 * Claude session persistence (anton-dzh.5). A session is one `claude` invocation (execute /
 * shape / review-fix): rows for history + diagnostics, plus an append-only log file the UI can
 * tail (SSE) or replay. db-injectable so the runner and tests share one connection.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { createReadStream, watch } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { desc, eq, inArray } from "drizzle-orm";
import type { ClaudeEvent } from "./claude/driver";
import { getDb, schema } from "./db";
import type { AntonDb, Clock } from "./jobs/queue";

export type SessionKind =
  | "shape"
  | "execute"
  /** A pre-PR self-review round (anton-cbak); its fixes are recorded as `review-fix` sessions. */
  | "review"
  | "review-fix"
  | "nightly-stringer"
  | "orphan-grooming"
  /** A scheduled product-master pass (anton-d2sx) — judgment in, proposal beads out. */
  | "product-master"
  /**
   * A gardener patrol (anton-3nv7) that had something to say. The patrol runs no claude session, so
   * a row exists only for a pass with output to carry — today, its shadow records (anton-lmps).
   */
  | "gardener"
  /**
   * A worktree-reaper pass (anton-hrun.1) — or one run's own teardown — with worktrees or branches
   * to account for. Like the gardener it runs no claude session, so a row exists only when there is
   * something to report.
   */
  | "worktree-reaper"
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
  /** Queue job that opened this session — what makes its log reachable once the job settles. */
  jobId?: string;
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
    jobId: input.jobId,
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

/**
 * Persist Claude's own session id on the session row (anton-juar). Recorded as soon as it's known —
 * from the stream-json result on success, or from the `system` init event when a run dies mid-stream
 * — so a transient failure can be retried with `claude --resume <id>`. Best-effort by the caller;
 * a resume is bounded and falls back to a fresh spawn, so a missed write is never fatal.
 */
export async function setSessionClaudeId(
  db: AntonDb,
  id: string,
  claudeSessionId: string,
): Promise<void> {
  await db
    .update(schema.sessions)
    .set({ claudeSessionId })
    .where(eq(schema.sessions.id, id));
}

/**
 * Create a session's log file, empty. Called where the row is opened so the two come into being
 * together: a session row whose log is MISSING then means the log store broke, not that the session
 * had nothing to say — the distinction a pass's write budget fails closed on (jobs/pass-budget.ts).
 */
export async function createSessionLog(logPath: string): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await (await open(logPath, "a")).close();
}

/** Append a chunk to a session log, creating the parent dir on first write. */
export async function appendSessionLog(logPath: string, chunk: string): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, chunk);
}

/**
 * One claude event as log lines — EVERY physical line prefixed with its `[type]`, not just the first.
 *
 * A model's text runs to many lines, and the passes read their own records back out of this same log
 * (gardener/record.ts), where the only thing separating a write anton made from a sentence a model
 * wrote is the producer in front of it. Prefixing the event as a whole would leave every line after
 * the first bare — so an assistant that types `[product-master] APPLY …`, by accident or out of bead
 * text somebody wrote to be read this way, would have it read back as a real unattended board write
 * and counted against the pass's write cap (jobs/pass-budget.ts).
 */
export function sessionEventLines(type: string, text?: string): string {
  if (!text) return `[${type}]\n`;
  const lines = text.split("\n");
  // A trailing newline is the writer's own line break, not an empty line the reader has to see.
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => (line ? `[${type}] ${line}\n` : `[${type}]\n`)).join("");
}

export interface StartJobSessionInput {
  projectId: string;
  kind: SessionKind;
  runId?: string;
  /**
   * The queue job this session belongs to (`ctx.jobId`). Pass it for any job whose output the jobs
   * page is the surface for — the runner's live handle is dropped the moment the job settles, so an
   * unlinked session is unreachable from there afterwards (anton-lmps).
   */
  jobId?: string;
  beadId?: string;
}

export interface JobSession {
  sessionId: string;
  logPath: string;
  /**
   * Streams claude events to the session log as `[type] text` lines — one per physical line of the
   * event ({@link sessionEventLines}); fail-soft on write errors.
   */
  onEvent: (e: ClaudeEvent) => void;
}

/**
 * One-call session bootstrap for the run jobs (execute-epic / review-fix / nightly-stringer):
 * mint the session id + log path, persist the row, and return the shared `[type] text` log
 * appender — so the jobs don't each hand-roll the same closure and drift apart.
 */
export async function startJobSession(
  db: AntonDb,
  clock: Clock,
  input: StartJobSessionInput,
): Promise<JobSession> {
  const sessionId = randomUUID();
  const logPath = sessionLogPath(sessionId);
  await createSession(db, clock, { id: sessionId, logPath, ...input });
  const onEvent = (e: ClaudeEvent) => {
    void appendSessionLog(logPath, sessionEventLines(e.type, e.text)).catch(() => {});
  };
  return { sessionId, logPath, onEvent };
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

/** A job's durable handle on the sessions it opened: what to stream, and what to read. */
export interface JobSessionLink {
  /** The LATEST session — the attempt an operator opening the row is looking at. */
  id: string;
  /**
   * Where every attempt's log lives, OLDEST FIRST. A job that retried opened one session per
   * attempt, and each holds only what that attempt did: an attempt that applied proposals
   * unattended and then failed is a write nobody can see if the reader keeps the newest log alone.
   * Empty for a row written before the column, or by a caller that passed no path.
   */
  logPaths: string[];
}

/**
 * The sessions each of these jobs opened (shared anton.db read path — for the jobs page). This is the
 * DURABLE answer the runner's in-memory live handle cannot give: a settled job reports nothing, so
 * without this a finished pass's log — the gardener's shadow record among them — would be a file on
 * disk with no route to it.
 *
 * Carries the log PATHS as well as the id because the jobs page does two things with one job: it
 * streams the latest session's log on demand (by id, through the SSE route) and reads the pass's
 * whole record out of the logs server-side (anton-hzce). One query, so the two can never answer
 * about different sessions — and every ATTEMPT's log, because a retried job's record is all of them.
 */
export async function sessionsByJob(jobIds: string[]): Promise<Record<string, JobSessionLink>> {
  return linksByJob(getDb(), jobIds);
}

/**
 * One job's session logs, oldest first — the db-injectable half, for a handler that has to know what
 * the attempts BEFORE it already did (jobs/pass-budget.ts).
 */
export async function jobSessionLogPaths(db: AntonDb, jobId: string): Promise<string[]> {
  return (await linksByJob(db, [jobId]))[jobId]?.logPaths ?? [];
}

async function linksByJob(
  db: AntonDb,
  jobIds: string[],
): Promise<Record<string, JobSessionLink>> {
  if (jobIds.length === 0) return {};
  const rows = await db
    .select({
      id: schema.sessions.id,
      jobId: schema.sessions.jobId,
      logPath: schema.sessions.logPath,
    })
    .from(schema.sessions)
    .where(inArray(schema.sessions.jobId, jobIds))
    .orderBy(desc(schema.sessions.startedAt));
  const byJob: Record<string, JobSessionLink> = {};
  for (const row of rows) {
    if (!row.jobId) continue;
    // Newest first out of the query: the first row per job is the one to stream, and each older
    // attempt's log goes in FRONT of the list so the record reads in the order the pass wrote it.
    const link = (byJob[row.jobId] ??= { id: row.id, logPaths: [] });
    if (row.logPath) link.logPaths.unshift(row.logPath);
  }
  return byJob;
}

/** How many matched lines one scan keeps. Far above any real pass; a backstop, not a policy. */
export const MAX_SCANNED_LOG_LINES = 500;

export interface ScannedLogLines {
  lines: string[];
  /** The scan stopped at {@link MAX_SCANNED_LOG_LINES}. Never silent — the caller says so. */
  truncated: boolean;
  /**
   * The file could not be read, or not to the end — it is gone, or the read failed part-way. What
   * came back is an honest partial answer, never a complete one, and a caller that renders silence
   * as a result has to be able to tell the two apart.
   */
  unreadable: boolean;
}

/**
 * Every line of a session log that `keep` accepts — the WHOLE file, streamed.
 *
 * Whole rather than tailed, because a pass's records are not all at the end of its log: the
 * product-master pass writes its revalidation tier's APPLY lines BEFORE it streams a claude
 * transcript that can run to megabytes, so a tail window drops precisely the unattended writes the
 * record exists to show — and the page would then call that a clean pass. Streaming is what makes
 * reading it all affordable: the transcript is decoded and dropped line by line, and only what
 * `keep` accepts is ever held.
 *
 * A log that is gone (a disposable `.anton` cleared out from under the row) does not throw: the
 * record is commentary, and a page that threw over a missing one would cost the operator the job
 * list itself. It is not silent either — it comes back {@link ScannedLogLines.unreadable}, because
 * "this pass wrote nothing" and "we could not read what it wrote" are opposite answers, and only one
 * of them is a clean pass.
 */
export async function readSessionLogLines(
  logPath: string,
  keep: (line: string) => boolean,
  maxLines = MAX_SCANNED_LOG_LINES,
): Promise<ScannedLogLines> {
  const lines: string[] = [];
  let truncated = false;
  let unreadable = false;
  try {
    const stream = createReadStream(logPath, { encoding: "utf8" });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        if (!keep(line)) continue;
        if (lines.length >= maxLines) {
          truncated = true;
          break;
        }
        lines.push(line);
      }
    } finally {
      reader.close();
      stream.destroy();
    }
  } catch {
    // Whatever was read before the file went away is still the honest half of the answer — flagged
    // as the half it is, so no caller mistakes it for the whole.
    unreadable = true;
  }
  return { lines, truncated, unreadable };
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
