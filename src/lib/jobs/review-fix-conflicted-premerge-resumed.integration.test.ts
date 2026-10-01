/**
 * PR #338 review (@chatgpt-codex-connector, P1): a conflicted `premergeBase` merge left mid-way
 * through — `MERGE_HEAD` set, conflict markers on disk — when the claude session dispatched to
 * resolve it crashes before `commitFix` can conclude the merge. On the next dispatch (a fresh
 * process, no in-memory state), the reused worktree is still dirty with that exact same unresolved
 * merge. `premergeBase`'s dirty-checkout guard must resume it (hand the still-unmerged paths back
 * to the caller so a session gets another chance) rather than treating it as generic operator dirt
 * and reporting `failed: true` forever — which would leave every later sweep taking the same
 * "refs unsynced, skip this round" branch without ever exposing the conflict to claude again.
 *
 * Drives the REAL handler + REAL runner + REAL bd/git against a temp repo with a bare origin, a
 * fake `claude` that crashes without resolving anything on its first call and resolves the conflict
 * on its second, and a fake `gh`. Skipped without bd + git.
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
  "review-fix resumes a conflicted premerge a crashed session left mid-way instead of looping on it forever (real handler · real bd/git · fake claude/gh)",
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
        title: "Ship feature W",
        type: "epic",
        description: "## Goal\nShip W.",
      });
      branch = `anton/${epicId}`;

      // main gets a shared file BEFORE the feature branch forks off it, so both sides can later
      // edit the SAME line and produce a real textual conflict rather than a clean auto-merge.
      writeFileSync(join(repo, "shared.txt"), "original\n");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "add shared file"]);
      g(repo, ["push", "-q", "origin", "main"]);

      g(repo, ["checkout", "-q", "-b", branch]);
      writeFileSync(join(repo, "shared.txt"), "feature version\n");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "feature work"]);
      g(repo, ["push", "-q", "-u", "origin", branch]);
      g(repo, ["checkout", "-q", "main"]);

      // Base advances with a CONFLICTING edit to the same line — premergeBase's merge below leaves
      // MERGE_HEAD set and conflict markers on disk instead of a clean auto-merge commit.
      writeFileSync(join(repo, "shared.txt"), "base version\n");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "conflicting base work"]);
      g(repo, ["push", "-q", "origin", "main"]);

      await beads.tag(repo, epicId, [LABELS.stage("in-review")]);
      await beads.setPrRef(repo, epicId, "gh-13");

      // Fake claude: crashes mid-session (no result event, non-zero exit) on its first invocation —
      // the merge is left conflicted, exactly as if the process errored/exited before resolving
      // anything. Resolves the conflict with a real edit on its second invocation.
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
  fs.writeFileSync(path.join(process.cwd(),'shared.txt'),'resolved version\\n');
  e({type:'assistant',message:{content:[{type:'text',text:'resolved the conflict'}]}});
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
  console.log(JSON.stringify({number:13,state:'OPEN',reviewDecision:'CHANGES_REQUESTED',mergeable:'CONFLICTING',baseRefName:'main',headRefName:process.env.FAKE_BRANCH,url:'https://github.com/acme/repo/pull/13',reviews:[],statusCheckRollup:[]}));
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
      // only thing standing between the branch and a push is whether the conflict ever gets
      // exposed to a session again.
      tdb = makeProjectDb({ repoPath: repo });
      clock = new FakeClock(1_700_000_000_000);
      projectId = tdb.projectId;
    });

    afterAll(() => {
      tdb?.close();
      restoreEnv();
      bdRepo.cleanup();
    });

    it("re-dispatches claude against the still-conflicted merge instead of parking as unsynced forever", async () => {
      g(repo, ["fetch", "-q", "origin"]);
      const originTipBefore = revParse(repo, `origin/${branch}`);

      // First sweep: prepareFixWorktree's premergeBase merges origin/main, conflicts on shared.txt
      // (MERGE_HEAD set, markers on disk), and claude crashes before resolving or committing
      // anything.
      const firstFixes = await runSweep();
      expect(firstFixes).toHaveLength(1);
      const firstJob = await getJob(tdb.db, firstFixes[0]);
      expect(firstJob?.status).not.toBe("done");

      const callsAfterFirst = readFileSync(claudeCallLog, "utf8").trim().split("\n").filter(Boolean);
      expect(callsAfterFirst).toHaveLength(1);

      g(repo, ["fetch", "-q", "origin"]);
      expect(revParse(repo, `origin/${branch}`)).toBe(originTipBefore);

      // Second sweep: a fresh dispatch, no in-memory state from the first attempt. The worktree is
      // still mid-merge with shared.txt unresolved. The fix under test must recognize that as a
      // resumable premerge (not generic operator dirt) and dispatch claude again with the conflict,
      // rather than reporting `failed: true` and skipping the round as unsynced.
      const secondFixes = await runSweep();
      expect(secondFixes).toHaveLength(1);
      const secondJob = await getJob(tdb.db, secondFixes[0]);
      expect(secondJob?.status).toBe("done");

      // claude WAS dispatched again — proving the dirty-checkout guard did not just keep rejecting
      // this attempt as unsynced.
      const callsAfterSecond = readFileSync(claudeCallLog, "utf8").trim().split("\n").filter(Boolean);
      expect(callsAfterSecond).toHaveLength(2);

      // The merge actually concluded and pushed with the resolved content, not just the base tip.
      g(repo, ["fetch", "-q", "origin"]);
      const pushedTip = revParse(repo, `origin/${branch}`);
      expect(pushedTip).not.toBe(originTipBefore);
      const pushedSharedFile = execFileSync(
        "git",
        ["-C", repo, "show", `${pushedTip}:shared.txt`],
        { encoding: "utf8" },
      );
      expect(pushedSharedFile).toBe("resolved version\n");
      // The pushed tip is a real merge of both sides — base's own tip must be an ancestor of it.
      const baseTip = revParse(repo, "origin/main");
      expect(
        execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", baseTip, pushedTip])
          .toString(),
      ).toBe("");
    });
  },
);
