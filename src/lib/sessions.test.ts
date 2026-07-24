/**
 * anton-3nty: the shared job-session bootstrap. execute-epic / review-fix / nightly-stringer all
 * start their claude session through startJobSession — these pin the row it persists and the
 * `[type] text` log lines its onEvent appender writes (including the fail-soft catch), so the
 * three jobs can't drift apart again.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "./db/testing";
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
