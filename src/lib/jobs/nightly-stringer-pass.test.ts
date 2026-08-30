/**
 * Opening a nightly pass: a project that is gone parks the job rather than burning the runner's
 * retries, and a pass that does start reports the live handle (anton-susu) — the only route to an
 * in-flight scan, since nightly-stringer writes no run row.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "../db/schema";
import { makeTestDb, type TestDb } from "../db/testing";
import { PoisonError } from "./errors";
import { openPass } from "./nightly-stringer-pass";
import { fakeJobContext } from "./pass.fixture";
import type { Clock } from "./queue";

const clock: Clock = { now: () => 1_700_000_000_000 };

let t: TestDb;
let dir: string;
let priorSessionsRoot: string | undefined;
let projectId: string;

beforeEach(async () => {
  t = makeTestDb();
  dir = mkdtempSync(join(tmpdir(), "anton-stringer-pass-"));
  priorSessionsRoot = process.env.ANTON_SESSIONS_ROOT;
  process.env.ANTON_SESSIONS_ROOT = join(dir, "sessions");
  projectId = randomUUID();
  await t.db.insert(schema.projects).values({
    id: projectId,
    slug: "sandbox",
    name: "sandbox",
    repoPath: "/tmp/sandbox",
    defaultBranch: "main",
  });
});

afterEach(() => {
  t.close();
  if (priorSessionsRoot === undefined) delete process.env.ANTON_SESSIONS_ROOT;
  else process.env.ANTON_SESSIONS_ROOT = priorSessionsRoot;
  rmSync(dir, { recursive: true, force: true });
});

it("opens the session the pass speaks through and reports it as the live handle", async () => {
  const ctx = fakeJobContext({ type: "nightly-stringer", payload: { projectId } });

  const pass = await openPass(t.db, clock, ctx, projectId);
  await pass.log("[stringer] hello\n");
  await pass.end("done");

  expect(pass.project.slug).toBe("sandbox");
  expect(pass.triaged).toBe(false);
  expect(ctx.reported).toEqual([{ sessionId: pass.sessionId, cwd: "/tmp/sandbox" }]);
  expect(readFileSync(pass.logPath, "utf8")).toContain("[stringer] hello");

  const [row] = await t.db.select().from(schema.sessions);
  expect(row?.kind).toBe("nightly-stringer");
  expect(row?.status).toBe("done");
});

it("parks the job when the project is gone — no retry can find it", async () => {
  await t.db.delete(schema.projects);
  const ctx = fakeJobContext({ type: "nightly-stringer", payload: { projectId } });

  await expect(openPass(t.db, clock, ctx, projectId)).rejects.toBeInstanceOf(PoisonError);
});
