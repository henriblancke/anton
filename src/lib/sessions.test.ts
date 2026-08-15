/**
 * anton-3nty: the shared job-session bootstrap. execute-epic / review-fix / nightly-stringer all
 * start their claude session through startJobSession — these pin the row it persists and the
 * `[type] text` log lines its onEvent appender writes (including the fail-soft catch), so the
 * three jobs can't drift apart again.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { applyMigrationsTo, makeTestDb, type TestDb } from "./db/testing";
import { schema } from "./db";
import type { Clock } from "./jobs/queue";
import { sessionLogPath, startJobSession } from "./sessions";

class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
}

let dir: string;
let tdb: TestDb;
let projectId: string;
const clock = new FakeClock(1_700_000_000_000);
let priorSessionsRoot: string | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "anton-job-session-"));
  priorSessionsRoot = process.env.ANTON_SESSIONS_ROOT;
  process.env.ANTON_SESSIONS_ROOT = join(dir, "sessions");
  tdb = makeTestDb();
  projectId = randomUUID();
  await tdb.db.insert(schema.projects).values({
    id: projectId,
    slug: "sandbox",
    name: "sandbox",
    repoPath: dir,
    defaultBranch: "main",
  });
});

afterEach(() => {
  tdb.close();
  if (priorSessionsRoot === undefined) delete process.env.ANTON_SESSIONS_ROOT;
  else process.env.ANTON_SESSIONS_ROOT = priorSessionsRoot;
  rmSync(dir, { recursive: true, force: true });
});

describe("startJobSession", () => {
  it("persists a running session row with the derived log path", async () => {
    const { sessionId, logPath } = await startJobSession(tdb.db, clock, {
      projectId,
      kind: "nightly-stringer",
      beadId: "anton-xyz",
    });

    expect(logPath).toBe(sessionLogPath(sessionId));
    const rows = await tdb.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId,
      kind: "nightly-stringer",
      beadId: "anton-xyz",
      status: "running",
      logPath,
    });
  });

  it("records the job that opened the session, so a settled job still points at its log", async () => {
    await tdb.db.insert(schema.jobs).values({ id: "job-1", type: "gardener", projectId });

    const { sessionId } = await startJobSession(tdb.db, clock, {
      projectId,
      kind: "gardener",
      jobId: "job-1",
    });

    const [row] = await tdb.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId));
    expect(row.jobId).toBe("job-1");
  });

  it("onEvent appends `[type] text` lines (bare `[type]` when the event has no text)", async () => {
    const { logPath, onEvent } = await startJobSession(tdb.db, clock, {
      projectId,
      kind: "execute",
    });

    onEvent({ type: "assistant", text: "hello" });
    await expect.poll(() => readFile(logPath, "utf8").catch(() => "")).toBe("[assistant] hello\n");
    onEvent({ type: "result" });
    await expect
      .poll(() => readFile(logPath, "utf8"))
      .toBe("[assistant] hello\n[result]\n");
  });

  it("onEvent is fail-soft: an unwritable log never throws or rejects", async () => {
    // Make the sessions root un-creatable by putting a plain file where the dir should go.
    writeFileSync(join(dir, "blocker"), "");
    process.env.ANTON_SESSIONS_ROOT = join(dir, "blocker", "nested");

    const { onEvent } = await startJobSession(tdb.db, clock, {
      projectId,
      kind: "review-fix",
    });
    expect(() => onEvent({ type: "error", text: "boom" })).not.toThrow();
    // Give the swallowed rejection a tick to surface if the catch were missing (vitest would
    // fail the test on an unhandled rejection).
    await new Promise((r) => setTimeout(r, 20));
  });
});

/**
 * The jobs page's read (anton-lmps). It is the whole reason the link is persisted: the runner's live
 * handle is dropped when a job settles, so a finished gardener/product-master pass — the one whose
 * shadow record an operator reads the next morning — has nothing else pointing at its log. The path
 * rides along with the id (anton-hzce) because the page both streams that log and reads the pass's
 * record out of it, and one query is what stops the two from answering about different sessions.
 */
describe("sessionsByJob", () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "anton-session-links-"));
    process.env.ANTON_DB = join(workDir, "anton.db");
    const setup = new Database(process.env.ANTON_DB);
    applyMigrationsTo(setup);
    setup.close();

    // getDb() is lazy, so setting ANTON_DB above is enough — no module re-import needed.
    const { getDb, schema: dbSchema } = await import("./db");
    const db = getDb();
    await db
      .insert(dbSchema.projects)
      .values({ id: "p1", slug: "p1", name: "p1", repoPath: workDir });
    await db.insert(dbSchema.jobs).values([
      { id: "gardener-job", type: "gardener", projectId: "p1", status: "done" },
      { id: "resumed-job", type: "product-master", projectId: "p1", status: "done" },
      { id: "silent-job", type: "gardener", projectId: "p1", status: "done" },
    ]);
    await db.insert(dbSchema.sessions).values([
      {
        id: "s-gardener",
        projectId: "p1",
        jobId: "gardener-job",
        kind: "gardener",
        status: "done",
        logPath: "/logs/s-gardener.log",
        startedAt: new Date(1_700_000_000_000),
      },
      // A job that ran twice: the operator opening the row wants the latest attempt's log.
      {
        id: "s-first",
        projectId: "p1",
        jobId: "resumed-job",
        kind: "product-master",
        status: "done",
        logPath: "/logs/s-first.log",
        startedAt: new Date(1_700_000_000_000),
      },
      {
        id: "s-latest",
        projectId: "p1",
        jobId: "resumed-job",
        kind: "product-master",
        status: "done",
        logPath: "/logs/s-latest.log",
        startedAt: new Date(1_700_000_060_000),
      },
      // Unlinked (a session predating the link, or one opened outside a job) — never attributed.
      { id: "s-loose", projectId: "p1", kind: "interactive", status: "done" },
    ]);
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("resolves each job to its latest session, and a job that opened none to nothing", async () => {
    const { sessionsByJob } = await import("./sessions");
    expect(await sessionsByJob(["gardener-job", "resumed-job", "silent-job"])).toEqual({
      "gardener-job": { id: "s-gardener", logPath: "/logs/s-gardener.log" },
      "resumed-job": { id: "s-latest", logPath: "/logs/s-latest.log" },
    });
  });

  it("asks nothing of the DB for an empty page", async () => {
    const { sessionsByJob } = await import("./sessions");
    expect(await sessionsByJob([])).toEqual({});
  });
});

/**
 * The whole-log scan the jobs page reads a pass's record through (anton-hzce). Whole rather than
 * tailed because a product-master pass writes its revalidation tier's records BEFORE it streams a
 * claude transcript — a tail window drops exactly the unattended writes the record exists to show.
 */
describe("readSessionLogLines", () => {
  let scanDir: string;

  const write = (name: string, contents: string): string => {
    const path = join(scanDir, name);
    writeFileSync(path, contents);
    return path;
  };

  const keepPass = (line: string) => line.startsWith("[product-master]");

  beforeAll(() => {
    scanDir = mkdtempSync(join(tmpdir(), "anton-log-scan-"));
  });

  afterAll(() => {
    rmSync(scanDir, { recursive: true, force: true });
  });

  it("finds a line at the HEAD of a log far longer than any tail window", async () => {
    const { readSessionLogLines } = await import("./sessions");
    const path = write(
      "buried.log",
      "[product-master] APPLY p-1 (degraded-approval) unapprove t-1 — APPLIED: withdrew t-1\n" +
        "[assistant] a transcript comfortably past 256KB\n".repeat(20_000) +
        "[product-master] 0 claim(s) reported\n",
    );

    expect(await readSessionLogLines(path, keepPass)).toEqual({
      lines: [
        "[product-master] APPLY p-1 (degraded-approval) unapprove t-1 — APPLIED: withdrew t-1",
        "[product-master] 0 claim(s) reported",
      ],
      truncated: false,
    });
  });

  it("says so when it stops at the cap, rather than truncating quietly", async () => {
    const { readSessionLogLines } = await import("./sessions");
    const path = write("many.log", "[product-master] APPLIED something\n".repeat(10));

    expect(await readSessionLogLines(path, keepPass, 3)).toEqual({
      lines: Array(3).fill("[product-master] APPLIED something"),
      truncated: true,
    });
  });

  it("reads a log the disk no longer has as empty — `.anton` is disposable", async () => {
    const { readSessionLogLines } = await import("./sessions");

    expect(await readSessionLogLines(join(scanDir, "gone.log"), keepPass)).toEqual({
      lines: [],
      truncated: false,
    });
  });
});
