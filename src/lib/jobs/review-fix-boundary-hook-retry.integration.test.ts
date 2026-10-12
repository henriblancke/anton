/**
 * PR #338 review round 3 (chatgpt-codex-connector): a hook-rejected boundary commit must never
 * become pushable just because a LATER dispatch — a fresh process, with none of the first attempt's
 * in-memory state — finds the branch already ahead of origin and takes the "resume" fast path. The
 * first attempt's `commitFix({ bypassHooks: true })` call marks the boundary commit as unverified
 * (a git note, never pushed); every later call to `commitFix` — including one from a brand-new
 * `runFixSession` on a resumed worktree — reads that marker back and re-verifies before publishing,
 * rather than trusting a flag that only ever lived in the failed attempt's own call graph.
 *
 * Drives the REAL handler + REAL runner + REAL bd/git against a temp repo with a bare origin, a
 * REAL `pre-commit` hook that always rejects, a fake `claude` that makes one edit on the main round,
 * and a fake `gh`. Skipped without bd + git.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { describeBd, makeBdRepo, saveEnv, type BdRepo } from "@/lib/testing/integration";
import { driveJob, makeJobRunner } from "@/lib/testing/jobs";
import { beads, LABELS } from "../beads/bd";
import * as schema from "../db/schema";
import { getJob, type Clock } from "./queue";
import { makeReviewFixHandler, makeReviewFixPrHandler } from "./review-fix";
import { makeProjectDb, type TestProjectDb } from "@/lib/testing/project";

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

function g(cwd: string, args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

function revParse(repo: string, ref: string): string {
  return execFileSync("git", ["-C", repo, "rev-parse", ref], { encoding: "utf8" }).trim();
}

describeBd(
  "review-fix never publishes a hook-rejected boundary commit, even across a retry that skips claude entirely (real handler · real bd/git · fake claude/gh)",
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
    let hookRunLog: string;

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

      // maxAttempts: 1 — a hook rejection settles the job on its first attempt within THIS sweep;
      // the retry this test cares about is a whole SEPARATE sweep (a fresh dispatch), not this
      // runner's own backoff.
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
      hookRunLog = join(sandbox, "hook-runs.log");
      writeFileSync(hookRunLog, "");

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

      // A REAL pre-commit hook shared by every worktree of this repo (hooks live in the common
      // gitdir, not per-worktree) — records every invocation, then always rejects. Simulates a
      // project whose hook enforces something this test never satisfies, so the only way a commit
      // reaches the remote is if this hook was skipped.
      const hook = join(repo, ".git", "hooks", "pre-commit");
      writeFileSync(
        hook,
        ["#!/bin/sh", `echo ran >> ${JSON.stringify(hookRunLog)}`, "exit 1", ""].join("\n"),
        "utf8",
      );
      chmodSync(hook, 0o755);

      // Fake claude: makes one edit and reports success — a normal main-round fix.
      const fakeClaude = writeBin(
        binDir,
        "claude",
        `const fs=require('fs');const path=require('path');
let stdin='';process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{stdin+=c;});
process.stdin.on('end',()=>{
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, 'call\\n');
  fs.writeFileSync(path.join(process.cwd(),'feature.txt'),'addressed review feedback\\n');
  const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
  e({type:'system',subtype:'init',session_id:'s'});
  e({type:'assistant',message:{content:[{type:'text',text:'addressed the feedback'}]}});
  e({type:'result',subtype:'success',result:'done',session_id:'s',is_error:false});
  process.exit(0);
});`,
      );

      // Fake gh: an actionable PR (changes requested), no conflicts, no inline threads.
      const fakeGh = writeBin(
        binDir,
        "gh",
        `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){
  console.log(JSON.stringify({number:11,state:'OPEN',reviewDecision:'CHANGES_REQUESTED',mergeable:'MERGEABLE',headRefName:process.env.FAKE_BRANCH,url:'https://github.com/acme/repo/pull/11',reviews:[],statusCheckRollup:[]}));
  process.exit(0);
}
if(a[0]==='repo'&&a[1]==='view'){console.log('acme/repo');process.exit(0);}
if(a[0]==='api'&&a[1]==='graphql'){console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{nodes:[]}}}}}));process.exit(0);}
process.exit(0);`,
      );

      restoreEnv = saveEnv([
        "ANTON_CLAUDE_BIN",
        "ANTON_GH_BIN",
        "ANTON_WORKTREES_ROOT",
        "ANTON_SESSIONS_ROOT",
        "FAKE_BRANCH",
        "FAKE_CLAUDE_LOG",
      ]);
      process.env.ANTON_CLAUDE_BIN = fakeClaude;
      process.env.ANTON_GH_BIN = fakeGh;
      process.env.ANTON_WORKTREES_ROOT = join(sandbox, "worktrees");
      process.env.ANTON_SESSIONS_ROOT = join(sandbox, "sessions");
      process.env.FAKE_BRANCH = branch;
      process.env.FAKE_CLAUDE_LOG = claudeCallLog;

      // No testCommand — the verify gates are trivially green, so both sweeps below reach the
      // commit/push step directly and whatever happens there is entirely down to the real hook.
      tdb = makeProjectDb({ repoPath: repo });
      clock = new FakeClock(1_700_000_000_000);
      projectId = tdb.projectId;
    });

    afterAll(() => {
      tdb?.close();
      restoreEnv();
      bdRepo.cleanup();
    });

    it("keeps the rejected boundary commit off the remote through a claude round and a claude-free retry", async () => {
      g(repo, ["fetch", "-q", "origin"]);
      const originTipBefore = revParse(repo, `origin/${branch}`);

      // First sweep: dispatches claude, makes the pre-gate boundary commit (bypassed), then the
      // real hook rejects the re-verify commit `commitAndPushFix` attempts — nothing is pushed.
      const firstFixes = await runSweep();
      expect(firstFixes).toHaveLength(1);
      const firstJob = await getJob(tdb.db, firstFixes[0]);
      expect(firstJob?.status).not.toBe("done");

      const callsAfterFirst = readFileSync(claudeCallLog, "utf8").trim().split("\n").filter(Boolean);
      expect(callsAfterFirst).toHaveLength(1);

      const hookRunsAfterFirst = readFileSync(hookRunLog, "utf8").trim().split("\n").filter(Boolean);
      expect(hookRunsAfterFirst).toHaveLength(1);

      g(repo, ["fetch", "-q", "origin"]);
      expect(revParse(repo, `origin/${branch}`)).toBe(originTipBefore);

      // Second sweep: a fresh dispatch, no in-memory state from the first attempt. The branch is
      // locally ahead of origin (the still-unpushed, hook-rejected boundary commit), so the
      // "already ahead" fast path runs — never re-dispatching claude. Without the fix, this path
      // would push that commit straight through since nothing marks it as unverified once the
      // process restarts; with the fix, the marker survives on the commit itself and forces
      // another (still-rejected) re-verify attempt.
      const secondFixes = await runSweep();
      expect(secondFixes).toHaveLength(1);
      const secondJob = await getJob(tdb.db, secondFixes[0]);
      expect(secondJob?.status).not.toBe("done");

      // claude was never dispatched again — this really is the claude-free fast path.
      const callsAfterSecond = readFileSync(claudeCallLog, "utf8").trim().split("\n").filter(Boolean);
      expect(callsAfterSecond).toHaveLength(1);

      // The hook ran again — the marker forced re-verification rather than a silent no-op push.
      const hookRunsAfterSecond = readFileSync(hookRunLog, "utf8").trim().split("\n").filter(Boolean);
      expect(hookRunsAfterSecond).toHaveLength(2);

      // Above all: still nothing on the remote.
      g(repo, ["fetch", "-q", "origin"]);
      expect(revParse(repo, `origin/${branch}`)).toBe(originTipBefore);
    });
  },
);
