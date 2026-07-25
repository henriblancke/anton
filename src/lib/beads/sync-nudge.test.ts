/**
 * Unit coverage for the write-sync nudge (anton-nowq): every operator board write must schedule BOTH
 * propagation paths — the immediate fire-and-forget push AND the durable, deduped sync-push job —
 * and neither may surface into the caller's request. The durable half is the one that only shows up
 * in production, where a failed enqueue is swallowed: assert here that the job row actually lands,
 * so the backstop can't silently regress to "logged an error".
 *
 * Runs against a real temp anton.db (ANTON_DB is set before `../db` is imported, since `getDb()`
 * resolves the path once, at first use).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { applyMigrationsTo } from "../db/testing";

const PROJECT_ID = "p-nudge";
const REPO = "/tmp/anton-nudge-repo";

let dir: string;
let prevDb: string | undefined;
let nudgeSync: typeof import("./sync-nudge").nudgeSync;
let getDb: typeof import("../db").getDb;
let schema: typeof import("../db/schema");
let beads: typeof import("./bd").beads;

describe("nudgeSync", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "anton-nudge-db-"));
    prevDb = process.env.ANTON_DB;
    process.env.ANTON_DB = join(dir, "anton.db");

    const sqlite = new Database(process.env.ANTON_DB);
    applyMigrationsTo(sqlite);
    sqlite.close();

    ({ nudgeSync } = await import("./sync-nudge"));
    ({ getDb } = await import("../db"));
    schema = await import("../db/schema");
    ({ beads } = await import("./bd"));

    getDb()
      .insert(schema.projects)
      .values({ id: PROJECT_ID, slug: "nudge", name: "nudge", repoPath: REPO })
      .run();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevDb === undefined) delete process.env.ANTON_DB;
    else process.env.ANTON_DB = prevDb;
  });

  beforeEach(() => {
    getDb().delete(schema.jobs).run();
    vi.restoreAllMocks();
  });

  const queuedPushes = () =>
    getDb()
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.type, "sync-push"))
      .all();

  it("fires the immediate push and queues the durable backstop for the repo", () => {
    const sync = vi.spyOn(beads, "sync").mockResolvedValue(undefined);

    nudgeSync({ id: PROJECT_ID, repoPath: REPO });

    expect(sync).toHaveBeenCalledWith(REPO);
    const jobs = queuedPushes();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("queued");
    expect(jobs[0].projectId).toBe(PROJECT_ID);
  });

  it("collapses a burst of writes onto one queued push job", () => {
    vi.spyOn(beads, "sync").mockResolvedValue(undefined);

    nudgeSync({ id: PROJECT_ID, repoPath: REPO });
    nudgeSync({ id: PROJECT_ID, repoPath: REPO });
    nudgeSync({ id: PROJECT_ID, repoPath: REPO });

    expect(queuedPushes()).toHaveLength(1);
  });

  it("logs a rejected immediate push without surfacing it — the job still covers the write", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(beads, "sync").mockRejectedValue(new Error("remote unreachable"));

    expect(() => nudgeSync({ id: PROJECT_ID, repoPath: REPO }, "epic-detail")).not.toThrow();
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget `.catch` run

    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("[epic-detail] beads dolt sync failed"),
      expect.any(Error),
    );
    expect(queuedPushes()).toHaveLength(1);
  });

  it("logs an enqueue failure instead of failing the caller's write", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(beads, "sync").mockResolvedValue(undefined);

    // No such project row — the jobs FK rejects the insert, exactly as an unknown/removed project
    // would at runtime. The local write already landed, so the caller must never see this.
    expect(() => nudgeSync({ id: "ghost", repoPath: REPO }, "board-move")).not.toThrow();

    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("[board-move] enqueue sync-push failed"),
      expect.anything(),
    );
    expect(queuedPushes()).toHaveLength(0);
  });
});
