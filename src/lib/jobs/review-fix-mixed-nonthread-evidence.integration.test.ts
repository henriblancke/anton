/**
 * PR #338 review (chatgpt-codex-connector): a MIXED round — an unresolved inline thread AND a
 * non-thread reason (here, a failing check) both actionable at once — must not be recorded
 * "answered" on thread replies alone, and a "fixed" claim on the {@link NON_THREAD_REPORT_ID}
 * sentinel must not count when nothing was actually pushed. Both are the same fabrication rule
 * `fabricatedFix` already applies to a real thread reply, extended to the sentinel entry
 * (`allWaitingThreadsAnswered` in review-fix.ts). Mirrors
 * review-fix-nonthread-evidence.integration.test.ts's structure but with a real waiting thread
 * alongside the non-thread reason, driving the REAL handler + REAL runner + REAL bd/git against a
 * temp repo with a bare origin and a fake `claude`/`gh`.
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
import { NON_THREAD_REPORT_ID } from "./review-fix-context";
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
  "review-fix requires non-thread evidence in a mixed round too (real handler · real bd/git · fake claude/gh)",
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

      const runner = makeJobRunner({
        db: tdb.db,
        clock,
        type: "review-fix-pr",
        handler: makeReviewFixPrHandler,
        config: { leaseMs: 30_000 },
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
      ghCommentLog = join(sandbox, "gh-comments.log");
      writeFileSync(ghCommentLog, "");

      epicId = await beads.create(repo, {
        title: "Ship feature X",
        type: "epic",
        description: "## Goal\nShip X.",
      });
      branch = `anton/${epicId}`;

      g(repo, ["checkout", "-q", "-b", branch]);
      writeFileSync(join(repo, "feature.txt"), "v1\n");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "feature work"]);
      g(repo, ["push", "-q", "-u", "origin", branch]);
      g(repo, ["checkout", "-q", "main"]);

      await beads.tag(repo, epicId, [LABELS.stage("in-review")]);
      await beads.setPrRef(repo, epicId, "gh-7");

      // Fake gh: ONE unresolved inline thread (RT_1) AND a failing check — actionable via both a
      // thread and a non-thread reason at once, the exact shape the finding names.
      const fakeGh = writeBin(
        binDir,
        "gh",
        `const fs=require('fs');
const a=process.argv.slice(2);const q=a.join(' ');
if(a[0]==='pr'&&a[1]==='view'){
  console.log(JSON.stringify({number:7,state:'OPEN',reviewDecision:'REVIEW_REQUIRED',mergeable:'MERGEABLE',headRefName:process.env.FAKE_BRANCH,url:'https://github.com/acme/repo/pull/7',reviews:[]}));
  process.exit(0);
}
if(a[0]==='pr'&&a[1]==='comment'){
  const body=a[a.indexOf('--body')+1];
  fs.appendFileSync(process.env.FAKE_GH_COMMENT_LOG, body+'\\n---\\n');
  process.exit(0);
}
if(a[0]==='repo'&&a[1]==='view'){console.log('acme/repo');process.exit(0);}
if(a[0]==='api'&&a[1]==='graphql'){
  if(q.includes('resolveReviewThread')){console.log('{}');process.exit(0);}
  if(q.includes('statusCheckRollup')){
    console.log(JSON.stringify({data:{repository:{pullRequest:{commits:{nodes:[{commit:{statusCheckRollup:{contexts:{
      pageInfo:{hasNextPage:false,endCursor:null},
      nodes:[{__typename:'CheckRun',name:'build',status:'COMPLETED',conclusion:'FAILURE'}],
    }}}}]}}}}}));
    process.exit(0);
  }
  console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{nodes:[
    {id:'RT_1',isResolved:false,isOutdated:false,path:'feature.txt',line:1,
     comments:{nodes:[{databaseId:100,author:{login:'alice'},body:'please fix this too'}]}}
  ]}}}}}));
  process.exit(0);
}
if(a.some(x=>String(x).includes('/replies'))){console.log('{}');process.exit(0);}
process.exit(0);`,
      );

      restoreEnv = saveEnv([
        "ANTON_CLAUDE_BIN",
        "ANTON_GH_BIN",
        "ANTON_WORKTREES_ROOT",
        "ANTON_SESSIONS_ROOT",
        "FAKE_BRANCH",
        "FAKE_GH_COMMENT_LOG",
      ]);
      process.env.ANTON_GH_BIN = fakeGh;
      process.env.ANTON_WORKTREES_ROOT = join(sandbox, "worktrees");
      process.env.ANTON_SESSIONS_ROOT = join(sandbox, "sessions");
      process.env.FAKE_BRANCH = branch;
      process.env.FAKE_GH_COMMENT_LOG = ghCommentLog;

      tdb = makeProjectDb({ repoPath: repo });
      clock = new FakeClock(1_700_000_000_000);
      projectId = tdb.projectId;
    });

    afterAll(() => {
      tdb?.close();
      restoreEnv();
      bdRepo.cleanup();
    });

    it("does NOT record the round answered when claude replies to the thread but never acknowledges the failing check", async () => {
      const threadOnlyClaude = writeBin(
        binDir,
        "claude-thread-only",
        `const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
const report=JSON.stringify({threads:[{id:'RT_1',outcome:'left',reply:'not touching this one'}]});
e({type:'result',subtype:'success',result:'replied to the thread\\n\\n\`\`\`json\\n'+report+'\\n\`\`\`',is_error:false});
process.exit(0);`,
      );
      const prev = process.env.ANTON_CLAUDE_BIN;
      process.env.ANTON_CLAUDE_BIN = threadOnlyClaude;
      try {
        const fixes = await runSweep();
        expect(fixes).toHaveLength(1);
        const job = await getJob(tdb.db, fixes[0]);
        expect(job?.status).toBe("done");
        const payload = JSON.parse(job!.payloadJson);
        // The thread was answered, but the failing check never got the sentinel — the round as a
        // whole must NOT be recorded answered, or the next sweep would suppress a still-red check.
        expect(payload.answeredFingerprint).toBeUndefined();
      } finally {
        process.env.ANTON_CLAUDE_BIN = prev;
      }
    });

    it("does NOT record the round answered when the sentinel claims 'fixed' but nothing was pushed", async () => {
      const fabricatingClaude = writeBin(
        binDir,
        "claude-fabricating",
        `const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
const report=JSON.stringify({threads:[
  {id:'RT_1',outcome:'left',reply:'not touching this one'},
  {id:${JSON.stringify(NON_THREAD_REPORT_ID)},outcome:'fixed',reply:'fixed the build'}
]});
e({type:'result',subtype:'success',result:'fixed it\\n\\n\`\`\`json\\n'+report+'\\n\`\`\`',is_error:false});
process.exit(0);`,
      );
      const prev = process.env.ANTON_CLAUDE_BIN;
      process.env.ANTON_CLAUDE_BIN = fabricatingClaude;
      try {
        const fixes = await runSweep();
        expect(fixes).toHaveLength(1);
        const job = await getJob(tdb.db, fixes[0]);
        expect(job?.status).toBe("done");
        const payload = JSON.parse(job!.payloadJson);
        // "fixed" with nothing pushed is a fabricated claim — same rule `fabricatedFix` already
        // applies to a real thread reply, extended to the sentinel.
        expect(payload.answeredFingerprint).toBeUndefined();
      } finally {
        process.env.ANTON_CLAUDE_BIN = prev;
      }
    });

    it("DOES record the round answered when claude answers both the thread and the sentinel honestly", async () => {
      const honestClaude = writeBin(
        binDir,
        "claude-honest",
        `const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
const report=JSON.stringify({threads:[
  {id:'RT_1',outcome:'left',reply:'not touching this one'},
  {id:${JSON.stringify(NON_THREAD_REPORT_ID)},outcome:'left',reply:'build failure is flaky infra, nothing to change'}
]});
e({type:'result',subtype:'success',result:'looked at both\\n\\n\`\`\`json\\n'+report+'\\n\`\`\`',is_error:false});
process.exit(0);`,
      );
      const prev = process.env.ANTON_CLAUDE_BIN;
      process.env.ANTON_CLAUDE_BIN = honestClaude;
      try {
        const fixes = await runSweep();
        expect(fixes).toHaveLength(1);
        const job = await getJob(tdb.db, fixes[0]);
        expect(job?.status).toBe("done");
        const payload = JSON.parse(job!.payloadJson);
        expect(payload.answeredFingerprint).toBeDefined();
        // The sentinel's own explanation must reach the PR itself, not just get treated as
        // answered internally (PR #338 review, @chatgpt-codex-connector) — `refreshFixRoundsBody`
        // never runs for an unpushed round.
        const comments = readFileSync(ghCommentLog, "utf8");
        expect(comments).toContain("build failure is flaky infra, nothing to change");
      } finally {
        process.env.ANTON_CLAUDE_BIN = prev;
      }
    });
  },
);
