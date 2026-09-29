/**
 * PR #338 review round 4 (chatgpt-codex-connector), two findings about the boundary-commit note
 * `commitFix` writes to mark a hook-bypassed commit unverified (see `UNVERIFIED_BOUNDARY_NOTES_REF`
 * in review-fix.ts):
 *
 * - P1: if writing the note fails AFTER the boundary commit itself landed (e.g. concurrent
 *   note-ref lock contention), the commit must not be left on HEAD unmarked — a later "already
 *   ahead" fast path would be unable to tell it apart from a genuinely re-verified commit and could
 *   push it straight past the project's hooks.
 * - P2: once a boundary commit IS successfully re-verified, its marker must be cleared explicitly
 *   rather than relying on the re-verify commit landing under a new sha — `commitAll`'s amend path
 *   can reproduce the exact same tree/parents/message/author, which (within git's one-second
 *   timestamp resolution) reproduces the identical sha too, leaving a note attached to a commit
 *   that has since been pushed as verified.
 *
 * Drives the REAL handler + REAL runner + REAL bd/git against a temp repo with a bare origin, a
 * fake `claude`, and a fake `gh`. Skipped without bd + git.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { describeBd, makeBdRepo, saveEnv, type BdRepo } from "@/lib/testing/integration";
import { driveJob, makeJobRunner } from "@/lib/testing/jobs";
import { beads, LABELS } from "../beads/bd";
import * as schema from "../db/schema";
import { getJob, type Clock } from "./queue";
import { makeReviewFixHandler, makeReviewFixPrHandler } from "./review-fix";
import { worktreePathFor } from "../git/worktree";
import { makeProjectDb, type TestProjectDb } from "@/lib/testing/project";

const NOTES_REF = "refs/notes/anton-review-fix-boundary";

class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
}

function writeBin(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}`);
  chmodSync(p, 0o755);
  return p;
}

function g(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function noteExistsOnHead(worktreePath: string): boolean {
  try {
    g(worktreePath, ["notes", `--ref=${NOTES_REF}`, "show", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

const fakeGh = (branch: string, binDir: string): string =>
  writeBin(
    binDir,
    "gh",
    `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){
  console.log(JSON.stringify({number:11,state:'OPEN',reviewDecision:'CHANGES_REQUESTED',mergeable:'MERGEABLE',headRefName:${JSON.stringify(branch)},url:'https://github.com/acme/repo/pull/11',reviews:[],statusCheckRollup:[]}));
  process.exit(0);
}
if(a[0]==='repo'&&a[1]==='view'){console.log('acme/repo');process.exit(0);}
if(a[0]==='api'&&a[1]==='graphql'){console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{nodes:[]}}}}}));process.exit(0);}
process.exit(0);`,
  );

const fakeClaude = (binDir: string, logPath: string, edit: string): string =>
  writeBin(
    binDir,
    "claude",
    `const fs=require('fs');const path=require('path');
let stdin='';process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{stdin+=c;});
process.stdin.on('end',()=>{
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, 'call\\n');
  fs.writeFileSync(path.join(process.cwd(),'feature.txt'),${JSON.stringify(edit)}+'\\n');
  const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
  e({type:'system',subtype:'init',session_id:'s'});
  e({type:'assistant',message:{content:[{type:'text',text:'addressed the feedback'}]}});
  e({type:'result',subtype:'success',result:'done',session_id:'s',is_error:false});
  process.exit(0);
});`,
  );

describeBd(
  "review-fix rolls back an unmarked boundary commit when writing its unverified-note fails (real handler · real bd/git · fake claude/gh)",
  () => {
    let bdRepo: BdRepo;
    let sandbox: string;
    let repo: string;
    let binDir: string;
    let tdb: TestProjectDb;
    let clock: FakeClock;
    let projectId: string;
    let epicId: string;
    let branch: string;
    let restoreEnv: () => void;
    let claudeCallLog: string;
    let notesLockPath: string;

    const runDispatch = () =>
      driveJob({
        db: tdb.db,
        clock,
        type: "review-fix",
        handler: makeReviewFixHandler,
        projectId,
        config: { leaseMs: 30_000 },
      });

    async function runSweep(): Promise<string[]> {
      await runDispatch();
      const queued = await tdb.db
        .select({ id: schema.jobs.id })
        .from(schema.jobs)
        .where(and(eq(schema.jobs.type, "review-fix-pr"), eq(schema.jobs.status, "queued")));
      if (queued.length === 0) return [];
      const runner = makeJobRunner({
        db: tdb.db,
        clock,
        type: "review-fix-pr",
        handler: makeReviewFixPrHandler,
        config: { leaseMs: 30_000, maxAttempts: 1 },
      });
      while ((await runner.tickOnce()) > 0) await runner.whenIdle();
      return queued.map((q) => q.id);
    }

    beforeAll(async () => {
      bdRepo = makeBdRepo({ bare: true, initialCommit: true });
      sandbox = bdRepo.dir;
      repo = bdRepo.repo;
      binDir = join(sandbox, "bin");
      mkdirSync(binDir);
      claudeCallLog = join(sandbox, "claude-calls.log");
      writeFileSync(claudeCallLog, "");

      epicId = await beads.create(repo, {
        title: "Ship feature Z",
        type: "epic",
        description: "## Goal\nShip Z.",
      });
      branch = `anton/${epicId}`;

      g(repo, ["checkout", "-q", "-b", branch]);
      writeFileSync(join(repo, "feature.txt"), "feature version\n");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "feature work"]);
      g(repo, ["push", "-q", "-u", "origin", branch]);
      g(repo, ["checkout", "-q", "main"]);

      await beads.tag(repo, epicId, [LABELS.stage("in-review")]);
      await beads.setPrRef(repo, epicId, "gh-11");

      restoreEnv = saveEnv([
        "ANTON_CLAUDE_BIN",
        "ANTON_GH_BIN",
        "ANTON_WORKTREES_ROOT",
        "ANTON_SESSIONS_ROOT",
        "FAKE_BRANCH",
        "FAKE_CLAUDE_LOG",
      ]);
      process.env.ANTON_CLAUDE_BIN = fakeClaude(binDir, claudeCallLog, "addressed review feedback");
      process.env.ANTON_GH_BIN = fakeGh(branch, binDir);
      process.env.ANTON_WORKTREES_ROOT = join(sandbox, "worktrees");
      process.env.ANTON_SESSIONS_ROOT = join(sandbox, "sessions");
      process.env.FAKE_BRANCH = branch;
      process.env.FAKE_CLAUDE_LOG = claudeCallLog;

      // Notes are stored in the repo's COMMON gitdir, shared by every worktree of `repo` — this
      // lock can be planted before any worktree even exists, and still blocks `git notes add` run
      // from inside one.
      notesLockPath = join(repo, ".git", "refs", "notes", "anton-review-fix-boundary.lock");
      mkdirSync(join(repo, ".git", "refs", "notes"), { recursive: true });

      tdb = makeProjectDb({ repoPath: repo });
      clock = new FakeClock(1_700_000_000_000);
      projectId = tdb.projectId;
    });

    afterAll(() => {
      tdb?.close();
      restoreEnv();
      bdRepo.cleanup();
    });

    it("rolls HEAD back instead of publishing an unmarked bypass commit, then recovers cleanly once the lock clears", async () => {
      g(repo, ["fetch", "-q", "origin"]);
      const originTipBefore = g(repo, ["rev-parse", `origin/${branch}`]);
      const preexistingTip = g(repo, ["rev-parse", branch]);

      // Simulate concurrent note-ref lock contention for the FIRST attempt's `markUnverifiedBoundary`
      // call: git's own ref update fails immediately with this lockfile already present.
      writeFileSync(notesLockPath, "");

      const firstFixes = await runSweep();
      expect(firstFixes).toHaveLength(1);
      const firstJob = await getJob(tdb.db, firstFixes[0]);
      expect(firstJob?.status).not.toBe("done");

      const callsAfterFirst = execFileSync("wc", ["-l", claudeCallLog], { encoding: "utf8" });
      expect(callsAfterFirst.trim().startsWith("1")).toBe(true);

      // Nothing published.
      g(repo, ["fetch", "-q", "origin"]);
      expect(g(repo, ["rev-parse", `origin/${branch}`])).toBe(originTipBefore);

      // The rollback landed in the job's own worktree: HEAD must be back at the commit that existed
      // before the boundary commit was attempted — not sitting on an unmarked bypass commit — and
      // that commit must carry no note (the write never succeeded).
      const worktreePath = worktreePathFor(repo, branch);
      expect(g(worktreePath, ["rev-parse", "HEAD"])).toBe(preexistingTip);
      expect(noteExistsOnHead(worktreePath)).toBe(false);

      // Clear the contention and let a fresh sweep retry from scratch.
      execFileSync("rm", ["-f", notesLockPath]);

      const secondFixes = await runSweep();
      expect(secondFixes).toHaveLength(1);
      const secondJob = await getJob(tdb.db, secondFixes[0]);
      expect(secondJob?.status).toBe("done");

      // claude ran again — the whole review-fix attempt failed and started over, not just the note
      // write.
      const callsAfterSecond = execFileSync("wc", ["-l", claudeCallLog], { encoding: "utf8" });
      expect(callsAfterSecond.trim().startsWith("2")).toBe(true);

      g(repo, ["fetch", "-q", "origin"]);
      expect(g(repo, ["rev-parse", `origin/${branch}`])).not.toBe(originTipBefore);
    });
  },
);

describeBd(
  "review-fix clears a boundary commit's unverified note once it is actually re-verified, even when the re-verify commit lands under the IDENTICAL sha (real handler · real bd/git · fake claude/gh)",
  () => {
    let bdRepo: BdRepo;
    let sandbox: string;
    let repo: string;
    let binDir: string;
    let tdb: TestProjectDb;
    let clock: FakeClock;
    let projectId: string;
    let epicId: string;
    let branch: string;
    let restoreEnv: () => void;
    let claudeCallLog: string;

    const runDispatch = () =>
      driveJob({
        db: tdb.db,
        clock,
        type: "review-fix",
        handler: makeReviewFixHandler,
        projectId,
        config: { leaseMs: 30_000 },
      });

    async function runSweep(): Promise<string[]> {
      await runDispatch();
      const queued = await tdb.db
        .select({ id: schema.jobs.id })
        .from(schema.jobs)
        .where(and(eq(schema.jobs.type, "review-fix-pr"), eq(schema.jobs.status, "queued")));
      if (queued.length === 0) return [];
      const runner = makeJobRunner({
        db: tdb.db,
        clock,
        type: "review-fix-pr",
        handler: makeReviewFixPrHandler,
        config: { leaseMs: 30_000, maxAttempts: 1 },
      });
      while ((await runner.tickOnce()) > 0) await runner.whenIdle();
      return queued.map((q) => q.id);
    }

    beforeAll(async () => {
      bdRepo = makeBdRepo({ bare: true, initialCommit: true });
      sandbox = bdRepo.dir;
      repo = bdRepo.repo;
      binDir = join(sandbox, "bin");
      mkdirSync(binDir);
      claudeCallLog = join(sandbox, "claude-calls.log");
      writeFileSync(claudeCallLog, "");

      epicId = await beads.create(repo, {
        title: "Ship feature Z",
        type: "epic",
        description: "## Goal\nShip Z.",
      });
      branch = `anton/${epicId}`;

      g(repo, ["checkout", "-q", "-b", branch]);
      writeFileSync(join(repo, "feature.txt"), "feature version\n");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "feature work"]);
      g(repo, ["push", "-q", "-u", "origin", branch]);
      g(repo, ["checkout", "-q", "main"]);

      await beads.tag(repo, epicId, [LABELS.stage("in-review")]);
      await beads.setPrRef(repo, epicId, "gh-11");

      restoreEnv = saveEnv([
        "ANTON_CLAUDE_BIN",
        "ANTON_GH_BIN",
        "ANTON_WORKTREES_ROOT",
        "ANTON_SESSIONS_ROOT",
        "FAKE_BRANCH",
        "FAKE_CLAUDE_LOG",
        "GIT_AUTHOR_DATE",
        "GIT_COMMITTER_DATE",
      ]);
      process.env.ANTON_CLAUDE_BIN = fakeClaude(binDir, claudeCallLog, "addressed review feedback");
      process.env.ANTON_GH_BIN = fakeGh(branch, binDir);
      process.env.ANTON_WORKTREES_ROOT = join(sandbox, "worktrees");
      process.env.ANTON_SESSIONS_ROOT = join(sandbox, "sessions");
      process.env.FAKE_BRANCH = branch;
      process.env.FAKE_CLAUDE_LOG = claudeCallLog;
      // Pin every commit this run makes to the SAME author/committer timestamp. The boundary commit
      // and its re-verify amend share the same tree, parent, message, and identity already (nothing
      // new is staged between them) — with the date pinned too they are byte-identical, so git
      // reproduces the exact same sha for both. This is exactly the scenario the fix must cover: a
      // note attached to a sha that IS the published, verified commit.
      process.env.GIT_AUTHOR_DATE = "2024-01-01T00:00:00Z";
      process.env.GIT_COMMITTER_DATE = "2024-01-01T00:00:00Z";

      tdb = makeProjectDb({ repoPath: repo });
      clock = new FakeClock(1_700_000_000_000);
      projectId = tdb.projectId;
    });

    afterAll(() => {
      tdb?.close();
      restoreEnv();
      bdRepo.cleanup();
    });

    it("leaves no note on the published tip, whether or not the amend reused the boundary's own sha", async () => {
      const fixes = await runSweep();
      expect(fixes).toHaveLength(1);
      const job = await getJob(tdb.db, fixes[0]);
      expect(job?.status).toBe("done");

      const worktreePath = worktreePathFor(repo, branch);
      expect(noteExistsOnHead(worktreePath)).toBe(false);

      g(repo, ["fetch", "-q", "origin"]);
      const remoteTip = g(repo, ["rev-parse", `origin/${branch}`]);
      expect(g(worktreePath, ["rev-parse", "HEAD"])).toBe(remoteTip);
    });
  },
);
