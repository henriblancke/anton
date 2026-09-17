/**
 * anton-vtex7: the resolved base merge must land BEFORE the verify gates run, so a red gate parks
 * a merged branch instead of leaving the resolution to be discarded. Drives the REAL handler + REAL
 * runner + REAL bd/git against a temp repo with a bare origin — a genuinely conflicting PR, a fake
 * `claude` that resolves the conflict, a fake `gh`, and a project verify gate that always fails.
 * Skipped without bd + git.
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
  "review-fix commits a resolved base merge before the verify gates (real handler · real bd/git · fake claude/gh)",
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
    let branchTipBeforeFix: string;
    let originTipBeforeFix: string;

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

      epicId = await beads.create(repo, {
        title: "Ship feature X",
        type: "epic",
        description: "## Goal\nShip X.",
      });
      branch = `anton/${epicId}`;

      // The feature branch changes a line...
      g(repo, ["checkout", "-q", "-b", branch]);
      writeFileSync(join(repo, "feature.txt"), "feature version\n");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "feature work"]);
      g(repo, ["push", "-q", "-u", "origin", branch]);

      // ...and main changes the SAME line differently, so premergeBase's merge of origin/main
      // genuinely conflicts and leaves markers for claude to resolve.
      g(repo, ["checkout", "-q", "main"]);
      writeFileSync(join(repo, "feature.txt"), "main version\n");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "main change"]);
      g(repo, ["push", "-q", "origin", "main"]);
      g(repo, ["checkout", "-q", branch]);

      branchTipBeforeFix = revParse(repo, branch);
      originTipBeforeFix = revParse(repo, `origin/${branch}`);

      await beads.tag(repo, epicId, [LABELS.stage("in-review")]);
      await beads.setPrRef(repo, epicId, "gh-7");

      // Fake claude: resolve the conflict marker unconditionally, and report success. It never
      // commits or pushes itself — that is anton's job, which is exactly what this test is proving
      // the ordering of.
      const fakeClaude = writeBin(
        binDir,
        "claude",
        `const fs=require('fs');const path=require('path');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
let stdin='';process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{stdin+=c;});
process.stdin.on('end',()=>{
  fs.writeFileSync(path.join(process.cwd(),'feature.txt'),'resolved\\n');
  e({type:'system',subtype:'init',session_id:'s'});
  e({type:'assistant',message:{content:[{type:'text',text:'resolved the conflict'}]}});
  e({type:'result',subtype:'success',result:'done',session_id:'s',is_error:false});
  process.exit(0);
});`,
      );

      // Fake gh: pr view reports CONFLICTING against `main` — the shape that makes
      // `prepareFixWorktree` run `premergeBase`.
      const fakeGh = writeBin(
        binDir,
        "gh",
        `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){
  console.log(JSON.stringify({number:7,state:'OPEN',reviewDecision:null,mergeable:'CONFLICTING',headRefName:process.env.FAKE_BRANCH,url:'https://github.com/acme/repo/pull/7',reviews:[],statusCheckRollup:[]}));
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
      ]);
      process.env.ANTON_CLAUDE_BIN = fakeClaude;
      process.env.ANTON_GH_BIN = fakeGh;
      process.env.ANTON_WORKTREES_ROOT = join(sandbox, "worktrees");
      process.env.ANTON_SESSIONS_ROOT = join(sandbox, "sessions");
      process.env.FAKE_BRANCH = branch;

      // A verify gate that always fails — the fix session's claude edits still land, but the run
      // must never reach `commitAndPushFix`'s push.
      tdb = makeProjectDb({ repoPath: repo, settingsJson: JSON.stringify({ testCommand: "exit 1" }) });
      clock = new FakeClock(1_700_000_000_000);
      projectId = tdb.projectId;
    });

    afterAll(() => {
      tdb?.close();
      restoreEnv();
      bdRepo.cleanup();
    });

    it("commits the resolved merge before the failing gate, and never pushes it", async () => {
      const fixes = await runSweep();
      expect(fixes).toHaveLength(1);

      // The gate failure propagates: the job did not settle "done".
      const job = await getJob(tdb.db, fixes[0]);
      expect(job?.status).not.toBe("done");
      expect(job?.lastError).toContain("gate failed after review-fix for PR #7");

      // Exactly ONE new commit object was created by the run: the resolved base merge. `main`'s own
      // tip already existed (pushed in setup, not created by this fix), so the right delta is
      // commits reachable from the branch that are reachable from neither its own pre-fix tip nor
      // `main` — a plain rev-list count would also (wrongly) count main's pre-existing commit.
      const mergeCommit = revParse(repo, branch);
      expect(mergeCommit).not.toBe(branchTipBeforeFix);
      const newCommits = execFileSync(
        "git",
        ["-C", repo, "rev-list", branch, `^${branchTipBeforeFix}`, "^main"],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(newCommits).toEqual([mergeCommit]);
      // It really is a merge commit: two parents, the pre-fix branch tip and main.
      const parents = execFileSync(
        "git",
        ["-C", repo, "log", "-1", "--pretty=%P", mergeCommit],
        { encoding: "utf8" },
      ).trim().split(/\s+/);
      expect(parents).toContain(branchTipBeforeFix);
      expect(parents).toContain(revParse(repo, "main"));

      // Nothing was pushed: origin/<branch> is exactly where it was before the fix ran.
      execFileSync("git", ["-C", repo, "fetch", "-q", "origin"], { stdio: "ignore" });
      expect(revParse(repo, `origin/${branch}`)).toBe(originTipBeforeFix);
    });
  },
);
