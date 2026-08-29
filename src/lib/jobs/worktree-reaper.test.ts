/**
 * The janitor pass end to end (anton-hrun.1) — real git, real anton.db, an injected board — proving
 * the two things the pass is trusted on: it reclaims a closed bead's checkout and branch, and its
 * session log names everything it reaped AND everything it skipped, with why.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Bead } from "../beads/bd";
import * as schema from "../db/schema";
import { makeTestDb, type TestDb } from "../db/testing";
import { createWorktree, WORKTREES_ROOT_ENV } from "../git/worktree";
import {
  beadStateOf,
  makeWorktreeReaperHandler,
  reapSummary,
  releaseRunResources,
} from "./worktree-reaper";
import { systemClock } from "./queue";
import type { JobContext } from "./runner";

describe("beadStateOf", () => {
  const board = [
    { id: "a", status: "closed" },
    { id: "b", status: "open" },
  ] as Bead[];

  it("reads a closed bead as settled — an abandoned bead is a closed one", () => {
    expect(beadStateOf(board)("a")).toBe("settled");
  });

  it("reads an open bead as open, and a bead the board never carried as unknown", () => {
    expect(beadStateOf(board)("b")).toBe("open");
    expect(beadStateOf(board)("gone")).toBe("unknown");
  });
});

describe("reapSummary", () => {
  it("counts what was actually removed, not what was planned", () => {
    const entry = (over: object) => ({
      branch: "anton/x",
      reason: "r",
      worktreeRemoved: false,
      branchDeleted: false,
      ...over,
    });
    expect(
      reapSummary({
        reaped: [entry({ worktreeRemoved: true, branchDeleted: true }), entry({ branchDeleted: true })],
        skipped: [entry({})],
      }),
    ).toBe("reaped 1 worktree(s) and 2 branch(es); skipped 1");
  });
});

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const suite = has("git") ? describe : describe.skip;

suite("worktree-reaper job (real git · real anton.db)", () => {
  let repo: string;
  let worktreesRoot: string;
  let sessionsRoot: string;
  let prevRoot: string | undefined;
  let prevSessions: string | undefined;
  let tdb: TestDb;
  const projectId = randomUUID();

  /** A job row per context: `sessions.job_id` is a real FK, so the pass's log needs one to hang off. */
  const jobRow = async (): Promise<string> => {
    const jobId = randomUUID();
    await tdb.db.insert(schema.jobs).values({
      id: jobId,
      type: "worktree-reaper",
      projectId,
      payloadJson: JSON.stringify({ projectId }),
      status: "running",
    });
    return jobId;
  };

  const ctx = (jobId: string): JobContext => ({
    jobId,
    type: "worktree-reaper",
    projectId,
    payload: { projectId },
    attempt: 1,
    heartbeat: async () => {},
    signal: new AbortController().signal,
    report: () => {},
  });

  beforeAll(async () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "anton-reaper-job-repo-")));
    worktreesRoot = realpathSync(mkdtempSync(join(tmpdir(), "anton-reaper-job-root-")));
    sessionsRoot = realpathSync(mkdtempSync(join(tmpdir(), "anton-reaper-job-sessions-")));
    prevRoot = process.env[WORKTREES_ROOT_ENV];
    prevSessions = process.env.ANTON_SESSIONS_ROOT;
    process.env[WORKTREES_ROOT_ENV] = worktreesRoot;
    process.env.ANTON_SESSIONS_ROOT = sessionsRoot;

    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "anton-test"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "# tmp\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

    tdb = makeTestDb();
    await tdb.db.insert(schema.projects).values({
      id: projectId,
      slug: "reaper",
      name: "reaper",
      repoPath: repo,
      defaultBranch: "main",
    });
  });

  afterAll(() => {
    if (prevRoot === undefined) delete process.env[WORKTREES_ROOT_ENV];
    else process.env[WORKTREES_ROOT_ENV] = prevRoot;
    if (prevSessions === undefined) delete process.env.ANTON_SESSIONS_ROOT;
    else process.env.ANTON_SESSIONS_ROOT = prevSessions;
    tdb?.close();
    for (const dir of [repo, worktreesRoot, sessionsRoot]) rmSync(dir, { recursive: true, force: true });
  });

  it("reaps the closed bead's residue, skips the locked checkout, and logs both", async () => {
    const closed = await createWorktree({ repoPath: repo, branch: "anton/anton-qc8" });
    const locked = await createWorktree({ repoPath: repo, branch: "anton/anton-t96" });
    execFileSync("git", ["-C", repo, "worktree", "lock", "--reason", "supacode", locked.path]);

    for (const [beadId, wt] of [
      ["anton-qc8", closed],
      ["anton-t96", locked],
    ] as const) {
      await tdb.db.insert(schema.runs).values({
        id: randomUUID(),
        projectId,
        epicBeadId: beadId,
        branch: wt.branch,
        worktreePath: wt.path,
        status: "done",
      });
    }

    const board = [
      { id: "anton-qc8", status: "closed" },
      { id: "anton-t96", status: "closed" },
    ] as Bead[];
    const handler = makeWorktreeReaperHandler({
      db: tdb.db,
      clock: systemClock,
      readBoard: async () => board,
      lookupPr: async () => ({}),
    });

    try {
      await handler(ctx(await jobRow()));

      expect(existsSync(closed.path)).toBe(false);
      expect(existsSync(locked.path)).toBe(true);
      const branches = execFileSync(
        "git",
        ["-C", repo, "branch", "--format=%(refname:short)"],
        { encoding: "utf8" },
      );
      expect(branches).not.toContain("anton/anton-qc8");
      expect(branches).toContain("anton/anton-t96");

      // The session log is the operator-facing account: both decisions, by name, with the reason.
      const sessions = await tdb.db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.projectId, projectId));
      expect(sessions).toHaveLength(1);
      expect(sessions[0].kind).toBe("worktree-reaper");
      expect(sessions[0].status).toBe("done");
      const log = readFileSync(sessions[0].logPath!, "utf8");
      expect(log).toContain("reaped 1 worktree(s) and 1 branch(es); skipped 1");
      expect(log).toContain("anton/anton-qc8");
      expect(log).toContain(`skipped ${locked.path}: locked by another owner (supacode)`);
    } finally {
      execFileSync("git", ["-C", repo, "worktree", "unlock", locked.path]);
      execFileSync("git", ["-C", repo, "worktree", "remove", "--force", locked.path]);
      execFileSync("git", ["-C", repo, "branch", "-D", locked.branch]);
    }
  });

  it("puts a run's teardown account on the RUN's timeline, not on the job's stream", async () => {
    await tdb.db.delete(schema.sessions).where(eq(schema.sessions.projectId, projectId));
    const wt = await createWorktree({ repoPath: repo, branch: "anton/anton-tdn" });
    const runId = randomUUID();
    await tdb.db.insert(schema.runs).values({
      id: runId,
      projectId,
      epicBeadId: "anton-tdn",
      branch: wt.branch,
      worktreePath: wt.path,
      status: "done",
    });

    const jobId = await jobRow();
    const entry = await releaseRunResources({
      db: tdb.db,
      clock: systemClock,
      ctx: ctx(jobId),
      projectId,
      runId,
      repoPath: repo,
      worktree: wt,
      beadId: "anton-tdn",
      status: "done",
    });

    // No bd repo here, so the bead read fails and reads as unsettled: the checkout goes, the branch
    // stays. That is the teardown's own fail-closed rule, asserted in the git-layer suite.
    expect(entry).toMatchObject({ worktreeRemoved: true, branchDeleted: false });

    const sessions = await tdb.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.projectId, projectId));
    expect(sessions).toHaveLength(1);
    // The link is the whole point: job-linked sessions are the jobs page's stream for a job, and a
    // two-line cleanup must not become the execute-epic job's headline output.
    expect(sessions[0].runId).toBe(runId);
    expect(sessions[0].jobId).toBeNull();
    expect(readFileSync(sessions[0].logPath!, "utf8")).toContain(
      "worktree-reaper: run anton-tdn settled as done",
    );

    await tdb.db.delete(schema.sessions).where(eq(schema.sessions.projectId, projectId));
    await tdb.db.delete(schema.runs).where(eq(schema.runs.id, runId));
    // The kept branch is real residue the next test's sweep would find, so this one hands it back.
    execFileSync("git", ["-C", repo, "branch", "-D", wt.branch]);
  });

  it("writes no session at all when there is no residue to account for", async () => {
    await tdb.db.delete(schema.sessions).where(eq(schema.sessions.projectId, projectId));
    await tdb.db.delete(schema.runs).where(eq(schema.runs.projectId, projectId));
    execFileSync("git", ["-C", repo, "worktree", "prune"]);

    const handler = makeWorktreeReaperHandler({ db: tdb.db, readBoard: async () => [] });
    await handler(ctx(await jobRow()));

    const sessions = await tdb.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.projectId, projectId));
    expect(sessions).toEqual([]);
  });
});
