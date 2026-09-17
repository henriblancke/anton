/**
 * anton-gdth4: `alreadyAhead` only says the branch carries prior commits — it says nothing about
 * `prepareFixWorktree`'s own unconditional premerge, which can hand back a FRESH, unresolved
 * conflict (literal markers + MERGE_HEAD) alongside it. Only claude can resolve those markers, so
 * the "ahead, skip claude" fast path must fall through to the normal dispatch path whenever a fresh
 * conflict is present — never commit-and-gate literal conflict text. Drives the REAL handler + REAL
 * runner + REAL bd/git against a temp repo with a bare origin: an epic branch that is BOTH already
 * ahead of origin (an unpushed, unrelated commit) AND genuinely conflicting with main, a fake
 * `claude` that resolves the conflict, and a fake `gh` reporting `mergeable:'CONFLICTING'`. Skipped
 * without bd + git.
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
  "review-fix dispatches claude for an already-ahead branch with a fresh base conflict (real handler · real bd/git · fake claude/gh)",
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
    let claudeCallLog: string;
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
      claudeCallLog = join(sandbox, "claude-calls.log");
      writeFileSync(claudeCallLog, "");

      epicId = await beads.create(repo, {
        title: "Ship feature X",
        type: "epic",
        description: "## Goal\nShip X.",
      });
      branch = `anton/${epicId}`;

      // The feature branch changes a line and is pushed to origin...
      g(repo, ["checkout", "-q", "-b", branch]);
      writeFileSync(join(repo, "feature.txt"), "feature version\n");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "feature work"]);
      g(repo, ["push", "-q", "-u", "origin", branch]);

      // ...then a DIFFERENT, unrelated commit lands on top, unpushed — this is what makes the
      // branch `alreadyAhead` of origin, same as an operator resolving a prior red gate.
      writeFileSync(join(repo, "extra.txt"), "operator fix\n");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "operator fix"]);

      // ...and main changes the SAME line feature.txt started with, differently, so premergeBase's
      // merge of origin/main still genuinely conflicts — a FRESH conflict the "already ahead"
      // shortcut has never seen or resolved.
      g(repo, ["checkout", "-q", "main"]);
      writeFileSync(join(repo, "feature.txt"), "main version\n");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "main change"]);
      g(repo, ["push", "-q", "origin", "main"]);
      g(repo, ["checkout", "-q", branch]);

      branchTipBeforeFix = revParse(repo, branch);
      originTipBeforeFix = revParse(repo, `origin/${branch}`);

      await beads.tag(repo, epicId, [LABELS.stage("in-review")]);
      await beads.setPrRef(repo, epicId, "gh-9");

      // Fake claude: resolve the conflict marker unconditionally, report success, and record that
      // it ran — the "already ahead" fast path must NOT be able to skip this dispatch.
      const fakeClaude = writeBin(
        binDir,
        "claude",
        `const fs=require('fs');const path=require('path');
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, process.cwd()+'\\n');
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
  console.log(JSON.stringify({number:9,state:'OPEN',reviewDecision:'CHANGES_REQUESTED',mergeable:'CONFLICTING',headRefName:process.env.FAKE_BRANCH,url:'https://github.com/acme/repo/pull/9',reviews:[{author:{login:'alice'},state:'CHANGES_REQUESTED',body:'please fix'}],statusCheckRollup:[]}));
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
        "FAKE_BRANCH",
      ]);
      process.env.ANTON_CLAUDE_BIN = fakeClaude;
      process.env.ANTON_GH_BIN = fakeGh;
      process.env.ANTON_WORKTREES_ROOT = join(sandbox, "worktrees");
      process.env.ANTON_SESSIONS_ROOT = join(sandbox, "sessions");
      process.env.FAKE_CLAUDE_LOG = claudeCallLog;
      process.env.FAKE_BRANCH = branch;

      // No verify gate configured — a passing (no-op) gate, so the resolved merge is expected to
      // reach origin.
      tdb = makeProjectDb({ repoPath: repo });
      clock = new FakeClock(1_700_000_000_000);
      projectId = tdb.projectId;
    });

    afterAll(() => {
      tdb?.close();
      restoreEnv();
      bdRepo.cleanup();
    });

    it("dispatches claude to resolve the fresh conflict instead of gating literal markers", async () => {
      const fixes = await runSweep();
      expect(fixes).toHaveLength(1);
      expect((await getJob(tdb.db, fixes[0]))?.status).toBe("done");

      // claude WAS dispatched — the "already ahead" shortcut did not swallow a fresh conflict.
      const calls = readFileSync(claudeCallLog, "utf8").trim().split("\n").filter(Boolean);
      expect(calls).toHaveLength(1);

      // The merge landed as a real merge commit (pre-fix branch tip + main), not literal conflict
      // markers pushed as-is.
      g(repo, ["fetch", "-q", "origin"]);
      const remoteTip = revParse(repo, `origin/${branch}`);
      expect(remoteTip).not.toBe(originTipBeforeFix);
      expect(remoteTip).not.toBe(branchTipBeforeFix);

      const remoteLog = execFileSync("git", ["-C", repo, "log", "--oneline", `origin/${branch}`], {
        encoding: "utf8",
      });
      expect(remoteLog).toContain("address review feedback");

      const resolvedContent = execFileSync(
        "git",
        ["-C", repo, "show", `origin/${branch}:feature.txt`],
        { encoding: "utf8" },
      );
      expect(resolvedContent).toBe("resolved\n");
      expect(resolvedContent).not.toContain("<<<<<<<");
    });
  },
);
