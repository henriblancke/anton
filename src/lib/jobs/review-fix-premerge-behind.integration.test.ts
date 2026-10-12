/**
 * anton-501ud: the verify gates compare the worktree against `origin/<base>` directly (e.g.
 * check-migration-ordering), so a MERGEABLE-but-behind branch needs the same base premerge a
 * CONFLICTING one gets — without it the gates judge a tree missing base commits and can pass
 * against files the base already superseded (#2141). `premergeBase` used to gate on
 * `pr.mergeable === "CONFLICTING"` alone, so a branch GitHub reports as cleanly mergeable but that
 * is simply behind origin/<base> (no textual conflict at all) never got the merge. This drives the
 * REAL handler + REAL runner + REAL bd/git against a temp repo with a bare origin, a fake
 * `claude`/`gh`, and a verify gate that asserts the base file is already on disk — proving the
 * merge lands BEFORE the gate runs, not just that the final state ends up right.
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
  "review-fix premerges a MERGEABLE-but-behind branch before the gate runs (real handler · real bd/git · fake claude/gh)",
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
    let mainTip: string;

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

      // The feature branch forks from main and adds its own file...
      g(repo, ["checkout", "-q", "-b", branch]);
      writeFileSync(join(repo, "feature.txt"), "feature version\n");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "feature work"]);
      g(repo, ["push", "-q", "-u", "origin", branch]);

      // ...and main independently gains a DIFFERENT file — no textual overlap at all, so GitHub
      // would report this PR cleanly MERGEABLE even though the branch is behind main.
      g(repo, ["checkout", "-q", "main"]);
      writeFileSync(join(repo, "base-only.txt"), "from main\n");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "base-only change"]);
      g(repo, ["push", "-q", "origin", "main"]);
      g(repo, ["checkout", "-q", branch]);

      branchTipBeforeFix = revParse(repo, branch);
      mainTip = revParse(repo, "main");

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
      // for a reason that has nothing to do with the base merge, exactly the #2141 shape: a PR
      // GitHub is happy to auto-merge, that is nonetheless behind origin/main.
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
      ]);
      process.env.ANTON_CLAUDE_BIN = fakeClaude;
      process.env.ANTON_GH_BIN = fakeGh;
      process.env.ANTON_WORKTREES_ROOT = join(sandbox, "worktrees");
      process.env.ANTON_SESSIONS_ROOT = join(sandbox, "sessions");
      process.env.FAKE_BRANCH = branch;

      // The verify gate itself asserts the base's file is already on disk — this fails the whole
      // job (a missing premerge) rather than merely leaving a wrong final state to notice later.
      tdb = makeProjectDb({
        repoPath: repo,
        settingsJson: JSON.stringify({ testCommand: "test -f base-only.txt" }),
      });
      clock = new FakeClock(1_700_000_000_000);
      projectId = tdb.projectId;
    });

    afterAll(() => {
      tdb?.close();
      restoreEnv();
      bdRepo.cleanup();
    });

    it("merges origin/main into the worktree before the gate runs, and pushes the merge", async () => {
      const fixes = await runSweep();
      expect(fixes).toHaveLength(1);

      // The gate (`test -f base-only.txt`) only passes if the premerge already landed main's file
      // before it ran — a job stuck at anything other than "done" means the gate saw a tree still
      // missing the base.
      const job = await getJob(tdb.db, fixes[0]);
      expect(job?.status).toBe("done");

      // The base merge is a real, pushed merge commit — two parents, the pre-fix branch tip and
      // main — not a rebase or a fast-forward.
      execFileSync("git", ["-C", repo, "fetch", "-q", "origin"], { stdio: "ignore" });
      const remoteTip = execFileSync(
        "git",
        ["-C", repo, "rev-parse", `origin/${branch}`],
        { encoding: "utf8" },
      ).trim();
      expect(remoteTip).not.toBe(branchTipBeforeFix);

      const remoteHasBaseFile = execFileSync(
        "git",
        ["-C", repo, "show", `${remoteTip}:base-only.txt`],
        { encoding: "utf8" },
      ).trim();
      expect(remoteHasBaseFile).toBe("from main");

      const mergeCommits = execFileSync(
        "git",
        ["-C", repo, "log", "--merges", "--pretty=%H", `${branchTipBeforeFix}..${remoteTip}`],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(mergeCommits).toHaveLength(1);
      const parents = execFileSync(
        "git",
        ["-C", repo, "log", "-1", "--pretty=%P", mergeCommits[0]!],
        { encoding: "utf8" },
      )
        .trim()
        .split(/\s+/);
      expect(parents).toContain(branchTipBeforeFix);
      expect(parents).toContain(mainTip);
    });
  },
);
