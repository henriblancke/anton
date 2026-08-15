/**
 * The preamble the board passes share (anton-l4do): resolve the project or poison the job, pull
 * before reading, and open the session the pass speaks through.
 *
 * The session half is the part worth its own suite. A pass that writes no run row is reachable from
 * the jobs page ONLY through the durable `jobId` link on its session (anton-lmps), and the gardener
 * opens its row lazily — so "a silent patrol leaves no empty session" and "a settled pass is still
 * reachable" are properties that have to hold together.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as schema from "../db/schema";
import { makeTestDb, type TestDb } from "../db/testing";
import { PoisonError } from "./errors";
import { fakeJobContext } from "./pass.fixture";
import type { Clock } from "./queue";

const pullMock = vi.fn<(cwd: string) => Promise<void>>();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return { ...actual, beads: { ...actual.beads, pull: (...a: [string]) => pullMock(...a) } };
});

const { deferPassSession, openPassSession, passProject, pullBoard } =
  await import("./pass-preamble");

const REPO = "/tmp/pass-preamble-repo";
const clock: Clock = { now: () => 1_700_000_000_000 };

let t: TestDb;
let projectId: string;
let sessionsDir: string;
let priorSessionsRoot: string | undefined;

beforeEach(async () => {
  sessionsDir = mkdtempSync(join(tmpdir(), "anton-pass-preamble-"));
  priorSessionsRoot = process.env.ANTON_SESSIONS_ROOT;
  process.env.ANTON_SESSIONS_ROOT = join(sessionsDir, "sessions");
  t = makeTestDb();
  projectId = randomUUID();
  await t.db.insert(schema.projects).values({
    id: projectId,
    slug: "sandbox",
    name: "sandbox",
    repoPath: REPO,
    defaultBranch: "main",
  });
  pullMock.mockResolvedValue(undefined);
});

afterEach(() => {
  t.close();
  vi.clearAllMocks();
  if (priorSessionsRoot === undefined) delete process.env.ANTON_SESSIONS_ROOT;
  else process.env.ANTON_SESSIONS_ROOT = priorSessionsRoot;
  rmSync(sessionsDir, { recursive: true, force: true });
});

/** The queued job a pass runs under — the row its session's durable link points at. */
async function enqueue(jobId: string, type = "gardener"): Promise<void> {
  await t.db.insert(schema.jobs).values({ id: jobId, type, projectId });
}

/** The one session row a pass leaves, or undefined for a pass that opened none. */
async function sessionRow() {
  const [row] = await t.db.select().from(schema.sessions);
  return row;
}

/** What a session wrote to disk. A row with no log path is a broken session, not an empty one. */
function sessionText(logPath: string | null): string {
  if (!logPath) throw new Error("the session row carries no log path");
  return readFileSync(logPath, "utf8");
}

describe("passProject", () => {
  it("hands back the project the pass runs for", async () => {
    expect((await passProject(t.db, projectId)).repoPath).toBe(REPO);
  });

  it("poisons the job when the project is gone — a retry can never find it", async () => {
    await t.db.delete(schema.projects);
    await expect(passProject(t.db, projectId)).rejects.toBeInstanceOf(PoisonError);
  });
});

describe("pullBoard", () => {
  it("pulls the shared board before the pass reads it", async () => {
    await pullBoard(REPO, () => expect.unreachable("the pull succeeded"));
    expect(pullMock).toHaveBeenCalledWith(REPO);
  });

  it("hands the failure to the caller instead of costing the pass its run", async () => {
    const boom = new Error("remote unreachable");
    pullMock.mockRejectedValue(boom);
    const seen: unknown[] = [];

    await pullBoard(REPO, (e) => {
      seen.push(e);
    });

    // The error itself, not a message: the gardener logs the stack and product-master logs the text.
    expect(seen).toEqual([boom]);
  });

  it("awaits an async reporter, so the pass's log line lands before it moves on", async () => {
    pullMock.mockRejectedValue(new Error("remote unreachable"));
    let settled = false;
    await pullBoard(REPO, async () => {
      await Promise.resolve();
      settled = true;
    });
    expect(settled).toBe(true);
  });
});

describe("deferPassSession", () => {
  it("leaves no row for a pass that never speaks", async () => {
    const ctx = fakeJobContext();
    const session = deferPassSession(t.db, clock, { ctx, projectId, kind: "gardener" });

    await session.end("done");

    expect(await sessionRow()).toBeUndefined();
    expect(ctx.reported).toEqual([]);
  });

  it("opens on the first write, links it to the job, and reports the live handle", async () => {
    await enqueue("job-7");
    const ctx = fakeJobContext({ jobId: "job-7" });
    const session = deferPassSession(t.db, clock, { ctx, projectId, kind: "gardener" });

    await session.log("SHADOW p-1 would close t-4\n");
    await session.log("and nothing else\n");
    await session.end("done");

    const row = await sessionRow();
    expect(row.kind).toBe("gardener");
    expect(row.projectId).toBe(projectId);
    // The durable half of the link: the runner's live handle dies with the job, so a patrol that
    // ran at 03:00 is reachable the next morning only through this column.
    expect(row.jobId).toBe("job-7");
    expect(row.status).toBe("done");
    expect(sessionText(row.logPath)).toBe("SHADOW p-1 would close t-4\nand nothing else\n");
    // Reported once, on the write that opened the row — not on every line after it.
    expect(ctx.reported).toEqual([{ sessionId: row.id }]);
  });

  it("settles failed for a pass that broke after it had spoken", async () => {
    await enqueue("job-1");
    const session = deferPassSession(t.db, clock, {
      ctx: fakeJobContext(),
      projectId,
      kind: "gardener",
    });
    await session.log("half a record\n");
    await session.end("failed");

    expect((await sessionRow()).status).toBe("failed");
  });
});

describe("openPassSession", () => {
  it("opens up front and names the cwd its claude session runs in", async () => {
    await enqueue("job-9", "product-master");
    const ctx = fakeJobContext({ jobId: "job-9", type: "product-master" });
    const session = await openPassSession(t.db, clock, {
      ctx,
      projectId,
      kind: "product-master",
      cwd: REPO,
    });

    const row = await sessionRow();
    expect(row.status).toBe("running");
    expect(row.jobId).toBe("job-9");
    expect(ctx.reported).toEqual([{ sessionId: session.sessionId, cwd: REPO }]);

    session.onEvent({ type: "assistant", text: "thinking" });
    await session.log("[product-master] 0 claim(s) reported\n");
    await session.end("done");

    expect(sessionText(row.logPath)).toContain("[product-master] 0 claim(s) reported\n");
    expect((await sessionRow()).status).toBe("done");
  });
});
