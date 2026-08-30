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
  makeRevalidator,
  makeWorktreeReaperHandler,
  readBoardOrFail,
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
      outcome: "acted" as const,
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

describe("readBoardOrFail", () => {
  it("fails the pass when the board pull fails — a destructive sweep never judges from a stale board", async () => {
    // The failure mode this guards: another machine reopens a bead, this checkout's Dolt working set
    // still records it closed, and the sweep deletes the worktree and branch of live work.
    await expect(
      readBoardOrFail("/nonexistent-repo", async () => {
        throw new Error("failed to pull from origin/main");
      }),
    ).rejects.toThrow(/failed to pull/);
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
      showBead: async (_repo, id) => ({ status: board.find((b) => b.id === id)?.status ?? "open" }),
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

  it("FAILS the attempt when the sweep is cut short, after logging what it did release", async () => {
    await tdb.db.delete(schema.sessions).where(eq(schema.sessions.projectId, projectId));
    await tdb.db.delete(schema.runs).where(eq(schema.runs.projectId, projectId));
    const first = await createWorktree({ repoPath: repo, branch: "anton/anton-cut1" });
    const second = await createWorktree({ repoPath: repo, branch: "anton/anton-cut2" });
    for (const [beadId, wt] of [
      ["anton-cut1", first],
      ["anton-cut2", second],
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
      { id: "anton-cut1", status: "closed" },
      { id: "anton-cut2", status: "closed" },
    ] as Bead[];
    const controller = new AbortController();
    const handler = makeWorktreeReaperHandler({
      db: tdb.db,
      clock: systemClock,
      readBoard: async () => board,
      // The runner's no-progress timeout (or an operator's cancel) lands mid-sweep.
      lookupPr: async (_repo: string, branch: string) => {
        if (branch === second.branch) controller.abort();
        return {};
      },
      showBead: async (_repo, id) => ({ status: board.find((b) => b.id === id)?.status ?? "open" }),
    });

    try {
      // The runner only turns an aborted attempt into a failure when the handler THROWS: returning
      // the partial report marked the job successful and left the rest of the residue for tomorrow.
      await expect(
        handler({ ...ctx(await jobRow()), signal: controller.signal }),
      ).rejects.toThrow(/stopped before judging every candidate/);

      expect(existsSync(first.path)).toBe(false);
      expect(existsSync(second.path)).toBe(true);

      // What it did release is still accounted for — the retry must not re-report it.
      const sessions = await tdb.db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.projectId, projectId));
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("failed");
      expect(readFileSync(sessions[0].logPath!, "utf8")).toContain("anton/anton-cut1");
    } finally {
      await tdb.db.delete(schema.sessions).where(eq(schema.sessions.projectId, projectId));
      await tdb.db.delete(schema.runs).where(eq(schema.runs.projectId, projectId));
      execFileSync("git", ["-C", repo, "worktree", "remove", "--force", second.path]);
      execFileSync("git", ["-C", repo, "branch", "-D", second.branch]);
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

  it("leaves no session behind for a park that keeps both — a quota park is not a teardown", async () => {
    await tdb.db.delete(schema.sessions).where(eq(schema.sessions.projectId, projectId));
    const wt = await createWorktree({ repoPath: repo, branch: "anton/anton-prk" });
    const runId = randomUUID();
    await tdb.db.insert(schema.runs).values({
      id: runId,
      projectId,
      epicBeadId: "anton-prk",
      branch: wt.branch,
      worktreePath: wt.path,
      status: "parked",
    });

    const entry = await releaseRunResources({
      db: tdb.db,
      clock: systemClock,
      ctx: ctx(await jobRow()),
      projectId,
      runId,
      repoPath: repo,
      worktree: wt,
      beadId: "anton-prk",
      status: "parked",
    });

    // The run resumes in this very worktree, so nothing was released — and a run that parks on a
    // usage limit many times must not accumulate one empty "skipped" row per attempt.
    expect(entry.outcome).toBe("kept");
    expect(existsSync(wt.path)).toBe(true);
    const sessions = await tdb.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.projectId, projectId));
    expect(sessions).toEqual([]);

    await tdb.db.delete(schema.runs).where(eq(schema.runs.id, runId));
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt.path]);
    execFileSync("git", ["-C", repo, "branch", "-D", wt.branch]);
  });

  it("re-reads run rows and the bead at deletion time — the sweep's snapshot is not the last word", async () => {
    await tdb.db.delete(schema.runs).where(eq(schema.runs.projectId, projectId));
    const candidate = {
      branch: "anton/anton-race",
      beadId: "anton-race",
      runLive: false,
      bead: "settled" as const,
    };
    const closed = async () => ({ status: "closed" });
    const revalidate = makeRevalidator({ db: tdb.db, projectId, repoPath: repo, showBead: closed });

    // Nothing live and the bead still closed: the plan the sweep made still holds.
    expect(await revalidate(candidate)).toBeUndefined();

    // The race the snapshot cannot see: a new run claims the branch while the `gh` lookup is in
    // flight, and its checkout is the one the sweep was about to force-remove.
    await tdb.db.insert(schema.runs).values({
      id: randomUUID(),
      projectId,
      epicBeadId: "anton-race",
      branch: candidate.branch,
      status: "running",
    });
    expect(await revalidate(candidate)).toContain("a run started on it during the sweep");
    await tdb.db.delete(schema.runs).where(eq(schema.runs.projectId, projectId));

    const reopened = makeRevalidator({
      db: tdb.db,
      projectId,
      repoPath: repo,
      showBead: async () => ({ status: "open" }),
    });
    expect(await reopened(candidate)).toContain("was reopened during the sweep");

    // Fail closed: a bead that cannot be re-read keeps its worktree and branch.
    const unreadable = makeRevalidator({
      db: tdb.db,
      projectId,
      repoPath: repo,
      showBead: async () => {
        throw new Error("bd is locked");
      },
    });
    expect(await unreadable(candidate)).toContain("could not be re-read");
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
