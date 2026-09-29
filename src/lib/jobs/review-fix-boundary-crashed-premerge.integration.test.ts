/**
 * PR #338 review (chatgpt-codex-connector, P1): keep a failed premerge out of the resume fast
 * path. `prepareFixWorktree`'s `premergeBase` can land a clean, hook-bypassed auto-merge of the
 * base branch and mark it as an unverified boundary — then the main claude invocation itself
 * errors or the process exits before claude ever runs on top of it. On the next dispatch (a fresh
 * process, no in-memory state), the branch is already ahead of origin purely because of that
 * leftover merge commit. Without distinguishing it from a genuine operator/prior-fix commit,
 * `runFixSession`'s "already ahead" shortcut would skip claude entirely, re-verify and push the
 * base-only merge, and notify reviewers as though their feedback was addressed — when nothing
 * ever addressed it.
 *
 * Drives the REAL handler + REAL runner + REAL bd/git against a temp repo with a bare origin, a
 * fake `claude` that crashes mid-session on its first call and succeeds on its second, and a fake
 * `gh`. Skipped without bd + git.
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
  "review-fix does not push a crashed premerge's bare boundary commit through the resume fast path (real handler · real bd/git · fake claude/gh)",
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
    let claudeCounterFile: string;

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
      claudeCounterFile = join(sandbox, "claude-call-count");
      writeFileSync(claudeCounterFile, "0");

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

      // The base advances BEFORE the very first dispatch — no textual overlap with feature.txt, so
      // `prepareFixWorktree`'s premerge auto-merges cleanly on the first sweep, before claude ever
      // runs.
      writeFileSync(join(repo, "base-change.txt"), "base moved on\n");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "unrelated base work"]);
      g(repo, ["push", "-q", "origin", "main"]);

      await beads.tag(repo, epicId, [LABELS.stage("in-review")]);
      await beads.setPrRef(repo, epicId, "gh-11");

      // Fake claude: crashes mid-session (no result event, non-zero exit) on its first invocation —
      // simulating the process erroring/exiting after the premerge already landed. Succeeds with a
      // real edit on its second invocation.
      const fakeClaude = writeBin(
        binDir,
        "claude",
        `const fs=require('fs');const path=require('path');
let stdin='';process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{stdin+=c;});
process.stdin.on('end',()=>{
  fs.appendFileSync(${JSON.stringify(claudeCallLog)}, 'call\\n');
  let n=0;try{n=parseInt(fs.readFileSync(${JSON.stringify(claudeCounterFile)},'utf8'),10)||0;}catch(e){}
  n+=1;fs.writeFileSync(${JSON.stringify(claudeCounterFile)}, String(n));
  const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
  e({type:'system',subtype:'init',session_id:'s'+n});
  if (n===1) {
    process.stderr.write('API Error: Connection closed mid-response\\n');
    process.exit(1);
  }
  fs.writeFileSync(path.join(process.cwd(),'feature.txt'),'addressed review feedback\\n');
  e({type:'assistant',message:{content:[{type:'text',text:'addressed the feedback'}]}});
  e({type:'result',subtype:'success',result:'done',session_id:'s'+n,is_error:false});
  process.exit(0);
});`,
      );

      // Fake gh: an actionable PR (changes requested) against main, no inline threads.
      const fakeGh = writeBin(
        binDir,
        "gh",
        `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){
  console.log(JSON.stringify({number:11,state:'OPEN',reviewDecision:'CHANGES_REQUESTED',mergeable:'MERGEABLE',baseRefName:'main',headRefName:process.env.FAKE_BRANCH,url:'https://github.com/acme/repo/pull/11',reviews:[],statusCheckRollup:[]}));
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

      // No testCommand — the verify gates are trivially green once claude actually runs, so the
      // only thing standing between the branch and a push is whether claude got dispatched at all.
      tdb = makeProjectDb({ repoPath: repo });
      clock = new FakeClock(1_700_000_000_000);
      projectId = tdb.projectId;
    });

    afterAll(() => {
      tdb?.close();
      restoreEnv();
      bdRepo.cleanup();
    });

    it("re-dispatches claude on retry instead of pushing the crashed premerge's bare merge commit", async () => {
      g(repo, ["fetch", "-q", "origin"]);
      const originTipBefore = revParse(repo, `origin/${branch}`);

      // First sweep: `prepareFixWorktree` premerges the already-advanced base cleanly (marking the
      // merge commit as an unverified boundary), then claude crashes before it can do anything —
      // nothing is committed on top, nothing is pushed.
      const firstFixes = await runSweep();
      expect(firstFixes).toHaveLength(1);
      const firstJob = await getJob(tdb.db, firstFixes[0]);
      expect(firstJob?.status).not.toBe("done");

      const callsAfterFirst = readFileSync(claudeCallLog, "utf8").trim().split("\n").filter(Boolean);
      expect(callsAfterFirst).toHaveLength(1);

      g(repo, ["fetch", "-q", "origin"]);
      expect(revParse(repo, `origin/${branch}`)).toBe(originTipBefore);

      // Second sweep: a fresh dispatch, no in-memory state from the first attempt. The branch is
      // locally ahead of origin purely because of the crashed premerge's bare merge commit. The
      // fix under test must recognize that shape and dispatch claude again rather than taking the
      // "already ahead" shortcut straight to a push.
      const secondFixes = await runSweep();
      expect(secondFixes).toHaveLength(1);
      const secondJob = await getJob(tdb.db, secondFixes[0]);
      expect(secondJob?.status).toBe("done");

      // claude WAS dispatched again — proving the fast path did not fire over the bare boundary.
      const callsAfterSecond = readFileSync(claudeCallLog, "utf8").trim().split("\n").filter(Boolean);
      expect(callsAfterSecond).toHaveLength(2);

      // This time the push actually carries claude's real fix, not just the base merge.
      g(repo, ["fetch", "-q", "origin"]);
      const pushedTip = revParse(repo, `origin/${branch}`);
      expect(pushedTip).not.toBe(originTipBefore);
      const pushedFeatureFile = execFileSync(
        "git",
        ["-C", repo, "show", `${pushedTip}:feature.txt`],
        { encoding: "utf8" },
      );
      expect(pushedFeatureFile).toBe("addressed review feedback\n");
    });
  },
);
