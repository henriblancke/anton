/**
 * anton-pwekp: the bounded gate follow-up round is capped at ONE per job — a gate that is still
 * red after it parks exactly as a first-try red gate would, except the park now says a follow-up
 * round was attempted and carries the SECOND gate run's output (not the first). Drives the REAL
 * handler + REAL runner + REAL bd/git against a temp repo with a bare origin, a fake `claude` that
 * never fixes anything, a fake `gh` that records posted PR comments, and a project verify gate that
 * always fails but echoes which attempt it is. Skipped without bd + git.
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

describeBd(
  "review-fix parks after one gate follow-up round when the gate is still red (real handler · real bd/git · fake claude/gh)",
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
    let ghCommentLog: string;

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

      // maxAttempts: 1 — a poison park settles the job on its first attempt (poison bypasses retry
      // anyway, but this keeps the intent explicit and matches the sibling gate tests).
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
      ghCommentLog = join(sandbox, "gh-comments.log");
      writeFileSync(ghCommentLog, "");

      epicId = await beads.create(repo, {
        title: "Ship feature Y",
        type: "epic",
        description: "## Goal\nShip Y.",
      });
      branch = `anton/${epicId}`;

      g(repo, ["checkout", "-q", "-b", branch]);
      writeFileSync(join(repo, "feature.txt"), "feature version\n");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "feature work"]);
      g(repo, ["push", "-q", "-u", "origin", branch]);
      g(repo, ["checkout", "-q", "main"]);

      await beads.tag(repo, epicId, [LABELS.stage("in-review")]);
      await beads.setPrRef(repo, epicId, "gh-9");

      // Fake claude: records every call and reports success, but never fixes anything — the gate
      // command below is unconditionally red regardless of what's in the worktree.
      const fakeClaude = writeBin(
        binDir,
        "claude",
        `const fs=require('fs');
let stdin='';process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{stdin+=c;});
process.stdin.on('end',()=>{
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, 'call\\n');
  const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
  e({type:'system',subtype:'init',session_id:'s'});
  e({type:'assistant',message:{content:[{type:'text',text:'looked at it'}]}});
  e({type:'result',subtype:'success',result:'done',session_id:'s',is_error:false});
  process.exit(0);
});`,
      );

      // Fake gh: an actionable PR (changes requested), no conflicts, no inline threads. `pr comment`
      // is recorded so the test can read the park comment `notifyGateParked` posts.
      const fakeGh = writeBin(
        binDir,
        "gh",
        `const fs=require('fs');
const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'&&a.includes('comments')){
  console.log(JSON.stringify({comments:[]}));
  process.exit(0);
}
if(a[0]==='pr'&&a[1]==='view'){
  console.log(JSON.stringify({number:9,state:'OPEN',reviewDecision:'CHANGES_REQUESTED',mergeable:'MERGEABLE',headRefName:process.env.FAKE_BRANCH,url:'https://github.com/acme/repo/pull/9',reviews:[],statusCheckRollup:[]}));
  process.exit(0);
}
if(a[0]==='pr'&&a[1]==='comment'){
  const body=a[a.indexOf('--body')+1];
  fs.appendFileSync(process.env.FAKE_GH_COMMENT_LOG, body+'\\n---\\n');
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
        "FAKE_GH_COMMENT_LOG",
      ]);
      process.env.ANTON_CLAUDE_BIN = fakeClaude;
      process.env.ANTON_GH_BIN = fakeGh;
      process.env.ANTON_WORKTREES_ROOT = join(sandbox, "worktrees");
      process.env.ANTON_SESSIONS_ROOT = join(sandbox, "sessions");
      process.env.FAKE_BRANCH = branch;
      process.env.FAKE_CLAUDE_LOG = claudeCallLog;
      process.env.FAKE_GH_COMMENT_LOG = ghCommentLog;

      // Always red, but distinguishable per attempt — a counter file in the worktree (never
      // committed, since a red gate never reaches the commit) that the gate itself increments.
      const gateCmd =
        `node -e "` +
        `const fs=require('fs');` +
        `const f='.anton-gate-count';` +
        `let n=1;try{n=parseInt(fs.readFileSync(f,'utf8'),10)+1}catch(e){}` +
        `fs.writeFileSync(f,String(n));` +
        `console.log('gate-output-'+n);` +
        `process.exit(1)` +
        `"`;
      tdb = makeProjectDb({ repoPath: repo, settingsJson: JSON.stringify({ testCommand: gateCmd }) });
      clock = new FakeClock(1_700_000_000_000);
      projectId = tdb.projectId;
    });

    afterAll(() => {
      tdb?.close();
      restoreEnv();
      bdRepo.cleanup();
    });

    it("parks with the SECOND gate run's output after exactly two claude dispatches", async () => {
      g(repo, ["fetch", "-q", "origin"]);
      const originTipBefore = execFileSync(
        "git",
        ["-C", repo, "rev-parse", `origin/${branch}`],
        { encoding: "utf8" },
      ).trim();

      const fixes = await runSweep();
      expect(fixes).toHaveLength(1);

      const job = await getJob(tdb.db, fixes[0]);
      expect(job?.status).not.toBe("done");
      expect(job?.lastError).toContain("gate failed after review-fix for PR #9");
      // The SECOND run's output, not the first — the follow-up round's own attempt is what's parked.
      expect(job?.lastError).toContain("gate-output-2");
      expect(job?.lastError).not.toContain("gate-output-1");

      // Exactly two claude dispatches: the main fix, then the one bounded follow-up round — never a
      // second follow-up.
      const calls = readFileSync(claudeCallLog, "utf8").trim().split("\n").filter(Boolean);
      expect(calls).toHaveLength(2);

      // Nothing pushed.
      g(repo, ["fetch", "-q", "origin"]);
      const originTipAfter = execFileSync(
        "git",
        ["-C", repo, "rev-parse", `origin/${branch}`],
        { encoding: "utf8" },
      ).trim();
      expect(originTipAfter).toBe(originTipBefore);

      // The park comment says a follow-up round was already attempted (anton-pwekp).
      const comments = readFileSync(ghCommentLog, "utf8");
      expect(comments).toContain("A follow-up fix round already ran against this gate");
    });
  },
);
