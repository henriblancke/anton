/**
 * anton-2wklm: a resume whose branch already carries committed work pushes it without paying for a
 * claude session — the operator fixed what a red gate named (a migration re-stamp, say) and hit
 * resume rather than re-running the whole review-fix session. Drives the REAL handler + REAL runner
 * + REAL bd/git against a temp repo with a bare origin, fake `claude`/`gh`, across three PRs: ahead
 * of origin with a green gate (push, no claude), ahead with a red gate (park, nothing pushed, no
 * claude), and nothing ahead (dispatches claude as before). Skipped without bd + git.
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
  "review-fix resumes an already-ahead branch without dispatching claude (real handler · real bd/git · fake claude/gh)",
  () => {
    let bdRepo: BdRepo;
    let sandbox: string;
    let repo: string;
    let binDir: string;
    let tdb: TestProjectDb;
    let clock: FakeClock;
    let projectId: string;
    let restoreEnv: () => void;
    let claudeCallLog: string;
    let prEditLog: string;

    const runDispatch = (epicBeadId: string) =>
      driveJob({
        db: tdb.db,
        clock,
        type: "review-fix",
        handler: makeReviewFixHandler,
        projectId,
        payload: { projectId, epicBeadId },
        config: { leaseMs: 30_000 },
      });

    /** One dispatcher pass targeted at a single epic, then every per-PR job it fanned out, settled. */
    async function runSweep(epicBeadId: string): Promise<string[]> {
      await runDispatch(epicBeadId);
      const queued = await tdb.db
        .select({ id: schema.jobs.id })
        .from(schema.jobs)
        .where(and(eq(schema.jobs.type, "review-fix-pr"), eq(schema.jobs.status, "queued")));
      if (queued.length === 0) return [];
      // maxAttempts: 1 — a gate failure parks the job immediately instead of requeuing it behind a
      // retry backoff, so a failed test's job never leaks into the next test's unscoped queued-job
      // read below.
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

    /** An in-review epic with its branch pushed to origin, then `commitsAhead` unpushed commits. */
    async function makeEpicAheadBy(
      title: string,
      prNumber: number,
      commitsAhead: number,
    ): Promise<{ epicId: string; branch: string }> {
      const epicId = await beads.create(repo, {
        title,
        type: "epic",
        description: `## Goal\n${title}.`,
      });
      const branch = `anton/${epicId}`;
      g(repo, ["checkout", "-q", "-b", branch]);
      writeFileSync(join(repo, `${epicId}.txt`), "v1\n");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "feature work"]);
      g(repo, ["push", "-q", "-u", "origin", branch]);
      for (let i = 0; i < commitsAhead; i++) {
        writeFileSync(join(repo, `${epicId}.txt`), `operator fix ${i}\n`);
        g(repo, ["add", "-A"]);
        g(repo, ["commit", "-q", "-m", `operator fix ${i}`]);
      }
      g(repo, ["checkout", "-q", "main"]);
      await beads.tag(repo, epicId, [LABELS.stage("in-review")]);
      await beads.setPrRef(repo, epicId, `gh-${prNumber}`);
      return { epicId, branch };
    }

    async function setSettings(json: Record<string, unknown>): Promise<void> {
      await tdb.db
        .update(schema.projects)
        .set({ settingsJson: JSON.stringify(json) })
        .where(eq(schema.projects.id, projectId));
    }

    beforeAll(async () => {
      bdRepo = makeBdRepo({ bare: true, initialCommit: true });
      sandbox = bdRepo.dir;
      repo = bdRepo.repo;
      binDir = join(sandbox, "bin");
      mkdirSync(binDir);
      claudeCallLog = join(sandbox, "claude-calls.log");
      writeFileSync(claudeCallLog, "");
      prEditLog = join(sandbox, "pr-edit.log");
      writeFileSync(prEditLog, "");

      // Fake claude: records that it ran (so a test can assert it was never dispatched), then
      // behaves like a normal fix — edits a file and reports success — for the leg that does
      // dispatch it.
      const fakeClaude = writeBin(
        binDir,
        "claude",
        `const fs=require('fs');const path=require('path');
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, process.cwd()+'\\n');
fs.writeFileSync(path.join(process.cwd(),'FIX.md'),'fixed '+Date.now());
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
let stdin='';process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{stdin+=c;});
process.stdin.on('end',()=>{
  e({type:'system',subtype:'init',session_id:'s'});
  e({type:'assistant',message:{content:[{type:'text',text:'resolved feedback'}]}});
  e({type:'result',subtype:'success',result:'done',session_id:'s',is_error:false});
  process.exit(0);
});`,
      );

      // Fake gh: every PR in this suite is OPEN + CHANGES_REQUESTED (actionable) with no inline
      // threads. headRefName resolves per PR number via FAKE_BRANCHES so one script serves all
      // three epics. `pr view --json body` and `pr edit --body` are handled separately so a test
      // can observe `refreshFixRoundsBody`'s read-modify-write against the PR body (PR #321 review).
      const fakeGh = writeBin(
        binDir,
        "gh",
        `const fs=require('fs');
const a=process.argv.slice(2);
const branches=JSON.parse(process.env.FAKE_BRANCHES||'{}');
if(a[0]==='pr'&&a[1]==='view'&&a.includes('--json')&&a[a.indexOf('--json')+1]==='body'){
  console.log(JSON.stringify({body:''}));
  process.exit(0);
}
if(a[0]==='pr'&&a[1]==='view'){
  const n=Number(a[2]);
  console.log(JSON.stringify({number:n,state:'OPEN',reviewDecision:'CHANGES_REQUESTED',mergeable:'MERGEABLE',headRefName:branches[n],url:'https://github.com/acme/repo/pull/'+n,
    reviews:[{author:{login:'alice'},state:'CHANGES_REQUESTED',body:'please fix'}],statusCheckRollup:[]}));
  process.exit(0);
}
if(a[0]==='pr'&&a[1]==='edit'){
  const body=a[a.indexOf('--body')+1];
  fs.appendFileSync(process.env.FAKE_PR_EDIT_LOG, JSON.stringify({pr:a[2],body})+'\\n');
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
        "FAKE_CLAUDE_LOG",
        "FAKE_BRANCHES",
        "FAKE_PR_EDIT_LOG",
      ]);
      process.env.ANTON_CLAUDE_BIN = fakeClaude;
      process.env.ANTON_GH_BIN = fakeGh;
      process.env.ANTON_WORKTREES_ROOT = join(sandbox, "worktrees");
      process.env.ANTON_SESSIONS_ROOT = join(sandbox, "sessions");
      process.env.FAKE_CLAUDE_LOG = claudeCallLog;
      process.env.FAKE_BRANCHES = "{}";
      process.env.FAKE_PR_EDIT_LOG = prEditLog;

      tdb = makeProjectDb({ repoPath: repo });
      clock = new FakeClock(1_700_000_000_000);
      projectId = tdb.projectId;
    });

    afterAll(() => {
      tdb?.close();
      restoreEnv();
      bdRepo.cleanup();
    });

    /** Merge one more PR-number → branch mapping into the shared fake `gh`'s env-var table. */
    function registerBranch(prNumber: number, branch: string): void {
      const existing = JSON.parse(process.env.FAKE_BRANCHES || "{}") as Record<number, string>;
      process.env.FAKE_BRANCHES = JSON.stringify({ ...existing, [prNumber]: branch });
    }

    it("pushes an already-ahead branch through a green gate without dispatching claude", async () => {
      const gateLog = join(sandbox, "gate-green.log");
      const { epicId, branch } = await makeEpicAheadBy("Ahead + green gate", 101, 1);
      registerBranch(101, branch);
      await setSettings({ testCommand: `echo ran >> ${gateLog}` });
      const branchTip = revParse(repo, branch);

      const fixes = await runSweep(epicId);
      expect(fixes).toHaveLength(1);
      expect((await getJob(tdb.db, fixes[0]))?.status).toBe("done");

      // The gate is the safety property, not the dispatch: it still genuinely ran.
      expect(readFileSync(gateLog, "utf8")).toContain("ran");

      // claude was never dispatched for this fix.
      expect(readFileSync(claudeCallLog, "utf8").trim()).toBe("");

      // The operator's already-committed work reached origin, unchanged (no new commit was made).
      g(repo, ["fetch", "-q", "origin"]);
      expect(revParse(repo, `origin/${branch}`)).toBe(branchTip);

      // The fast path never dispatches claude, so it has no thread report to draw from — it must
      // still refresh the PR body's review-fix-rounds region from `verdict.reasons` directly
      // (PR #321 review), not skip the body update just because this round took the shortcut.
      const edits = readFileSync(prEditLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { pr: string; body: string });
      expect(edits).toHaveLength(1);
      expect(edits[0]?.pr).toBe("101");
      expect(edits[0]?.body).toContain("### Review-fix rounds");
    });

    it("parks a red gate on an already-ahead branch and pushes nothing", async () => {
      const { epicId, branch } = await makeEpicAheadBy("Ahead + red gate", 102, 1);
      registerBranch(102, branch);
      await setSettings({ testCommand: "exit 1" });

      g(repo, ["fetch", "-q", "origin"]);
      const originTipBefore = revParse(repo, `origin/${branch}`);

      const fixes = await runSweep(epicId);
      expect(fixes).toHaveLength(1);
      const job = await getJob(tdb.db, fixes[0]);
      expect(job?.status).not.toBe("done");
      expect(job?.lastError).toContain("gate failed after review-fix for PR #102");

      // Nothing pushed — the gate failure parks it exactly as it would after a claude run.
      g(repo, ["fetch", "-q", "origin"]);
      expect(revParse(repo, `origin/${branch}`)).toBe(originTipBefore);

      // claude was never dispatched.
      expect(readFileSync(claudeCallLog, "utf8").trim()).toBe("");
    });

    it("dispatches claude normally when nothing is committed ahead of the remote", async () => {
      const { epicId, branch } = await makeEpicAheadBy("Nothing ahead", 103, 0);
      registerBranch(103, branch);
      await setSettings({});

      const fixes = await runSweep(epicId);
      expect(fixes).toHaveLength(1);
      expect((await getJob(tdb.db, fixes[0]))?.status).toBe("done");

      // claude WAS dispatched exactly once — the normal path, unchanged by the fast path above.
      const calls = readFileSync(claudeCallLog, "utf8").trim().split("\n").filter(Boolean);
      expect(calls).toHaveLength(1);

      g(repo, ["fetch", "-q", "origin"]);
      const remoteLog = execFileSync("git", ["-C", repo, "log", "--oneline", `origin/${branch}`], {
        encoding: "utf8",
      });
      expect(remoteLog).toContain("address review feedback");
    });
  },
);
