/**
 * Real-git integration for project teardown (anton-adt): seed a project with runs/jobs/schedules/
 * sessions and a real worktree, deleteProject, and assert every anton.db row is gone, the worktree
 * dir + branch are removed, and the repo working tree + `.beads/` are byte-identical. Skipped when
 * `git` isn't installed (mirrors src/lib/git/worktree.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const suite = has("git") ? describe : describe.skip;

let workDir: string;
let repo: string;
let worktreesRoot: string;
let prevRoot: string | undefined;
let deleteProject: typeof import("./projects").deleteProject;
let getDb: typeof import("./db").getDb;
let schema: typeof import("./db/schema");
let createWorktree: typeof import("./git/worktree").createWorktree;

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "anton-delete-project-"));
  worktreesRoot = mkdtempSync(join(tmpdir(), "anton-delete-wt-root-"));
  process.env.ANTON_DB = join(workDir, "anton.db");
  const wtMod = await import("./git/worktree");
  prevRoot = process.env[wtMod.WORKTREES_ROOT_ENV];
  process.env[wtMod.WORKTREES_ROOT_ENV] = worktreesRoot;
  createWorktree = wtMod.createWorktree;

  // Apply every committed migration to the temp anton.db (same approach as db/testing.ts, but
  // against the ANTON_DB file so the module-level getDb() singleton picks it up).
  const setup = new Database(process.env.ANTON_DB);
  const migrationsDir = join(process.cwd(), "drizzle");
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const raw = readFileSync(join(migrationsDir, file), "utf8");
    setup.exec(
      raw
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean)
        .join(";\n"),
    );
  }
  setup.close();

  // A real repo with a commit and a fake .beads/ export, to prove teardown leaves both untouched.
  repo = join(workDir, "repo");
  mkdirSync(repo, { recursive: true });
  gitIn(repo, ["init", "-q"]);
  gitIn(repo, ["config", "user.email", "t@example.com"]);
  gitIn(repo, ["config", "user.name", "anton-test"]);
  writeFileSync(join(repo, "README.md"), "# teardown target\n");
  gitIn(repo, ["add", "."]);
  gitIn(repo, ["commit", "-q", "-m", "init"]);
  mkdirSync(join(repo, ".beads"), { recursive: true });
  writeFileSync(join(repo, ".beads", "issues.jsonl"), '{"id":"anton-1"}\n');

  const projectsMod = await import("./projects");
  deleteProject = projectsMod.deleteProject;
  const dbMod = await import("./db");
  getDb = dbMod.getDb;
  schema = await import("./db/schema");
});

afterAll(async () => {
  const { WORKTREES_ROOT_ENV } = await import("./git/worktree");
  if (prevRoot === undefined) delete process.env[WORKTREES_ROOT_ENV];
  else process.env[WORKTREES_ROOT_ENV] = prevRoot;
  rmSync(workDir, { recursive: true, force: true });
  rmSync(worktreesRoot, { recursive: true, force: true });
});

/** Seed a full project footprint: runs (with a real worktree), jobs, schedules, sessions + log. */
async function seedProject(slug: string) {
  const db = getDb();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: slug,
    repoPath: repo,
  });

  const branch = `anton/${slug}-run-1`;
  const wt = await createWorktree({ repoPath: repo, branch });

  const runId = randomUUID();
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    epicBeadId: "anton-epic-1",
    worktreePath: wt.path,
    branch,
    status: "done",
  });

  const nowSec = new Date(Math.floor(Date.now() / 1000) * 1000);
  const queuedJobId = randomUUID();
  const runningJobId = randomUUID();
  await db.insert(schema.jobs).values({
    id: queuedJobId,
    type: "execute-epic",
    projectId,
    payloadJson: JSON.stringify({ projectId, epicBeadId: "anton-epic-1" }),
    status: "queued",
    runAt: nowSec,
  });
  await db.insert(schema.jobs).values({
    id: runningJobId,
    type: "review-fix",
    projectId,
    status: "running",
    runAt: nowSec,
    leaseExpiresAt: new Date(nowSec.getTime() + 60_000),
  });

  await db.insert(schema.schedules).values({
    id: randomUUID(),
    projectId,
    type: "nightly-stringer",
    cron: "0 3 * * *",
  });

  const logPath = join(workDir, `${slug}-session.log`);
  writeFileSync(logPath, "session output\n");
  await db.insert(schema.sessions).values({
    id: randomUUID(),
    projectId,
    runId,
    kind: "execute",
    logPath,
  });

  return { projectId, wt, branch, logPath };
}

async function projectRowCounts(projectId: string) {
  const db = getDb();
  return {
    projects: (
      await db.select().from(schema.projects).where(eq(schema.projects.id, projectId))
    ).length,
    runs: (await db.select().from(schema.runs).where(eq(schema.runs.projectId, projectId))).length,
    jobs: (await db.select().from(schema.jobs).where(eq(schema.jobs.projectId, projectId))).length,
    schedules: (
      await db.select().from(schema.schedules).where(eq(schema.schedules.projectId, projectId))
    ).length,
    sessions: (
      await db.select().from(schema.sessions).where(eq(schema.sessions.projectId, projectId))
    ).length,
  };
}

suite("deleteProject (real git + temp anton.db)", () => {
  it("tears down worktrees, logs, and every anton.db row while leaving the repo + .beads pristine", async () => {
    const { projectId, wt, branch, logPath } = await seedProject("doomed");

    const statusBefore = gitIn(repo, ["status", "--porcelain"]);
    const headBefore = gitIn(repo, ["rev-parse", "HEAD"]);
    const beadsBefore = readFileSync(join(repo, ".beads", "issues.jsonl"));

    await deleteProject("doomed");

    // Every anton.db row for the project is gone (a "running" job row included — abortProject
    // removed the active rows, the final delete swept the rest; no orphaned lease survives).
    expect(await projectRowCounts(projectId)).toEqual({
      projects: 0,
      runs: 0,
      jobs: 0,
      schedules: 0,
      sessions: 0,
    });

    // Worktree dir + branch removed; session log deleted.
    expect(existsSync(wt.path)).toBe(false);
    expect(gitIn(repo, ["branch", "--list", branch]).trim()).toBe("");
    expect(existsSync(logPath)).toBe(false);

    // The repo itself is untouched: working tree, HEAD, and .beads/ byte-identical.
    expect(gitIn(repo, ["status", "--porcelain"])).toBe(statusBefore);
    expect(gitIn(repo, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(readFileSync(join(repo, ".beads", "issues.jsonl"))).toEqual(beadsBefore);
  });

  it("throws a clear not-found error for an unknown slug", async () => {
    await expect(deleteProject("never-existed")).rejects.toThrow(/not found: never-existed/i);
  });

  it("second call after a successful delete is a safe not-found no-op with no residue", async () => {
    const { projectId } = await seedProject("twice");
    await deleteProject("twice");
    await expect(deleteProject("twice")).rejects.toThrow(/not found: twice/i);
    expect((await projectRowCounts(projectId)).projects).toBe(0);
  });

  it("does not touch another project's rows or worktrees", async () => {
    const doomed = await seedProject("goner");
    const survivor = await seedProject("survivor");

    await deleteProject("goner");

    expect(existsSync(doomed.wt.path)).toBe(false);
    expect(existsSync(survivor.wt.path)).toBe(true);
    expect(await projectRowCounts(survivor.projectId)).toEqual({
      projects: 1,
      runs: 1,
      jobs: 2,
      schedules: 1,
      sessions: 1,
    });
  });
});
