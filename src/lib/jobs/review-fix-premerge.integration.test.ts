/**
 * PR #263 review, round 30: the conflict-resolution premerge (`prepareFixWorktree`'s `premergeBase`)
 * brings in `origin/${baseBranch}`, a DIFFERENT ref than the sync merge above it
 * (`origin/${branch}`). Its `core.hooksPath` override must be resolved against THAT ref via
 * `resolveHooksPathOverrideForMerge`, not against the current checkout via
 * `resolveHooksPathOverride` — a conflicting PR's base can introduce or advance a tracked hooks
 * submodule the feature worktree's own checkout knows nothing about, and `git merge` never updates
 * a submodule's on-disk content on its own.
 *
 * Round 40 simplified the submodule handling in both functions to a single conservative rule: any
 * submodule involvement disables hooks rather than resolving the exact commit to trust. This test's
 * hooksPath IS a submodule gitlink in `origin/main`'s tree, so it now proves the premerge disables
 * hooks (no marker file) and still completes successfully — rather than proving a hook fires, which
 * was this test's pre-round-40 assertion.
 *
 * Drives the REAL handler + REAL runner + REAL bd/git against a temp repo with a bare origin, using
 * a fake `claude`/`gh` so the flow is deterministic. Skipped without bd + git.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  "review-fix premerge hooksPath (real handler · real bd/git · fake claude/gh)",
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
    let hooksMarker: string;

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

      // A hooks submodule, introduced on `main` (the PR's base) AFTER the feature branch forked —
      // the feature branch's own tree has never heard of it. Its `post-merge` writes a marker file;
      // round 40's simplified submodule rule disables hooks for any submodule involvement, so this
      // test asserts the marker is ABSENT — proving the override was resolved against
      // `origin/main`'s tree (which sees the gitlink and disables hooks) rather than the current
      // checkout's tree (which sees no gitlink at all and would resolve some other, hook-firing
      // value instead).
      const submoduleUpstream = join(sandbox, "hooks-submodule-upstream");
      mkdirSync(submoduleUpstream);
      g(submoduleUpstream, ["init", "-q", "-b", "main"]);
      g(submoduleUpstream, ["config", "user.email", "t@example.com"]);
      g(submoduleUpstream, ["config", "user.name", "anton-test"]);
      hooksMarker = join(sandbox, "premerge-hook-ran");
      writeFileSync(
        join(submoduleUpstream, "post-merge"),
        `#!/usr/bin/env sh\ntouch "${hooksMarker}"\n`,
      );
      chmodSync(join(submoduleUpstream, "post-merge"), 0o755);
      g(submoduleUpstream, ["add", "-A"]);
      g(submoduleUpstream, ["commit", "-q", "-m", "init"]);

      // beads: an in-review epic with a PR ref (as execute-epic would have left it).
      epicId = await beads.create(repo, {
        title: "Ship feature X",
        type: "epic",
        description: "## Goal\nShip X.",
      });
      branch = `anton/${epicId}`;

      // The feature branch forks from `main` BEFORE the base gains the hooks submodule.
      g(repo, ["checkout", "-q", "-b", branch]);
      writeFileSync(join(repo, "feature.txt"), "v1\n");
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "feature work"]);
      g(repo, ["push", "-q", "-u", "origin", branch]);

      // Base branch (`main`) now gains the hooks submodule (an unrelated file, no textual overlap
      // with the feature branch's own `feature.txt`, so the premerge's actual `git merge` succeeds
      // CLEANLY and fires `post-merge` — the fake `gh` below is what reports the PR CONFLICTING and
      // sends `prepareFixWorktree` down the `premergeBase` path in the first place; the real merge
      // underneath it doesn't need a genuine textual conflict to prove the hooksPath bug, and a
      // manually-resolved (as opposed to auto-merged) conflict wouldn't fire `post-merge` at all).
      g(repo, ["checkout", "-q", "main"]);
      execFileSync(
        "git",
        [
          "-C",
          repo,
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          "-q",
          submoduleUpstream,
          "hooks",
        ],
        { stdio: "ignore" },
      );
      g(repo, ["-C", "hooks", "checkout", "-q", "main"]);
      execFileSync(
        "git",
        ["-C", repo, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "hooks"],
        { stdio: "ignore" },
      );
      g(repo, ["config", "core.hooksPath", "hooks"]);
      g(repo, ["add", "-A"]);
      g(repo, ["commit", "-q", "-m", "add hooks submodule on main"]);
      g(repo, ["push", "-q", "origin", "main"]);

      await beads.tag(repo, epicId, [LABELS.stage("in-review")]);
      await beads.setPrRef(repo, epicId, "gh-7");

      // Fake claude: resolve the conflict marker claude is handed, commit, and report done.
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

      tdb = makeProjectDb({ repoPath: repo });
      clock = new FakeClock(1_700_000_000_000);
      projectId = tdb.projectId;
    });

    afterAll(() => {
      tdb?.close();
      restoreEnv();
      bdRepo.cleanup();
    });

    it("resolves the premerge's hooksPath against origin/<baseBranch>, disabling hooks for the base's newly-introduced submodule gitlink", async () => {
      const fixes = await runSweep();
      expect(fixes).toHaveLength(1);
      expect((await getJob(tdb.db, fixes[0]))?.status).toBe("done");

      // The base's hooks submodule — absent from the feature branch's own tree — is a `160000`
      // gitlink in `origin/main`'s tree, so round 40's simplified rule disables hooks for the
      // premerge rather than firing its `post-merge`. Resolving the override against the CURRENT
      // checkout instead (the bug this test originally guarded) would see no `core.hooksPath`-
      // tracking gitlink in the feature branch's pre-merge tree at all, and hand back a value that
      // fires the hook — the marker's absence here proves the override was resolved against
      // `origin/main` (the incoming ref), not the current checkout.
      expect(existsSync(hooksMarker)).toBe(false);

      // The conflict was resolved and pushed — proof the premerge itself succeeded, not just that
      // some override was computed.
      const remoteLog = execFileSync("git", ["-C", repo, "log", "--oneline", `origin/${branch}`], {
        encoding: "utf8",
      });
      expect(remoteLog).toContain("address review feedback");
    });
  },
);
