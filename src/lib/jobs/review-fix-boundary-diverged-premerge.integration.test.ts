/**
 * PR #338 review (chatgpt-codex-connector, P1): reconcile a leftover bare premerge before syncing.
 * `prepareFixWorktree`'s `premergeBase` can land a clean, hook-bypassed auto-merge of the base
 * branch and mark it as an unverified boundary — then the main claude invocation crashes before
 * anything lands on top of it (the scenario `review-fix-boundary-crashed-premerge.integration.test.ts`
 * covers). If the PR's head ALSO advances on GitHub before the next sweep (an operator's own push,
 * here), that bare commit and the new remote tip diverge: neither is an ancestor of the other, since
 * the bare commit's own content merged in the OLD tip plus the base, not whatever landed on the new
 * tip. Without reconciling that divergence, the ff-only sync fails on EVERY sweep against the exact
 * same stuck local state (swallowed by `safe`, so `headMatches`/`refsSynced` never become true),
 * permanently skipping the fix session instead of ever reaching the new head.
 *
 * Drives the REAL handler + REAL runner + REAL bd/git against a temp repo with a bare origin, a
 * fake `claude` that crashes mid-session on its first call and succeeds on its second, and a fake
 * `gh` whose reported head SHA the test moves like a real push would. Skipped without bd + git.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  "review-fix reconciles a leftover bare premerge against a remotely-advanced PR head (real handler · real bd/git · fake claude/gh)",
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

      // Fake gh: an actionable PR (changes requested) against main, no inline threads — its reported
      // head SHA comes from FAKE_HEAD_SHA, so the test can move it like a real push would once the
      // operator's own commit lands on origin.
      const fakeGh = writeBin(
        binDir,
        "gh",
        `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){
  console.log(JSON.stringify({number:11,state:'OPEN',reviewDecision:'CHANGES_REQUESTED',mergeable:'MERGEABLE',baseRefName:'main',headRefName:process.env.FAKE_BRANCH,headRefOid:process.env.FAKE_HEAD_SHA,url:'https://github.com/acme/repo/pull/11',reviews:[],statusCheckRollup:[]}));
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
        "FAKE_HEAD_SHA",
      ]);
      process.env.ANTON_CLAUDE_BIN = fakeClaude;
      process.env.ANTON_GH_BIN = fakeGh;
      process.env.ANTON_WORKTREES_ROOT = join(sandbox, "worktrees");
      process.env.ANTON_SESSIONS_ROOT = join(sandbox, "sessions");
      process.env.FAKE_BRANCH = branch;
      process.env.FAKE_HEAD_SHA = revParse(repo, branch);

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

    it("re-syncs onto the new remote head instead of getting stuck behind a diverged bare boundary", async () => {
      g(repo, ["fetch", "-q", "origin"]);
      const originTipBeforeOperatorPush = revParse(repo, `origin/${branch}`);

      // First sweep: `prepareFixWorktree` premerges the already-advanced base cleanly (marking the
      // merge commit as an unverified boundary), then claude crashes before it can do anything —
      // nothing is committed on top, nothing is pushed. The review-fix checkout's own local branch
      // ref now sits on that bare merge commit.
      const firstFixes = await runSweep();
      expect(firstFixes).toHaveLength(1);
      const firstJob = await getJob(tdb.db, firstFixes[0]);
      expect(firstJob?.status).not.toBe("done");
      expect(readFileSync(claudeCallLog, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(1);

      g(repo, ["fetch", "-q", "origin"]);
      expect(revParse(repo, `origin/${branch}`)).toBe(originTipBeforeOperatorPush);

      // An operator pushes directly to the PR branch on GitHub, from a completely independent
      // clone — never touching the review-fix checkout's own local branch ref (still sitting on the
      // crashed premerge's bare boundary commit). This is what makes the two diverge: the operator's
      // new commit is NOT built on top of the bare merge, and the bare merge is NOT built on top of
      // the operator's commit either.
      const operatorClone = mkdtempSync(join(tmpdir(), "anton-operator-"));
      g(operatorClone, ["clone", "-q", bdRepo.bare!, "."]);
      // A fresh clone carries no repo-local git identity (git config is per-repo, not inherited
      // from the clone source) — a CI runner with no global user.name/email would otherwise fail
      // the commit below with "Please tell me who you are", unlike a dev machine that usually has
      // one set globally.
      g(operatorClone, ["config", "user.email", "operator@example.com"]);
      g(operatorClone, ["config", "user.name", "anton-operator"]);
      g(operatorClone, ["checkout", "-q", branch]);
      writeFileSync(join(operatorClone, "operator-change.txt"), "operator pushed directly\n");
      g(operatorClone, ["add", "-A"]);
      g(operatorClone, ["commit", "-q", "-m", "operator change"]);
      g(operatorClone, ["push", "-q", "origin", branch]);
      const operatorHeadSha = revParse(operatorClone, "HEAD");
      process.env.FAKE_HEAD_SHA = operatorHeadSha;

      g(repo, ["fetch", "-q", "origin"]);
      expect(revParse(repo, `origin/${branch}`)).toBe(operatorHeadSha);
      // The bare local boundary and the new remote tip have, in fact, diverged — neither is an
      // ancestor of the other — proving this test actually exercises the reconciliation path rather
      // than a plain fast-forward.
      expect(() =>
        execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", `origin/${branch}`, branch], {
          stdio: "ignore",
        }),
      ).toThrow();

      // Second sweep: a fresh dispatch, no in-memory state from the first attempt. Without
      // reconciling the diverged bare boundary, the ff-only sync fails every time and the round is
      // skipped forever (`refsSynced` never becomes true) — claude is never dispatched again and the
      // remote head never advances past the operator's own commit.
      const secondFixes = await runSweep();
      expect(secondFixes).toHaveLength(1);
      const secondJob = await getJob(tdb.db, secondFixes[0]);
      expect(secondJob?.status).toBe("done");

      // claude WAS dispatched again — proving the sync actually reconciled and reached the new head.
      expect(readFileSync(claudeCallLog, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(2);

      // The pushed tip carries the operator's own commit, the base content, AND claude's real fix —
      // not just a stale re-push of the crashed premerge's bare merge.
      g(repo, ["fetch", "-q", "origin"]);
      const pushedTip = revParse(repo, `origin/${branch}`);
      expect(pushedTip).not.toBe(operatorHeadSha);
      execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", operatorHeadSha, pushedTip]);
      const pushedFeatureFile = execFileSync(
        "git",
        ["-C", repo, "show", `${pushedTip}:feature.txt`],
        { encoding: "utf8" },
      );
      expect(pushedFeatureFile).toBe("addressed review feedback\n");
      const pushedOperatorFile = execFileSync(
        "git",
        ["-C", repo, "show", `${pushedTip}:operator-change.txt`],
        { encoding: "utf8" },
      );
      expect(pushedOperatorFile).toBe("operator pushed directly\n");
    });
  },
);
