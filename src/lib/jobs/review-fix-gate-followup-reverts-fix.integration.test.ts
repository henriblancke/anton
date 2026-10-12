/**
 * PR #338 review (chatgpt-codex-connector, P1): a "fixed" thread claim from the main round must be
 * validated against the FINAL post-follow-up tree, not merely the intermediate main-round commit.
 * Drives the REAL handler + REAL runner + REAL bd/git against a temp repo with a bare origin, a fake
 * `claude` whose gate-fix follow-up round reverts the main round's own edit while still making the
 * project's verify gate pass, and a fake `gh` carrying one inline review thread. Skipped without
 * bd + git.
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
  "review-fix must not credit a 'fixed' thread claim the gate follow-up reverted (real handler · real bd/git · fake claude/gh)",
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
    let ghLogPath: string;

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
      ghLogPath = join(sandbox, "gh.log");
      writeFileSync(ghLogPath, "");

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

      // The thread report the main round claims: RT_1 is fixed by editing feature.txt.
      const report = '{"threads":[{"id":"RT_1","outcome":"fixed","reply":"renamed foo to bar"}]}';

      // Fake claude: the MAIN round edits feature.txt and reports RT_1 as fixed. The FOLLOW-UP
      // round (recognized by the gate-failure section in its prompt) makes the gate pass, but
      // REVERTS feature.txt back to what it was before the main round ever ran — simulating a
      // follow-up that fixes the gate at the cost of undoing the review fix.
      const fakeClaude = writeBin(
        binDir,
        "claude",
        `const fs=require('fs');const path=require('path');
let stdin='';process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{stdin+=c;});
process.stdin.on('end',()=>{
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, 'call\\n');
  const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
  if (stdin.includes('Gate failure (one follow-up round)')) {
    fs.writeFileSync(path.join(process.cwd(),'feature.txt'),'v1\\n');
    fs.writeFileSync(path.join(process.cwd(),'.anton-gate-fixed'),'fixed\\n');
    e({type:'system',subtype:'init',session_id:'s'});
    e({type:'assistant',message:{content:[{type:'text',text:'fixed the gate'}]}});
    e({type:'result',subtype:'success',result:'fixed the gate',session_id:'s',is_error:false});
  } else {
    fs.writeFileSync(path.join(process.cwd(),'feature.txt'),'addressed review feedback\\n');
    e({type:'system',subtype:'init',session_id:'s'});
    e({type:'assistant',message:{content:[{type:'text',text:'resolved feedback'}]}});
    e({type:'result',subtype:'success',result:'done\\n\\n\`\`\`json\\n${report}\\n\`\`\`',session_id:'s',is_error:false});
  }
  process.exit(0);
});`,
      );

      // Fake gh: an actionable PR (changes requested) with one inline review thread, no CI failure —
      // the gate failure this test exercises is the project's OWN local verify gate, checked below.
      const fakeGh = writeBin(
        binDir,
        "gh",
        `const fs=require('fs');const a=process.argv.slice(2);const q=a.join(' ');
const log=m=>{if(process.env.FAKE_GH_LOG)fs.appendFileSync(process.env.FAKE_GH_LOG,m+'\\n');};
if(a[0]==='pr'&&a[1]==='view'){
  console.log(JSON.stringify({number:7,state:'OPEN',reviewDecision:'CHANGES_REQUESTED',mergeable:'MERGEABLE',headRefName:process.env.FAKE_BRANCH,url:'https://github.com/acme/repo/pull/7',
    reviews:[{author:{login:'alice'},state:'CHANGES_REQUESTED',body:'rename foo to bar'}],
    statusCheckRollup:[]}));
  process.exit(0);
}
if(a[0]==='repo'&&a[1]==='view'){console.log('acme/repo');process.exit(0);}
if(a[0]==='api'&&a[1]==='graphql'){
  if(q.includes('resolveReviewThread')){log('resolve');console.log('{}');process.exit(0);}
  console.log(JSON.stringify({data:{repository:{pullRequest:{reviewThreads:{
    pageInfo:{hasNextPage:false,endCursor:null},
    nodes:[
    {id:'RT_1',isResolved:false,isOutdated:false,path:'feature.txt',line:1,
     comments:{totalCount:1,nodes:[{databaseId:100,author:{login:'alice'},body:'rename foo to bar here too'}]}}
  ]}}}}}));
  process.exit(0);
}
if(a.some(x=>String(x).includes('/replies'))){log('reply');console.log('{}');process.exit(0);}
if(a[0]==='pr'&&a[1]==='comment'){log('comment');process.exit(0);}
if(a[0]==='api'&&a.includes('--method')){log('rerequest');process.exit(0);}
process.exit(0);`,
      );

      restoreEnv = saveEnv([
        "ANTON_CLAUDE_BIN",
        "ANTON_GH_BIN",
        "ANTON_WORKTREES_ROOT",
        "ANTON_SESSIONS_ROOT",
        "FAKE_BRANCH",
        "FAKE_CLAUDE_LOG",
        "FAKE_GH_LOG",
      ]);
      process.env.ANTON_CLAUDE_BIN = fakeClaude;
      process.env.ANTON_GH_BIN = fakeGh;
      process.env.ANTON_WORKTREES_ROOT = join(sandbox, "worktrees");
      process.env.ANTON_SESSIONS_ROOT = join(sandbox, "sessions");
      process.env.FAKE_BRANCH = branch;
      process.env.FAKE_CLAUDE_LOG = claudeCallLog;
      process.env.FAKE_GH_LOG = ghLogPath;

      // Red until the follow-up round's marker file exists.
      tdb = makeProjectDb({
        repoPath: repo,
        settingsJson: JSON.stringify({ testCommand: "test -f .anton-gate-fixed" }),
      });
      clock = new FakeClock(1_700_000_000_000);
      projectId = tdb.projectId;
    });

    afterAll(() => {
      tdb?.close();
      restoreEnv();
      bdRepo.cleanup();
    });

    it("never resolves the thread the follow-up reverted, even though the gate went green", async () => {
      const fixes = await runSweep();
      expect(fixes).toHaveLength(1);

      const job = await getJob(tdb.db, fixes[0]);
      expect(job?.status).toBe("done");

      // Exactly two claude dispatches: the main fix, then the one bounded follow-up round.
      const calls = readFileSync(claudeCallLog, "utf8").trim().split("\n").filter(Boolean);
      expect(calls).toHaveLength(2);

      // The gate went green and the follow-up's marker reached origin — but the main round's own
      // edit did NOT survive: the follow-up reverted feature.txt back to what it was before either
      // round ran.
      g(repo, ["fetch", "-q", "origin"]);
      const remoteFiles = execFileSync(
        "git",
        ["-C", repo, "ls-tree", "-r", "--name-only", `origin/${branch}`],
        { encoding: "utf8" },
      );
      expect(remoteFiles).toContain(".anton-gate-fixed");
      const remoteFeature = execFileSync(
        "git",
        ["-C", repo, "show", `origin/${branch}:feature.txt`],
        { encoding: "utf8" },
      );
      expect(remoteFeature).toBe("v1\n");

      // Because the claimed fix never survived to the pushed tree, the thread must NOT be treated
      // as answered: no reply, no resolve. A regression back to validating against the intermediate
      // main-round commit would post both.
      const ghLog = readFileSync(ghLogPath, "utf8");
      expect(ghLog).not.toContain("resolve");
      expect(ghLog).not.toContain("reply");

      // The round record must not count a fix that was never actually delivered.
      const rounds = await tdb.db.select().from(schema.reviewRounds);
      expect(rounds).toHaveLength(1);
      expect(rounds[0]).toMatchObject({
        prNumber: 7,
        outcomesFixed: 0,
        outcomesLeft: 0,
        outcomesNeedsHuman: 0,
      });
    });
  },
);
