/**
 * anton-091jr review round 2 (chatgpt-codex-connector): a MERGEABLE-but-behind base commit can
 * change dependency metadata (lockfile, package.json) without `node_modules` reflecting it, because
 * warming ran BEFORE the base premerge landed. Left unaddressed, the verify gate below can fail
 * solely because the install matches the pre-merge tree, costing an unnecessary follow-up round.
 * This drives the REAL handler + REAL runner + REAL bd/git against a temp repo with a bare origin,
 * a fake `claude`/`gh`, and a `warmCommand` that logs whether the base's file is on disk each time
 * it runs — proving warming repeats AFTER the merge, not just that the final state ends up right.
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
  "review-fix re-warms after a clean MERGEABLE-but-behind base premerge (real handler · real bd/git · fake claude/gh)",
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
    let warmLog: string;

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
      warmLog = join(sandbox, "warm.log");
      writeFileSync(warmLog, "");

      epicId = await beads.create(repo, {
        title: "Ship feature X",
        type: "epic",
        description: "## Goal\nShip X.",
      });
      branch = `anton/${epicId}`;

      // The feature branch forks from main and adds its own file...
      g(repo, ["checkout", "-q", "-b", branch]);
      writeFileSync(join(repo, "feature.txt"), "feature version\n");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "feature work"]);
      g(repo, ["push", "-q", "-u", "origin", branch]);

      // ...and main independently gains a DIFFERENT file — no textual overlap, so GitHub reports
      // this PR cleanly MERGEABLE even though the branch is behind main. `base-only.txt`'s presence
      // is what the warm command below uses to tell "before the premerge" from "after" it.
      g(repo, ["checkout", "-q", "main"]);
      writeFileSync(join(repo, "base-only.txt"), "from main\n");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "base-only change"]);
      g(repo, ["push", "-q", "origin", "main"]);
      g(repo, ["checkout", "-q", branch]);

      await beads.tag(repo, epicId, [LABELS.stage("in-review")]);
      await beads.setPrRef(repo, epicId, "gh-7");

      // Fake claude: address the requested change with a trivial edit and report done.
      const fakeClaude = writeBin(
        binDir,
        "claude",
        `const fs=require('fs');const path=require('path');
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
let stdin='';process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{stdin+=c;});
process.stdin.on('end',()=>{
  fs.writeFileSync(path.join(process.cwd(),'feature.txt'),'feature version, addressed\\n');
  e({type:'system',subtype:'init',session_id:'s'});
  e({type:'assistant',message:{content:[{type:'text',text:'addressed the review feedback'}]}});
  e({type:'result',subtype:'success',result:'done',session_id:'s',is_error:false});
  process.exit(0);
});`,
      );

      // Fake gh: pr view reports MERGEABLE (no conflict at all) with changes requested — actionable
      // for a reason that has nothing to do with the base merge, the same #2141 shape.
      const fakeGh = writeBin(
        binDir,
        "gh",
        `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){
  console.log(JSON.stringify({number:7,state:'OPEN',reviewDecision:'CHANGES_REQUESTED',mergeable:'MERGEABLE',headRefName:process.env.FAKE_BRANCH,url:'https://github.com/acme/repo/pull/7',reviews:[{author:{login:'alice'},state:'CHANGES_REQUESTED',body:'please fix'}],statusCheckRollup:[]}));
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
        "WARM_LOG",
      ]);
      process.env.ANTON_CLAUDE_BIN = fakeClaude;
      process.env.ANTON_GH_BIN = fakeGh;
      process.env.ANTON_WORKTREES_ROOT = join(sandbox, "worktrees");
      process.env.ANTON_SESSIONS_ROOT = join(sandbox, "sessions");
      process.env.FAKE_BRANCH = branch;
      process.env.WARM_LOG = warmLog;

      // The warm command itself is the probe: it appends one line per invocation recording whether
      // the base's file is already on disk at that moment. A single pre-merge warm (today's bug)
      // logs exactly one "no-base" line; a re-warm after the clean premerge adds a "has-base" line
      // too. The gate stays trivially green so the job's final status isn't what's under test here.
      tdb = makeProjectDb({
        repoPath: repo,
        settingsJson: JSON.stringify({
          warmCommand:
            'if [ -f base-only.txt ]; then echo has-base >> "$WARM_LOG"; else echo no-base >> "$WARM_LOG"; fi',
          testCommand: "true",
        }),
      });
      clock = new FakeClock(1_700_000_000_000);
      projectId = tdb.projectId;
    });

    afterAll(() => {
      tdb?.close();
      restoreEnv();
      bdRepo.cleanup();
    });

    it("repeats the warm command after the base merge lands, once the merged tree is on disk", async () => {
      const fixes = await runSweep();
      expect(fixes).toHaveLength(1);

      const job = await getJob(tdb.db, fixes[0]);
      expect(job?.status).toBe("done");

      const lines = readFileSync(warmLog, "utf8").trim().split("\n").filter(Boolean);
      // First warm runs before the premerge (base-only.txt not yet on disk); the second — the fix
      // under test — runs after the clean auto-merge landed it.
      expect(lines).toEqual(["no-base", "has-base"]);
    });
  },
);
